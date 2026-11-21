/**
 * Drizzle storage adapter — an {@link EntitlementsStorage} over a
 * **consumer-owned** Drizzle table and database. Unlike
 * {@link ./postgres.createPostgresStorage} it issues **no DDL** (the table lives
 * in your Drizzle schema + migrations) and **owns no connection** (it reuses the
 * `db` you pass, and never closes it).
 *
 * Dialect-agnostic: works with Postgres, MySQL, and SQLite Drizzle databases
 * (the dialect is read from the `db`, or set explicitly with `dialect`). Build
 * the backing table with the matching factory —
 * {@link ../drizzle/pg.pgEntitlementsTable} /
 * {@link ../drizzle/mysql.mysqlEntitlementsTable} /
 * {@link ../drizzle/sqlite.sqliteEntitlementsTable} — whose fixed `key`/`value`
 * columns this adapter reads and writes.
 *
 * - `getKeys` matches prefixes literally and case-sensitively: `LIKE … ESCAPE
 *   '!'` on Postgres/MySQL (a backslash escape is a syntax error on MySQL),
 *   `GLOB` on SQLite (whose `LIKE` folds ASCII case).
 * - `compareAndSwap` is one conditional `UPDATE` (or a conflict-ignoring
 *   `INSERT` when absence is expected): `jsonb` equality on Postgres, `JSON`
 *   equality on MySQL, canonical-JSON text equality on SQLite (values are
 *   written with sorted object keys).
 *
 * @example
 * ```ts
 * import { drizzle } from "drizzle-orm/node-postgres";
 * import { createDrizzleStorage } from "@xtandard/entitlements/storage/drizzle";
 * import { pgEntitlementsTable } from "@xtandard/entitlements/drizzle/pg";
 *
 * export const entitlementsKv = pgEntitlementsTable(); // add to your schema + migrate
 * const db = drizzle(pool);                            // your existing pool
 * const storage = createDrizzleStorage({ db, table: entitlementsKv });
 * ```
 *
 * @module
 */

import { and, entityKind, eq, sql, type Column, type SQL, type Table } from "drizzle-orm";
import type { CompareAndSwapEntitlementsStorage } from "./contract.ts";
import type { DrizzleKvTable } from "../drizzle/table.ts";
import { canonical, canonicalJson, escapeGlob, escapeLike, parseJsonValue } from "./util.ts";

export type { DrizzleKvTable } from "../drizzle/table.ts";

/** The SQL dialect of a Drizzle database. */
export type DrizzleDialect = "pg" | "mysql" | "sqlite";

/**
 * Minimal structural view of a Drizzle database — the query-builder entry points
 * the adapters use. The public option is typed `unknown` because a
 * dialect-agnostic structural type cannot match dialect-specific dbs (their
 * `.from`/`.insert` want `PgTable` etc., not the base `Table`).
 */
export interface DrizzleLikeDatabase {
  dialect?: unknown;
  select(fields: Record<string, Column>): {
    from(table: Table): { where(where: SQL): PromiseLike<unknown[]> };
  };
  insert(table: Table): DrizzleInsert;
  update(table: Table): {
    set(values: Record<string, unknown>): {
      where(where: SQL): PromiseLike<unknown> & {
        returning?(fields: Record<string, Column>): PromiseLike<unknown[]>;
      };
    };
  };
  delete(table: Table): { where(where: SQL): PromiseLike<unknown> };
  execute?(query: SQL): PromiseLike<unknown>;
  transaction?<T>(fn: (tx: DrizzleLikeDatabase) => Promise<T>): Promise<T>;
}

/** The insert builder surface (upsert methods differ by dialect). */
interface DrizzleInsert {
  ignore?(): DrizzleInsert;
  values(row: Record<string, unknown>): PromiseLike<unknown> & {
    /** Postgres + SQLite upsert. */
    onConflictDoUpdate?(config: { target: Column; set: Record<string, unknown> }): DrizzleReturning;
    onConflictDoNothing?(config?: { target?: Column }): DrizzleReturning;
    /** MySQL upsert. */
    onDuplicateKeyUpdate?(config: { set: Record<string, unknown> }): PromiseLike<unknown>;
  };
}

type DrizzleReturning = PromiseLike<unknown> & {
  returning(fields: Record<string, Column>): PromiseLike<unknown[]>;
};

const DIALECT_KINDS: Record<string, DrizzleDialect> = {
  PgDialect: "pg",
  MySqlDialect: "mysql",
  SQLiteDialect: "sqlite",
};

/**
 * Detect a Drizzle database's dialect from its `dialect` object's class chain
 * (`PgDialect` / `MySqlDialect` / `SQLite{Sync,Async}Dialect`). Internal;
 * shared with `counters/drizzle`.
 */
export function detectDrizzleDialect(db: unknown): DrizzleDialect {
  let proto: unknown = (db as DrizzleLikeDatabase | null)?.dialect;
  while (proto) {
    const ctor = (proto as { constructor?: Record<symbol, unknown> }).constructor;
    const kind = ctor?.[entityKind];
    if (typeof kind === "string" && kind in DIALECT_KINDS) return DIALECT_KINDS[kind]!;
    proto = Object.getPrototypeOf(proto);
  }
  throw new Error(
    "@xtandard/entitlements: cannot detect the Drizzle dialect of `db` — pass `dialect: " +
      '"pg" | "mysql" | "sqlite"` explicitly.',
  );
}

/** Rows affected by a MySQL write, across driver result shapes (mysql2, PlanetScale…). */
export function affectedRows(result: unknown): number {
  const header = (Array.isArray(result) ? result[0] : result) as
    | { affectedRows?: number; rowsAffected?: number }
    | undefined;
  return Number(header?.affectedRows ?? header?.rowsAffected ?? 0);
}

/** Options for {@link createDrizzleStorage}. */
export interface DrizzleStorageOptions {
  /**
   * Your Drizzle database (node-postgres / postgres-js / mysql2 / better-sqlite3 /
   * bun:sqlite / libsql / pglite / …). Typed `unknown` intentionally — a single
   * dialect-agnostic type can't match every dialect's db.
   */
  db: unknown;
  /** The KV table built with a `*EntitlementsTable` factory (or matching that shape). */
  table: DrizzleKvTable;
  /** Override dialect detection (normally read from `db`). */
  dialect?: DrizzleDialect;
}

/**
 * A compare-and-swap capable storage over a Drizzle table. For push
 * change-notifications, compose it with `withWatch` + a change source (e.g.
 * `pgListenNotify`) — `watch` is orthogonal to the adapter.
 */
export type DrizzleEntitlementsStorage = CompareAndSwapEntitlementsStorage;

/**
 * Create a Drizzle-backed {@link DrizzleEntitlementsStorage}. No DDL, no
 * connection ownership.
 */
export function createDrizzleStorage(options: DrizzleStorageOptions): DrizzleEntitlementsStorage {
  const db = options.db as DrizzleLikeDatabase;
  const { table } = options;
  const dialect = options.dialect ?? detectDrizzleDialect(db);

  /** The dialect's literal-prefix predicate on the key column. */
  const prefixWhere = (prefix: string): SQL =>
    dialect === "sqlite"
      ? sql`${table.key} glob ${`${escapeGlob(prefix)}*`}`
      : sql`${table.key} like ${`${escapeLike(prefix)}%`} escape '!'`;

  /** The dialect's structural JSON equality on the value column. */
  const valueEquals = (expected: unknown): SQL => {
    if (dialect === "pg") return sql`${table.value} = ${JSON.stringify(expected)}::jsonb`;
    if (dialect === "mysql") return sql`${table.value} = cast(${JSON.stringify(expected)} as json)`;
    return sql`${table.value} = ${canonicalJson(expected)}`;
  };

  return {
    async getItem<T>(key: string): Promise<T | null> {
      const rows = (await db
        .select({ value: table.value })
        .from(table)
        .where(eq(table.key, key))) as Array<{ value: unknown }>;
      const row = rows[0];
      if (row === undefined || row.value === null || row.value === undefined) return null;
      return parseJsonValue<T>(row.value);
    },

    async setItem<T>(key: string, value: T): Promise<void> {
      const stored = canonical(value);
      const insert = db.insert(table).values({ key, value: stored });
      if (dialect === "mysql") {
        await insert.onDuplicateKeyUpdate!({ set: { value: stored } });
      } else {
        await insert.onConflictDoUpdate!({ target: table.key, set: { value: stored } });
      }
    },

    async removeItem(key: string): Promise<void> {
      await db.delete(table).where(eq(table.key, key));
    },

    async getKeys(prefix: string): Promise<string[]> {
      const rows = (await db
        .select({ key: table.key })
        .from(table)
        .where(prefixWhere(prefix))) as Array<{ key: unknown }>;
      // A table with a case/accent-folding collation (e.g. a hand-made MySQL table) could
      // over-match: keep only exact prefix matches.
      return rows.map((row) => String(row.key)).filter((key) => key.startsWith(prefix));
    },

    async compareAndSwap<T>(input: { key: string; expected: T | null; next: T }): Promise<boolean> {
      const next = canonical(input.next);
      if (input.expected === null) {
        if (dialect === "mysql") {
          const result = await db.insert(table).ignore!().values({ key: input.key, value: next });
          return affectedRows(result) === 1;
        }
        const rows = await db.insert(table).values({ key: input.key, value: next })
          .onConflictDoNothing!({ target: table.key }).returning({ key: table.key });
        return rows.length === 1;
      }
      const update = db
        .update(table)
        .set({ value: next })
        .where(and(eq(table.key, input.key), valueEquals(input.expected))!);
      if (dialect === "mysql") return affectedRows(await update) === 1;
      const rows = await update.returning!({ key: table.key });
      return rows.length === 1;
    },
  };
}

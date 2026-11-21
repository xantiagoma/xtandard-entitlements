/**
 * Drizzle counter store (ADR 0004) — a {@link CounterStore} over a
 * **consumer-owned** counter table (built with `pgCountersTable` /
 * `mysqlCountersTable` / `sqliteCountersTable`) and the Drizzle database you
 * pass. No DDL, no connection ownership.
 *
 * - **Postgres / SQLite**: `add` is one `INSERT … ON CONFLICT (key) DO UPDATE
 *   SET … RETURNING value, applied`; the bounds decision runs inside the
 *   statement against the locked row (see {@link ./sql.counterAddSql}).
 * - **MySQL** (no `RETURNING`): one `INSERT … ON DUPLICATE KEY UPDATE` whose
 *   assignments are ordered so MySQL's left-to-right evaluation computes
 *   `applied` first, then `value` and `expires_at` from it; the row is read
 *   back **in the same transaction**, while the upsert's row lock is still
 *   held. Claims use the same `applied` marker.
 * - `keys` matches prefixes literally (`LIKE … ESCAPE '!'` / SQLite `GLOB`) and
 *   keeps only exact, case-sensitive matches.
 *
 * @example
 * ```ts
 * import { drizzle } from "drizzle-orm/node-postgres";
 * import { pgCountersTable } from "@xtandard/entitlements/drizzle/pg";
 * import { createDrizzleCounterStore } from "@xtandard/entitlements/counters/drizzle";
 *
 * export const entitlementsCounters = pgCountersTable(); // schema + migrations
 * const counters = createDrizzleCounterStore({ db: drizzle(pool), table: entitlementsCounters });
 * ```
 *
 * @module
 */

import { and, getTableName, inArray, sql, type Column, type SQL } from "drizzle-orm";
import type { DrizzleCounterTable } from "../drizzle/table.ts";
import {
  detectDrizzleDialect,
  type DrizzleDialect,
  type DrizzleLikeDatabase,
} from "../storage/drizzle.ts";
import { escapeGlob, escapeLike } from "../storage/util.ts";
import { assertAmount, type CounterStore } from "./contract.ts";
import { CLAIM_PREFIX, claimSql, counterAddSql, type CounterColumnRefs } from "./sql.ts";

export type { DrizzleCounterTable } from "../drizzle/table.ts";

/** Options for {@link createDrizzleCounterStore}. */
export interface DrizzleCounterStoreOptions {
  /** Your Drizzle database (any Postgres, MySQL or SQLite driver). */
  db: unknown;
  /** The counter table built with a `*CountersTable` factory (or matching that shape). */
  table: DrizzleCounterTable;
  /** Override dialect detection (normally read from `db`). */
  dialect?: DrizzleDialect;
  /** Clock (unix ms) for expiry hints and claim TTLs. Default `Date.now`. */
  now?: () => number;
}

/** A Drizzle {@link CounterStore} with `keys` and an expired-row sweep. */
export interface DrizzleCounterStore extends CounterStore {
  keys(prefix: string): Promise<string[]>;
  /** Delete expired counters and claims. */
  purgeExpired(): Promise<void>;
}

/** Rows of a MySQL `SELECT` across driver result shapes (`[rows, fields]` or `rows`). */
function selectRows(result: unknown): Array<Record<string, unknown>> {
  return (Array.isArray(result) ? result : []) as Array<Record<string, unknown>>;
}

/**
 * Create a Drizzle-backed counter store.
 */
export function createDrizzleCounterStore(
  options: DrizzleCounterStoreOptions,
): DrizzleCounterStore {
  const db = options.db as DrizzleLikeDatabase;
  const { table } = options;
  const dialect = options.dialect ?? detectDrizzleDialect(db);
  const now = options.now ?? Date.now;
  const mysql = dialect === "mysql";
  const q = (name: string): string => (mysql ? `\`${name}\`` : `"${name}"`);
  const tableName = getTableName(table);
  const ref = (col: Column): string => (mysql ? q(col.name) : `${q(tableName)}.${q(col.name)}`);
  const cols: CounterColumnRefs = {
    value: ref(table.value),
    applied: ref(table.applied),
    expiresAt: ref(table.expiresAt),
  };
  const id = (col: Column) => sql.identifier(col.name);
  const live = (t: number): SQL =>
    sql`(${table.expiresAt} is null or ${table.expiresAt} > ${sql.raw(String(Math.trunc(t)))})`;

  /** MySQL: run `upsert` and read `applied`/`value` back under the same row lock. */
  async function mysqlUpsert(
    key: string,
    insert: { value: number; applied: number; expiresAt: number | null },
    set: { applied: string; value: string; expiresAt: string },
  ): Promise<{ applied: number; value: number }> {
    if (!db.transaction || !db.execute) {
      throw new Error("createDrizzleCounterStore: the MySQL db exposes no transaction/execute");
    }
    return db.transaction(async (tx) => {
      await tx.execute!(
        sql`insert into ${table} (${id(table.key)}, ${id(table.value)}, ${id(table.applied)}, ${id(table.expiresAt)})
            values (${key}, ${insert.value}, ${insert.applied}, ${insert.expiresAt})
            on duplicate key update ${id(table.applied)} = ${sql.raw(set.applied)},
              ${id(table.value)} = ${sql.raw(set.value)},
              ${id(table.expiresAt)} = ${sql.raw(set.expiresAt)}`,
      );
      const rows = selectRows(
        await tx
          .select({ value: table.value, applied: table.applied })
          .from(table)
          .where(sql`${table.key} = ${key}`),
      );
      return { applied: Number(rows[0]?.applied) || 0, value: Number(rows[0]?.value) };
    });
  }

  /** Postgres / SQLite: one upsert with `RETURNING`. */
  async function returningUpsert(
    key: string,
    insert: { value: number; applied: number; expiresAt: number | null },
    set: { applied: string; value: string; expiresAt: string },
  ): Promise<{ applied: number; value: number }> {
    const rows = (await db.insert(table).values({ key, ...insert }).onConflictDoUpdate!({
      target: table.key,
      set: {
        applied: sql.raw(set.applied),
        value: sql.raw(set.value),
        expiresAt: sql.raw(set.expiresAt),
      },
    }).returning({ value: table.value, applied: table.applied })) as Array<{
      value: unknown;
      applied: unknown;
    }>;
    return { applied: Number(rows[0]?.applied) || 0, value: Number(rows[0]?.value) };
  }

  const upsert = mysql ? mysqlUpsert : returningUpsert;

  return {
    async get(keys) {
      if (keys.length === 0) return [];
      const rows = (await db
        .select({ key: table.key, value: table.value })
        .from(table)
        .where(and(inArray(table.key, [...keys]), live(now()))!)) as Array<{
        key: unknown;
        value: unknown;
      }>;
      const byKey = new Map(rows.map((r) => [String(r.key), Number(r.value)]));
      return keys.map((k) => byKey.get(k) ?? 0);
    },

    async add(key, amount, opts = {}) {
      const built = counterAddSql(cols, amount, opts, now(), mysql);
      return upsert(key, built.insert, built.set);
    },

    async set(key, value, opts = {}) {
      assertAmount(value);
      const expiresAt = opts.expiresAt === undefined ? null : Math.trunc(opts.expiresAt);
      const insert = db.insert(table).values({ key, value, applied: 0, expiresAt });
      const set = { value, applied: 0, expiresAt };
      if (mysql) await insert.onDuplicateKeyUpdate!({ set });
      else await insert.onConflictDoUpdate!({ target: table.key, set });
    },

    async claim(key, ttlMs) {
      const t = now();
      const until = Math.trunc(t + ttlMs);
      const set = claimSql(cols, t, until, mysql);
      const r = await upsert(CLAIM_PREFIX + key, { value: 0, applied: 1, expiresAt: until }, set);
      return r.applied === 1;
    },

    async release(key) {
      await db.delete(table).where(sql`${table.key} = ${CLAIM_PREFIX + key}`);
    },

    async delete(keys) {
      if (keys.length === 0) return;
      await db.delete(table).where(inArray(table.key, [...keys]));
    },

    async keys(prefix) {
      const match =
        dialect === "sqlite"
          ? sql`${table.key} glob ${`${escapeGlob(prefix)}*`}`
          : sql`${table.key} like ${`${escapeLike(prefix)}%`} escape '!'`;
      const rows = (await db
        .select({ key: table.key })
        .from(table)
        .where(and(match, sql`${table.value} <> 0`, live(now()))!)) as Array<{ key: unknown }>;
      return rows
        .map((r) => String(r.key))
        .filter((k) => k.startsWith(prefix) && !k.startsWith(CLAIM_PREFIX));
    },

    async purgeExpired() {
      await db
        .delete(table)
        .where(
          sql`${table.expiresAt} is not null and ${table.expiresAt} <= ${sql.raw(String(Math.trunc(now())))}`,
        );
    },
  };
}

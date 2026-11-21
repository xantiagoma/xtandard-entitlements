/**
 * Postgres storage adapter backed by a single key/value table
 * (`key text COLLATE "C" PRIMARY KEY, value jsonb`). It works with any client
 * exposing a `query(text, params?)` method that resolves to `{ rows }` — this
 * covers [`pg`](https://github.com/brianc/node-postgres) (`Pool`/`Client`) and
 * the in-process [`@electric-sql/pglite`](https://github.com/electric-sql/pglite)
 * alike. You can pass a pre-built `client`, or a `connectionString`/`url` to
 * lazily create a `pg` `Pool` on first use.
 *
 * The table is created on demand (`CREATE TABLE IF NOT EXISTS`) the first time
 * any operation runs, guarded by a single promise so concurrent callers only
 * issue the DDL once. The key column uses the `"C"` collation so ordering and
 * `LIKE` prefixes are bytewise (case-sensitive) whatever the database default.
 * Values are stored as `jsonb`; both `pg` and `pglite` return `jsonb` already
 * parsed to JS, but a string is JSON-parsed defensively so either driver works.
 *
 * `compareAndSwap` is a single statement — `UPDATE … WHERE key = $1 AND value =
 * $2::jsonb` (jsonb equality is structural) or `INSERT … ON CONFLICT DO
 * NOTHING` when absence is expected — so it is atomic across connections.
 *
 * @module
 */

import { requirePeer } from "./contract.ts";
import type { CompareAndSwapEntitlementsStorage } from "./contract.ts";
import { assertIdentifier, escapeLike, parseJsonValue } from "./util.ts";

/**
 * Minimal structural view of a SQL client. Both `pg`'s `Pool`/`Client` and
 * `@electric-sql/pglite`'s `PGlite` satisfy this shape.
 */
export interface SqlClient {
  query(text: string, params?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
}

/** A client this adapter can also shut down (e.g. a `pg` `Pool`). */
export interface ClosableSqlClient extends SqlClient {
  end?(): Promise<unknown>;
}

/** Options for {@link createPostgresStorage}. */
export interface PostgresStorageOptions {
  /**
   * A pre-built client exposing `query(text, params?) => Promise<{ rows }>`.
   * Both a `pg` `Pool`/`Client` and `@electric-sql/pglite` satisfy this.
   */
  client?: SqlClient;
  /**
   * Connection string used to lazily create a `pg` `Pool` (via dynamic import)
   * when no `client` is supplied.
   */
  connectionString?: string;
  /** Alias for {@link PostgresStorageOptions.connectionString}. */
  url?: string;
  /** Table name (default `"xtandard_entitlements_kv"`). Must be a safe SQL identifier. */
  table?: string;
}

/**
 * A compare-and-swap capable storage backed by Postgres, plus a `close()`
 * method that ends the underlying pool — but only the one this adapter
 * created. A client you passed in is left for you to manage.
 */
export interface PostgresEntitlementsStorage extends CompareAndSwapEntitlementsStorage {
  /** End the underlying pool if this adapter created it. No-op otherwise. */
  close(): Promise<void>;
}

/** A lazily created `pg` client shared by the Postgres storage and counter adapters. */
export interface PgConnection {
  /** Resolve the client, creating a `pg` `Pool` on first use when needed. */
  get(): Promise<ClosableSqlClient>;
  /** End the pool if this connection created it. */
  close(): Promise<void>;
}

/** Build a {@link PgConnection} (internal; shared with `counters/postgres`). */
export function pgConnection(
  client: SqlClient | undefined,
  connectionString: string | undefined,
  subpath: string,
): PgConnection {
  const ownsClient = !client;
  let current: ClosableSqlClient | undefined = client;
  let connecting: Promise<ClosableSqlClient> | undefined;
  return {
    async get(): Promise<ClosableSqlClient> {
      if (current) return current;
      connecting ??= (async () => {
        let Pool: new (config: { connectionString?: string }) => ClosableSqlClient;
        try {
          ({ Pool } = (await import("pg")) as unknown as {
            Pool: new (config: { connectionString?: string }) => ClosableSqlClient;
          });
        } catch {
          requirePeer("pg", subpath);
        }
        current = new Pool({ connectionString });
        return current;
      })();
      try {
        return await connecting;
      } finally {
        connecting = undefined;
      }
    },
    async close(): Promise<void> {
      if (ownsClient && current?.end) await current.end();
    },
  };
}

/**
 * The DDL {@link createPostgresStorage} runs on first use — handy for
 * migrations when the runtime role may not create tables.
 */
export function postgresStorageSchema(table = "xtandard_entitlements_kv"): string {
  assertIdentifier(table);
  return `CREATE TABLE IF NOT EXISTS ${table} (key text COLLATE "C" PRIMARY KEY, value jsonb NOT NULL)`;
}

/**
 * Create a Postgres-backed {@link PostgresEntitlementsStorage}. The table is
 * created lazily on first use; connection (when using `connectionString`/`url`)
 * is also lazy — the `pg` `Pool` is imported and constructed on the first
 * operation and reused thereafter.
 *
 * @example
 * ```ts
 * import { createPostgresStorage } from "@xtandard/entitlements/storage/postgres";
 *
 * // Via connection string (lazy `pg` Pool):
 * const storage = createPostgresStorage({
 *   connectionString: process.env.DATABASE_URL,
 * });
 *
 * // Or with a pre-built pg Pool / PGlite client:
 * // import { PGlite } from "@electric-sql/pglite";
 * // const storage = createPostgresStorage({ client: new PGlite() });
 * ```
 */
export function createPostgresStorage(
  options: PostgresStorageOptions,
): PostgresEntitlementsStorage {
  const table = options.table ?? "xtandard_entitlements_kv";
  const ddl = postgresStorageSchema(table);
  const connection = pgConnection(
    options.client,
    options.connectionString ?? options.url,
    "storage/postgres",
  );
  let ensured: Promise<void> | undefined;

  /** Create the backing table once, before the first operation. */
  async function ensureTable(): Promise<ClosableSqlClient> {
    const c = await connection.get();
    ensured ??= (async () => {
      await c.query(ddl);
    })();
    try {
      await ensured;
    } catch (error) {
      ensured = undefined; // let a later call retry the DDL
      throw error;
    }
    return c;
  }

  return {
    async getItem<T>(key: string): Promise<T | null> {
      const c = await ensureTable();
      const { rows } = await c.query(`SELECT value FROM ${table} WHERE key = $1`, [key]);
      const row = rows[0];
      if (row === undefined || row.value === null || row.value === undefined) return null;
      return parseJsonValue<T>(row.value);
    },

    async setItem<T>(key: string, value: T): Promise<void> {
      const c = await ensureTable();
      await c.query(
        `INSERT INTO ${table} (key, value) VALUES ($1, $2::jsonb)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
        [key, JSON.stringify(value)],
      );
    },

    async removeItem(key: string): Promise<void> {
      const c = await ensureTable();
      await c.query(`DELETE FROM ${table} WHERE key = $1`, [key]);
    },

    async getKeys(prefix: string): Promise<string[]> {
      const c = await ensureTable();
      const { rows } = await c.query(`SELECT key FROM ${table} WHERE key LIKE $1 ESCAPE '!'`, [
        `${escapeLike(prefix)}%`,
      ]);
      // Defence in depth: keep only exact (bytewise) prefix matches whatever the collation.
      return rows.map((row) => String(row.key)).filter((key) => key.startsWith(prefix));
    },

    async compareAndSwap<T>(input: { key: string; expected: T | null; next: T }): Promise<boolean> {
      const c = await ensureTable();
      const next = JSON.stringify(input.next);
      const { rows } =
        input.expected === null
          ? await c.query(
              `INSERT INTO ${table} (key, value) VALUES ($1, $2::jsonb)
               ON CONFLICT (key) DO NOTHING RETURNING key`,
              [input.key, next],
            )
          : await c.query(
              `UPDATE ${table} SET value = $3::jsonb
               WHERE key = $1 AND value = $2::jsonb RETURNING key`,
              [input.key, JSON.stringify(input.expected), next],
            );
      return rows.length === 1;
    },

    close: connection.close,
  } satisfies PostgresEntitlementsStorage;
}

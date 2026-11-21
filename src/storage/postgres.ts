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
 * The driver is `@xtandard/kit/storage/postgres`.
 *
 * @module
 */

import * as kit from "@xtandard/kit/storage/postgres";

export type { ClosableSqlClient, SqlClient } from "@xtandard/kit/storage/postgres";

/** Options for {@link createPostgresStorage}. `table` defaults to `"xtandard_entitlements_kv"`. */
export type PostgresStorageOptions = kit.PostgresStorageOptions;

/** A compare-and-swap capable storage backed by Postgres, plus `close()`. */
export type PostgresEntitlementsStorage = kit.PostgresKvStorage;

/** The persisted default table name. */
const DEFAULT_TABLE = "xtandard_entitlements_kv";

/**
 * The DDL {@link createPostgresStorage} runs on first use — for migrations when
 * the runtime role may not create tables.
 */
export function postgresStorageSchema(table = DEFAULT_TABLE): string {
  return kit.postgresStorageSchema(table);
}

/**
 * Create a Postgres-backed {@link PostgresEntitlementsStorage}. Connection and
 * table creation are lazy.
 *
 * @example
 * ```ts
 * import { createPostgresStorage } from "@xtandard/entitlements/storage/postgres";
 *
 * const storage = createPostgresStorage({ connectionString: process.env.DATABASE_URL });
 * // or: createPostgresStorage({ client: new PGlite() })
 * ```
 */
export function createPostgresStorage(
  options: PostgresStorageOptions = {},
): PostgresEntitlementsStorage {
  return kit.createPostgresStorage({
    subpath: "@xtandard/entitlements/storage/postgres",
    ...options,
    table: options.table ?? DEFAULT_TABLE,
  });
}

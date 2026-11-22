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
 * The driver is `@xtandard/kit/storage/drizzle`. On MySQL, reads, removes and
 * swaps match keys byte-exactly, and a write whose key differs from a stored
 * key only by trailing spaces throws {@link KeyCollisionError} on a PAD SPACE
 * (`utf8mb4_bin`) key column.
 *
 * @module
 */

import * as kit from "@xtandard/kit/storage/drizzle";

export {
  detectDrizzleDialect,
  affectedRows,
  type DrizzleLikeDatabase,
} from "@xtandard/kit/storage/drizzle/internals";
export {
  KeyCollisionError,
  type DrizzleDialect,
  type DrizzleKvTable,
  type DrizzleStorageOptions,
} from "@xtandard/kit/storage/drizzle";

/**
 * A compare-and-swap capable storage over a Drizzle table. For push
 * change-notifications, compose it with `withWatch` + a change source (e.g.
 * `pgListenNotify`) — `watch` is orthogonal to the adapter.
 */
export type DrizzleEntitlementsStorage = kit.DrizzleKvStorage;

/**
 * Create a Drizzle-backed {@link DrizzleEntitlementsStorage}. No DDL, no
 * connection ownership.
 *
 * @example
 * ```ts
 * import { drizzle } from "drizzle-orm/node-postgres";
 * import { createDrizzleStorage } from "@xtandard/entitlements/storage/drizzle";
 * import { pgEntitlementsTable } from "@xtandard/entitlements/drizzle/pg";
 *
 * export const entitlementsKv = pgEntitlementsTable(); // add to your schema + migrate
 * const storage = createDrizzleStorage({ db: drizzle(pool), table: entitlementsKv });
 * ```
 */
export function createDrizzleStorage(
  options: kit.DrizzleStorageOptions,
): DrizzleEntitlementsStorage {
  return kit.createDrizzleStorage({
    subpath: "@xtandard/entitlements/storage/drizzle",
    ...options,
  });
}

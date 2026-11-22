/**
 * SQLite storage adapter built on `bun:sqlite` — **Bun only**, zero npm deps.
 * Ideal for single-node deployments and local/dev persistence: durable, fast, and
 * file-backed (or in-memory). For multi-node runtimes prefer Redis/Postgres.
 *
 * Values are stored as canonical JSON, so `compareAndSwap` is one atomic
 * `UPDATE … WHERE value = ?` (safe across processes sharing the file, too).
 *
 * ```ts
 * import { createSqliteStorage } from "@xtandard/entitlements/storage/sqlite";
 * const storage = createSqliteStorage({ path: "./entitlements.sqlite" });
 * ```
 *
 * The driver is `@xtandard/kit/storage/sqlite`; `bun:sqlite` is loaded on first
 * use, so importing this subpath under Node no longer throws (opening a
 * database still needs Bun).
 *
 * @module
 */

import * as kit from "@xtandard/kit/storage/sqlite";

/** Options for {@link createSqliteStorage}. `table` defaults to `"xtandard_entitlements_kv"`. */
export type SqliteStorageOptions = kit.SqliteStorageOptions;

/** A compare-and-swap capable storage backed by SQLite, plus `close()`. */
export type SqliteEntitlementsStorage = kit.SqliteKvStorage;

/**
 * Create a SQLite-backed {@link SqliteEntitlementsStorage}. The table is created
 * on first use.
 *
 * @example
 * ```ts
 * import { createSqliteStorage } from "@xtandard/entitlements/storage/sqlite";
 *
 * const storage = createSqliteStorage({ path: "./entitlements.sqlite" });
 * ```
 */
export function createSqliteStorage(options: SqliteStorageOptions = {}): SqliteEntitlementsStorage {
  return kit.createSqliteStorage({
    subpath: "@xtandard/entitlements/storage/sqlite",
    ...options,
    table: options.table ?? "xtandard_entitlements_kv",
  });
}

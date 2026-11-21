/**
 * SQLite storage adapter built on `bun:sqlite` — **Bun only**, zero npm deps.
 * Ideal for single-node deployments and local/dev persistence: durable, fast, and
 * file-backed (or in-memory). For multi-node runtimes prefer Redis/Postgres.
 *
 * `bun:sqlite` is marked external at build time, so this module only resolves
 * under the Bun runtime. Importing it under Node will throw — by design.
 *
 * Values are stored as canonical JSON, so `compareAndSwap` is one atomic
 * `UPDATE … WHERE value = ?` (safe across processes sharing the file, too).
 *
 * ```ts
 * import { createSqliteStorage } from "@xtandard/entitlements/storage/sqlite";
 * const storage = createSqliteStorage({ path: "./entitlements.sqlite" });
 * ```
 *
 * @module
 */

import { Database } from "bun:sqlite";
import type { CompareAndSwapEntitlementsStorage } from "./contract.ts";
import { sqliteKvSchema, sqliteKvStorage, type SqliteExecutor } from "./sqlite-kv.ts";
import { assertIdentifier } from "./util.ts";

/** Options for {@link createSqliteStorage}. */
export interface SqliteStorageOptions {
  /** File path for the database. Default `":memory:"`. Ignored when `database` is given. */
  path?: string;
  /** An existing `bun:sqlite` Database instance to use instead of opening one. */
  database?: Database;
  /** Table name (default `"xtandard_entitlements_kv"`). Validated as a safe identifier. */
  table?: string;
}

/** A compare-and-swap capable storage backed by SQLite, plus `close()`. */
export interface SqliteEntitlementsStorage extends CompareAndSwapEntitlementsStorage {
  /** Close the database if this adapter opened it; no-op for a borrowed instance. */
  close(): void;
}

/**
 * Create a SQLite-backed storage. Requires the Bun runtime (`bun:sqlite`).
 *
 * @example
 * ```ts
 * import { createSqliteStorage } from "@xtandard/entitlements/storage/sqlite";
 *
 * // File-backed (persists across restarts):
 * const storage = createSqliteStorage({ path: "./entitlements.sqlite" });
 *
 * // In-memory (reset each run, useful for tests):
 * // const storage = createSqliteStorage({ path: ":memory:" });
 * ```
 */
export function createSqliteStorage(options: SqliteStorageOptions = {}): SqliteEntitlementsStorage {
  const table = assertIdentifier(options.table ?? "xtandard_entitlements_kv");
  const ownsDb = !options.database;
  const db = options.database ?? new Database(options.path ?? ":memory:");
  db.run(sqliteKvSchema(table));

  const executor: SqliteExecutor = {
    async all(sql, args) {
      return db.query(sql).all(...(args as never[])) as Array<Record<string, unknown>>;
    },
  };

  return {
    ...sqliteKvStorage(table, async () => executor),
    close(): void {
      if (ownsDb) db.close();
    },
  };
}

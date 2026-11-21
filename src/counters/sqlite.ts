/**
 * SQLite counter store on `bun:sqlite` — **Bun only**, zero npm deps (ADR
 * 0004). Every `add` is one `INSERT … ON CONFLICT DO UPDATE … RETURNING`
 * statement (see {@link ./sql.sqlCounterStore}); SQLite serializes writers, so
 * it is atomic across connections and processes sharing the file.
 *
 * @module
 */

import { Database } from "bun:sqlite";
import { assertIdentifier } from "../storage/util.ts";
import {
  counterTableSql,
  sqlCounterStore,
  type CounterSqlExecutor,
  type SqlCounterStore,
} from "./sql.ts";

/** Options for {@link createSqliteCounterStore}. */
export interface SqliteCounterStoreOptions {
  /** File path for the database. Default `":memory:"`. Ignored when `database` is given. */
  path?: string;
  /** An existing `bun:sqlite` Database instance to use instead of opening one. */
  database?: Database;
  /** Table name (default `"xtandard_entitlements_counters"`). */
  table?: string;
  /** Clock (unix ms) for expiry hints and claim TTLs. Default `Date.now`. */
  now?: () => number;
}

/** A SQLite {@link SqlCounterStore} plus `close()` (closes a database this store opened). */
export interface SqliteCounterStore extends SqlCounterStore {
  close(): Promise<void>;
}

/**
 * Create a `bun:sqlite` counter store.
 *
 * @example
 * ```ts
 * import { createSqliteCounterStore } from "@xtandard/entitlements/counters/sqlite";
 * const counters = createSqliteCounterStore({ path: "./entitlements.sqlite" });
 * ```
 */
export function createSqliteCounterStore(
  options: SqliteCounterStoreOptions = {},
): SqliteCounterStore {
  const table = assertIdentifier(options.table ?? "xtandard_entitlements_counters");
  const ownsDb = !options.database;
  const db = options.database ?? new Database(options.path ?? ":memory:");
  db.run(counterTableSql("sqlite", table));
  // `prepare` (not the cached `query`): statements inline per-call literals.
  const executor: CounterSqlExecutor = {
    async all(sql, args) {
      return db.prepare(sql).all(...(args as never[])) as Array<Record<string, unknown>>;
    },
  };
  return {
    ...sqlCounterStore({
      dialect: "sqlite",
      table,
      now: options.now ?? Date.now,
      exec: async () => executor,
    }),
    async close() {
      if (ownsDb) db.close();
    },
  };
}

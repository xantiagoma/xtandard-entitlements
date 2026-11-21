/**
 * libSQL / Turso counter store over `@libsql/client` (ADR 0004). Same SQL as
 * the SQLite driver — every `add` is one `INSERT … ON CONFLICT DO UPDATE …
 * RETURNING` statement executed by the (possibly remote) primary, so it is
 * atomic across every instance talking to the database.
 *
 * @module
 */

import { libsqlConnection, libsqlExecutor, type LibsqlClientLike } from "../storage/libsql.ts";
import { assertIdentifier } from "../storage/util.ts";
import { counterTableSql, sqlCounterStore, type SqlCounterStore } from "./sql.ts";

/** Options for {@link createLibsqlCounterStore}. */
export interface LibsqlCounterStoreOptions {
  /** libSQL URL (`libsql://…`, `https://…`, `file:…`, `:memory:`). Used when no `client`. */
  url?: string;
  /** Turso auth token for remote databases. */
  authToken?: string;
  /** A pre-constructed `@libsql/client` client. */
  client?: LibsqlClientLike;
  /** Table name (default `"xtandard_entitlements_counters"`). */
  table?: string;
  /** Clock (unix ms) for expiry hints and claim TTLs. Default `Date.now`. */
  now?: () => number;
}

/** A libSQL {@link SqlCounterStore} plus `close()` (closes a client this store created). */
export interface LibsqlCounterStore extends SqlCounterStore {
  close(): Promise<void>;
}

/**
 * Create a libSQL/Turso counter store. The table is created on first use.
 *
 * @example
 * ```ts
 * import { createLibsqlCounterStore } from "@xtandard/entitlements/counters/libsql";
 * const counters = createLibsqlCounterStore({
 *   url: process.env.TURSO_DATABASE_URL!,
 *   authToken: process.env.TURSO_AUTH_TOKEN,
 * });
 * ```
 */
export function createLibsqlCounterStore(options: LibsqlCounterStoreOptions): LibsqlCounterStore {
  const table = assertIdentifier(options.table ?? "xtandard_entitlements_counters");
  const connection = libsqlConnection(
    options,
    [counterTableSql("sqlite", table)],
    "counters/libsql",
  );
  return {
    ...sqlCounterStore({
      dialect: "sqlite",
      table,
      now: options.now ?? Date.now,
      exec: async () => libsqlExecutor(await connection.get()),
    }),
    async close() {
      connection.close();
    },
  };
}

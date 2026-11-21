/**
 * SQLite counter store on `bun:sqlite` (Bun only): one upsert statement per
 * atomic `add` (ADR 0004).
 *
 * Import from `@xtandard/entitlements/counters/sqlite`.
 *
 * @module counters/sqlite
 */

export { createSqliteCounterStore } from "./counters/sqlite.ts";
export type { SqliteCounterStore, SqliteCounterStoreOptions } from "./counters/sqlite.ts";

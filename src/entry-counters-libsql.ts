/**
 * libSQL / Turso counter store over `@libsql/client`: one upsert statement per
 * atomic `add` (ADR 0004).
 *
 * Import from `@xtandard/entitlements/counters/libsql`.
 *
 * @module counters/libsql
 */

export { createLibsqlCounterStore } from "./counters/libsql.ts";
export type { LibsqlCounterStore, LibsqlCounterStoreOptions } from "./counters/libsql.ts";

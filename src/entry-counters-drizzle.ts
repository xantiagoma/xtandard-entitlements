/**
 * Drizzle counter store over a counter table you own (`drizzle/*`
 * `*CountersTable()` factories): atomic upserts on Postgres, MySQL and SQLite
 * (ADR 0004).
 *
 * Import from `@xtandard/entitlements/counters/drizzle`.
 *
 * @module counters/drizzle
 */

export { createDrizzleCounterStore } from "./counters/drizzle.ts";
export type {
  DrizzleCounterStore,
  DrizzleCounterStoreOptions,
  DrizzleCounterTable,
} from "./counters/drizzle.ts";

/**
 * MongoDB counter store: one pipeline `findOneAndUpdate` per atomic `add`,
 * unique-`_id` claims, TTL-index expiry (ADR 0004).
 *
 * Import from `@xtandard/entitlements/counters/mongodb`.
 *
 * @module counters/mongodb
 */

export { createMongoCounterStore } from "./counters/mongodb.ts";
export type { MongoCounterStore, MongoCounterStoreOptions } from "./counters/mongodb.ts";

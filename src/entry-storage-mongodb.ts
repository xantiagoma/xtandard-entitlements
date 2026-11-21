/**
 * MongoDB state storage: one `{ _id: key, value }` collection over the
 * `mongodb` driver, with single-update compare-and-swap.
 *
 * Import from `@xtandard/entitlements/storage/mongodb`.
 *
 * @module storage/mongodb
 */

export { createMongoStorage } from "./storage/mongodb.ts";
export type { MongoEntitlementsStorage, MongoStorageOptions } from "./storage/mongodb.ts";

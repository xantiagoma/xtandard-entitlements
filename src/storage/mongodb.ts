/**
 * MongoDB storage adapter built on the [`mongodb`](https://github.com/mongodb/node-mongodb-native)
 * driver, an optional peer dependency. You can either pass a pre-constructed
 * (optionally pre-connected) `MongoClient`, or a connection `url` to create and
 * connect a client lazily on first use.
 *
 * The backend is a single collection of `{ _id: <key>, value: <any> }` documents.
 * The storage key is stored verbatim as the document `_id`, and the value is
 * stored directly as a BSON field — MongoDB persists arbitrary objects, arrays,
 * and primitives, so no JSON (de)serialisation round-trip is needed. Object
 * keys are written in sorted (canonical) order, because BSON document equality
 * is field-order sensitive and `compareAndSwap` relies on it.
 *
 * `getKeys(prefix)` matches `_id` against an anchored, escaped regular
 * expression (`^<prefix>`; case-sensitive), projecting only `_id` so the server
 * never ships values back for a key listing.
 *
 * `compareAndSwap` is one `updateOne({ _id, $expr: { $eq: ["$value", expected] } })`
 * (or an `insertOne` guarded by the unique `_id` when absence is expected), so it
 * is atomic on any deployment, standalone included.
 *
 * ## Why no `watch`
 *
 * MongoDB change streams (the natural way to back a watchable storage) require
 * a replica set or sharded cluster — they are unavailable on a standalone
 * `mongod`. To keep this adapter usable against any deployment, `watch` is
 * intentionally **not** implemented; the engine feature-detects its absence via
 * `isWatchable` and relies on its cache TTL instead.
 *
 * The driver is `@xtandard/kit/storage/mongodb`.
 *
 * @module
 */

import * as kit from "@xtandard/kit/storage/mongodb";

/**
 * Options for {@link createMongoStorage}. `dbName` defaults to
 * `"xtandard_entitlements"` and `collectionName` to `"entitlements_kv"`.
 */
export type MongoStorageOptions = kit.MongoStorageOptions;

/** A compare-and-swap capable storage backed by MongoDB, plus `close()`. */
export type MongoEntitlementsStorage = kit.MongoKvStorage;

/**
 * Create a MongoDB-backed {@link MongoEntitlementsStorage}. The client is
 * created and connected lazily when only a `url` is given.
 *
 * @example
 * ```ts
 * import { createMongoStorage } from "@xtandard/entitlements/storage/mongodb";
 *
 * const storage = createMongoStorage({ url: process.env.MONGO_URL });
 * ```
 */
export function createMongoStorage(options: MongoStorageOptions): MongoEntitlementsStorage {
  return kit.createMongoStorage({
    subpath: "@xtandard/entitlements/storage/mongodb",
    ...options,
    dbName: options.dbName ?? "xtandard_entitlements",
    collectionName: options.collectionName ?? "entitlements_kv",
  });
}

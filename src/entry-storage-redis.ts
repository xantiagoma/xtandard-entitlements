/**
 * Redis state storage: `createRedisStorage()` (JSON strings) and
 * `createRedisJSONStorage()` (RedisJSON documents) over node-redis, with a Lua
 * compare-and-swap and keyspace-notification watch.
 *
 * Import from `@xtandard/entitlements/storage/redis`.
 *
 * @module storage/redis
 */

export { createRedisJSONStorage, createRedisStorage } from "./storage/redis.ts";
export type { RedisEntitlementsStorage, RedisLike, RedisStorageOptions } from "./storage/redis.ts";

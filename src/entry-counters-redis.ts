/**
 * Redis counter store: one Lua script per atomic `add`, `SET NX PX` claims,
 * `PEXPIREAT` expiry (ADR 0004).
 *
 * Import from `@xtandard/entitlements/counters/redis`.
 *
 * @module counters/redis
 */

export { createRedisCounterStore } from "./counters/redis.ts";
export type { RedisCounterStore, RedisCounterStoreOptions } from "./counters/redis.ts";

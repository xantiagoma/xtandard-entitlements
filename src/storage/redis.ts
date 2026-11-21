/**
 * Redis storage adapters built on the [`redis`](https://github.com/redis/node-redis)
 * package (node-redis v4/v5), an optional peer dependency. You can either pass a
 * pre-connected `client` or a `url` to connect lazily on first use. An optional
 * `prefix` is prepended (with a `:` separator) to every key so multiple
 * deployments can share a Redis instance without collisions; the prefix is
 * stripped from keys returned by {@link RedisEntitlementsStorage.getKeys}.
 *
 * Two variants over the same plumbing, differing only in the value encoding:
 *
 * - {@link createRedisStorage} — values are plain **strings** containing JSON
 *   (`SET`/`GET`). Works on any Redis; the default choice.
 * - {@link createRedisJSONStorage} — values are native **RedisJSON** documents
 *   (`JSON.SET`/`JSON.GET`), so the stored data is queryable with JSONPath and
 *   indexable with RediSearch. Requires the JSON module (Redis 8 / Redis Stack).
 *   Do NOT point both variants at the same keys — the types are incompatible
 *   (`WRONGTYPE`).
 *
 * `getKeys` uses a non-blocking `SCAN` cursor (never the blocking `KEYS`
 * command) with the prefix glob-escaped, so `*`, `?`, `[` and `\` in a prefix
 * match literally. `watch` is implemented with Redis keyspace notifications; it
 * requires the server to be configured with `notify-keyspace-events` covering
 * generic + string + expiry events (e.g. `KEA` — whose `A` class also covers the
 * module events that RedisJSON writes emit, e.g. `json.set`).
 *
 * ## Compare-and-swap
 *
 * Both variants implement `compareAndSwap` with a small Lua script: it decodes
 * the stored value and the expectation with `cjson`, compares them
 * structurally (object key order is irrelevant) and writes `next` only on a
 * match — one atomic server-side step, safe across any number of instances.
 * The engine uses it for revisioned customer writes.
 *
 * The driver is `@xtandard/kit/storage/redis`.
 *
 * @module
 */

import * as kit from "@xtandard/kit/storage/redis";

export type { RedisLike } from "@xtandard/kit/storage/redis";

/** Options for {@link createRedisStorage} and {@link createRedisJSONStorage}. */
export type RedisStorageOptions = kit.RedisStorageOptions;

/** A watchable, compare-and-swap capable storage backed by Redis, plus `close()`. */
export type RedisEntitlementsStorage = kit.RedisKvStorage;

const SUBPATH = "@xtandard/entitlements/storage/redis";

/**
 * Create a Redis storage that stores values as JSON **strings**. Works on any
 * Redis. Connection is lazy (first operation).
 *
 * @example
 * ```ts
 * import { createRedisStorage } from "@xtandard/entitlements/storage/redis";
 *
 * const storage = createRedisStorage({ url: process.env.REDIS_URL, prefix: "entitlements" });
 * ```
 */
export function createRedisStorage(options: RedisStorageOptions): RedisEntitlementsStorage {
  return kit.createRedisStorage({ subpath: SUBPATH, ...options });
}

/**
 * Create a Redis storage that stores values as native **RedisJSON** documents.
 * Needs Redis 8+ or Redis Stack. Never point it at keys written by
 * {@link createRedisStorage}.
 */
export function createRedisJSONStorage(options: RedisStorageOptions): RedisEntitlementsStorage {
  return kit.createRedisJSONStorage({ subpath: SUBPATH, ...options });
}

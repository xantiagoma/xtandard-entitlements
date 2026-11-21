/**
 * Redis counter store over [`redis`](https://github.com/redis/node-redis)
 * (node-redis v4/v5, an optional peer) — the recommended hot-path counter
 * backend (ADR 0004).
 *
 * - `add` is **one Lua script**: read, decide (`max` / `min` / `partial`,
 *   mirroring {@link computeApplied}), write and expire, executed atomically by
 *   the server. Values are stored as strings formatted with `%.17g`, so every
 *   double — fractional amounts included — round-trips exactly (no
 *   `INCRBYFLOAT` rounding). Results come back as strings for the same reason
 *   (Lua numbers returned to Redis are truncated to integers).
 * - `expiresAt` maps to `PEXPIREAT` (Redis expires the key itself); a write
 *   without a hint keeps the current TTL.
 * - `claim` is `SET … NX PX ttl`; `release` deletes it.
 * - `keys` walks a non-blocking `SCAN` with the prefix glob-escaped.
 *
 * Keys are namespaced as `<prefix>:<key>` (default prefix
 * `"entitlements:counters"`); claims as `<prefix>:_claims/<key>`.
 *
 * @module
 */

import type { RedisClientType } from "redis";
import { redisConnection, scanKeys, type RedisLike } from "../storage/redis.ts";
import { escapeRedisGlob } from "../storage/util.ts";
import { assertAmount, type CounterStore } from "./contract.ts";
import { CLAIM_PREFIX } from "./sql.ts";

/** Options for {@link createRedisCounterStore}. */
export interface RedisCounterStoreOptions {
  /** Connection URL (e.g. `redis://localhost:6379`). Used when no `client` is given. */
  url?: string;
  /** A pre-constructed (optionally pre-connected) node-redis client. */
  client?: RedisClientType;
  /** Key namespace, joined with `:`. Default `"entitlements:counters"`; `""` for none. */
  prefix?: string;
  /** Observe client `error` events (a handler is always attached so errors never crash). */
  onError?: (error: unknown) => void;
}

/** A Redis {@link CounterStore} with `keys` and `close()` (quits a client this store created). */
export interface RedisCounterStore extends CounterStore {
  keys(prefix: string): Promise<string[]>;
  close(): Promise<void>;
}

/**
 * `KEYS[1]` counter; `ARGV`: amount, max (`""` = none), min (`""` = none),
 * partial (`"1"`/`"0"`), expiresAt unix ms (`""` = keep TTL). Returns
 * `{ applied, value }` as `%.17g` strings.
 */
const ADD_SCRIPT = `
local cur = tonumber(redis.call('GET', KEYS[1]) or '0') or 0
local amount = tonumber(ARGV[1])
local applied = amount
if amount > 0 and ARGV[2] ~= '' then
  local room = tonumber(ARGV[2]) - cur
  if amount > room then
    if ARGV[4] == '1' then applied = math.max(0, room) else applied = 0 end
  end
end
if amount < 0 and ARGV[3] ~= '' then
  local room = cur - tonumber(ARGV[3])
  if -amount > room then
    if ARGV[4] == '1' then applied = -math.max(0, room) else applied = 0 end
  end
end
local value = cur + applied
if applied ~= 0 then
  if ARGV[5] ~= '' then
    redis.call('SET', KEYS[1], string.format('%.17g', value))
    redis.call('PEXPIREAT', KEYS[1], ARGV[5])
  else
    redis.call('SET', KEYS[1], string.format('%.17g', value), 'KEEPTTL')
  end
end
return {string.format('%.17g', applied), string.format('%.17g', value)}`;

/** `KEYS[1]` counter; `ARGV`: value, expiresAt unix ms (`""` = none). */
const SET_SCRIPT = `
redis.call('SET', KEYS[1], ARGV[1])
if ARGV[2] ~= '' then redis.call('PEXPIREAT', KEYS[1], ARGV[2]) end
return 1`;

/** `KEYS[1]` claim; `ARGV[1]` TTL ms. Returns 1 when claimed. */
const CLAIM_SCRIPT = `
if redis.call('SET', KEYS[1], '1', 'NX', 'PX', ARGV[1]) then return 1 end
return 0`;

/** Parse a `%.17g` reply (`-0` normalized to `0`). */
const num = (raw: unknown): number => Number(raw) || 0;

/**
 * Create a Redis-backed counter store. Connection is lazy (first operation).
 *
 * @example
 * ```ts
 * import { createRedisCounterStore } from "@xtandard/entitlements/counters/redis";
 *
 * const counters = createRedisCounterStore({ url: process.env.REDIS_URL });
 * // process.on("SIGTERM", () => counters.close());
 * ```
 */
export function createRedisCounterStore(options: RedisCounterStoreOptions = {}): RedisCounterStore {
  const prefix = options.prefix ?? "entitlements:counters";
  const fullPrefix = prefix ? `${prefix}:` : "";
  const connection = redisConnection(options, "counters/redis");
  const k = (key: string): string => fullPrefix + key;
  const claimRoot = fullPrefix + CLAIM_PREFIX;

  return {
    async get(keys) {
      if (keys.length === 0) return [];
      const c = await connection.get();
      const raw = c.mGet
        ? await c.mGet(keys.map(k))
        : await Promise.all(keys.map((x) => c.get(k(x))));
      return raw.map((v) => (v === null ? 0 : num(v)));
    },

    async add(key, amount, opts = {}) {
      assertAmount(amount);
      for (const bound of [opts.max, opts.min, opts.expiresAt]) {
        if (bound !== undefined) assertAmount(bound);
      }
      const c = await connection.get();
      const [applied, value] = (await c.eval(ADD_SCRIPT, {
        keys: [k(key)],
        arguments: [
          String(amount),
          opts.max === undefined ? "" : String(opts.max),
          opts.min === undefined ? "" : String(opts.min),
          opts.partial ? "1" : "0",
          opts.expiresAt === undefined ? "" : String(Math.trunc(opts.expiresAt)),
        ],
      })) as [string, string];
      return { applied: num(applied), value: num(value) };
    },

    async set(key, value, opts = {}) {
      assertAmount(value);
      const c = await connection.get();
      await c.eval(SET_SCRIPT, {
        keys: [k(key)],
        arguments: [
          String(value),
          opts.expiresAt === undefined ? "" : String(Math.trunc(opts.expiresAt)),
        ],
      });
    },

    async claim(key, ttlMs) {
      const c = await connection.get();
      const result = await c.eval(CLAIM_SCRIPT, {
        keys: [claimRoot + key],
        arguments: [String(Math.max(1, Math.ceil(ttlMs)))],
      });
      return Number(result) === 1;
    },

    async release(key) {
      const c = await connection.get();
      await c.del(claimRoot + key);
    },

    async delete(keys) {
      if (keys.length === 0) return;
      const c = await connection.get();
      await c.del(keys.map(k));
    },

    async keys(p) {
      const c: RedisLike = await connection.get();
      const found = await scanKeys(c, `${escapeRedisGlob(k(p))}*`);
      return found
        .filter((x) => x.startsWith(fullPrefix) && !x.startsWith(claimRoot))
        .map((x) => x.slice(fullPrefix.length))
        .filter((x) => x.startsWith(p));
    },

    close: connection.close,
  };
}

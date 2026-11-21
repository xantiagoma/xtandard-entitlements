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
 * @module
 */

import type { RedisClientType } from "redis";
import { requirePeer } from "./contract.ts";
import type {
  CompareAndSwapEntitlementsStorage,
  StorageChangeEvent,
  WatchableEntitlementsStorage,
} from "./contract.ts";
import { escapeRedisGlob } from "./util.ts";

/** Options for {@link createRedisStorage}. */
export interface RedisStorageOptions {
  /** Connection URL (e.g. `redis://localhost:6379`). Used when no `client` is given. */
  url?: string;
  /** A pre-constructed (optionally pre-connected) node-redis client. */
  client?: RedisClientType;
  /** Optional key namespace prepended to every key, joined with `:`. */
  prefix?: string;
  /**
   * Called on client `error` events (connection drops, reconnect failures).
   * A handler is always attached internally so a downed Redis never crashes the
   * process via an unhandled `error` event — this just lets you observe/log them.
   */
  onError?: (error: unknown) => void;
}

/**
 * A {@link WatchableEntitlementsStorage} + {@link CompareAndSwapEntitlementsStorage}
 * backed by Redis, plus a `close()` method that disconnects the client — but
 * only the one this adapter created. A client you passed in is left for you to
 * manage.
 */
export interface RedisEntitlementsStorage
  extends WatchableEntitlementsStorage, CompareAndSwapEntitlementsStorage {
  /** Disconnect the underlying client if this adapter created it. No-op otherwise. */
  close(): Promise<void>;
}

/**
 * Minimal structural view of the node-redis client surface the Redis adapters
 * (storage and counters) use.
 */
export interface RedisLike {
  isOpen?: boolean;
  on?(event: string, listener: (...args: unknown[]) => void): unknown;
  connect(): Promise<unknown>;
  quit(): Promise<unknown>;
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<unknown>;
  del(key: string | string[]): Promise<unknown>;
  mGet?(keys: string[]): Promise<Array<string | null>>;
  eval(script: string, options?: { keys?: string[]; arguments?: string[] }): Promise<unknown>;
  /** RedisJSON module commands (bundled in node-redis; the SERVER needs the module). */
  json?: {
    get(key: string): Promise<unknown>;
    set(key: string, path: string, value: unknown): Promise<unknown>;
  };
  scanIterator(options?: { MATCH?: string; COUNT?: number }): AsyncIterable<string | string[]>;
  duplicate(): RedisLike;
  pSubscribe(
    pattern: string,
    listener: (message: string, channel: string) => void,
  ): Promise<unknown>;
  disconnect(): Promise<unknown>;
}

/** How a variant reads/writes values (the only place the two adapters differ). */
interface RedisValueCodec {
  /** Passed to the CAS script so it reads/writes with the matching commands. */
  kind: "string" | "json";
  get(c: RedisLike, key: string): Promise<unknown>;
  set(c: RedisLike, key: string, value: unknown): Promise<void>;
}

/** Plain strings containing JSON — works on any Redis. */
const stringCodec: RedisValueCodec = {
  kind: "string",
  async get(c, key) {
    const raw = await c.get(key);
    return raw === null ? null : (JSON.parse(raw) as unknown);
  },
  async set(c, key, value) {
    await c.set(key, JSON.stringify(value));
  },
};

/** Native RedisJSON documents — requires the JSON module on the server. */
const jsonCodec: RedisValueCodec = {
  kind: "json",
  async get(c, key) {
    const value = await requireJson(c).get(key);
    return value ?? null;
  },
  async set(c, key, value) {
    await requireJson(c).set(key, "$", value);
  },
};

function requireJson(c: RedisLike): NonNullable<RedisLike["json"]> {
  if (!c.json) {
    throw new Error(
      "createRedisJSONStorage: the client exposes no `json` commands — use node-redis " +
        "(the `redis` package) v4+, and a server with the RedisJSON module (Redis 8 / Redis Stack).",
    );
  }
  return c.json;
}

/**
 * Atomic compare-and-swap. `ARGV[1]` = `"1"` when a value is expected (`"0"`
 * expects absence), `ARGV[2]` = expected JSON, `ARGV[3]` = next JSON,
 * `ARGV[4]` = codec (`string` | `json`). Values are decoded with cjson and
 * compared structurally, so key order and number formatting never cause a
 * spurious mismatch.
 */
const CAS_SCRIPT = `
local function deq(a, b)
  if type(a) ~= type(b) then return false end
  if type(a) ~= 'table' then return a == b end
  for k, v in pairs(a) do
    if not deq(v, b[k]) then return false end
  end
  for k in pairs(b) do
    if a[k] == nil then return false end
  end
  return true
end
local json = ARGV[4] == 'json'
local raw
if json then raw = redis.call('JSON.GET', KEYS[1]) else raw = redis.call('GET', KEYS[1]) end
if ARGV[1] == '0' then
  if raw then return 0 end
else
  if not raw then return 0 end
  if not deq(cjson.decode(raw), cjson.decode(ARGV[2])) then return 0 end
end
if json then redis.call('JSON.SET', KEYS[1], '$', ARGV[3]) else redis.call('SET', KEYS[1], ARGV[3]) end
return 1`;

/**
 * Create a Redis-backed {@link RedisEntitlementsStorage}. Connection is lazy: the
 * client is created/connected on the first storage operation and reused
 * thereafter, guarded by a single connection promise so concurrent calls connect
 * once.
 *
 * @example
 * ```ts
 * import { createRedisStorage } from "@xtandard/entitlements/storage/redis";
 *
 * const storage = createRedisStorage({
 *   url: process.env.REDIS_URL ?? "redis://localhost:6379",
 *   prefix: "myapp:entitlements",
 *   onError: (err) => console.error("[entitlements/redis]", err),
 * });
 *
 * // Disconnect when the process exits:
 * // process.on("SIGTERM", () => storage.close());
 * ```
 */
export function createRedisStorage(options: RedisStorageOptions): RedisEntitlementsStorage {
  return buildRedisStorage(options, stringCodec);
}

/**
 * Create a Redis-backed {@link RedisEntitlementsStorage} that stores values as
 * native **RedisJSON** documents (`JSON.SET`/`JSON.GET`) instead of strings —
 * making the stored records queryable with JSONPath (`JSON.GET key $.revision`)
 * and indexable with RediSearch, while the engine behaves identically.
 *
 * Requires the JSON module on the server (built into Redis 8; Redis Stack; or
 * `redisjson` loaded). Same options and semantics as {@link createRedisStorage},
 * including lazy connection, `SCAN`-based `getKeys`, keyspace-notification
 * `watch`, and Lua `compareAndSwap`. **Do not point it at keys written by
 * `createRedisStorage`** (or vice versa) — the underlying types differ and Redis
 * answers `WRONGTYPE`.
 *
 * @example
 * ```ts
 * import { createRedisJSONStorage } from "@xtandard/entitlements/storage/redis";
 *
 * const storage = createRedisJSONStorage({
 *   url: process.env.REDIS_URL ?? "redis://localhost:6379",
 *   prefix: "myapp:entitlements",
 * });
 * // Then, in redis-cli: JSON.GET myapp:entitlements:ent/customers/org_1 $.subscriptions
 * ```
 */
export function createRedisJSONStorage(options: RedisStorageOptions): RedisEntitlementsStorage {
  return buildRedisStorage(options, jsonCodec);
}

/** A lazily connected node-redis client shared by the Redis storage and counter adapters. */
export interface RedisConnection {
  /** Resolve a connected client, creating/connecting on first use. */
  get(): Promise<RedisLike>;
  /** Attach the internal `error` listener (and the user's `onError`) to a client. */
  attachErrorHandler(c: RedisLike): void;
  /** Quit the client if this connection created it. */
  close(): Promise<void>;
}

/** Build a {@link RedisConnection} (internal; shared with `counters/redis`). */
export function redisConnection(
  options: Pick<RedisStorageOptions, "url" | "client" | "onError">,
  subpath: string,
): RedisConnection {
  const ownsClient = !options.client;
  let client: RedisLike | undefined = options.client as RedisLike | undefined;
  let connecting: Promise<RedisLike> | undefined;

  // node-redis emits `error` on connection drops and reconnect attempts. Without a
  // listener Node treats it as an unhandled error and crashes the process — which
  // would defeat the whole "storage can be down" promise. Always attach one.
  const attachErrorHandler = (c: RedisLike): void => {
    c.on?.("error", (err: unknown) => options.onError?.(err));
  };
  if (client) attachErrorHandler(client);

  return {
    attachErrorHandler,
    async get(): Promise<RedisLike> {
      if (client?.isOpen) return client;
      connecting ??= (async () => {
        if (!client) {
          let createClient: (opts: Record<string, unknown>) => RedisLike;
          try {
            ({ createClient } = (await import("redis")) as unknown as {
              createClient: (opts: Record<string, unknown>) => RedisLike;
            });
          } catch {
            requirePeer("redis", subpath);
          }
          // disableOfflineQueue: commands reject immediately when the socket is
          // down (instead of queueing forever) so a check fails fast and falls
          // back. The reconnect strategy keeps trying with a capped backoff.
          client = createClient({
            url: options.url,
            disableOfflineQueue: true,
            socket: { reconnectStrategy: (retries: number) => Math.min(retries * 100, 3000) },
          });
          attachErrorHandler(client);
        }
        if (!client.isOpen) await client.connect();
        return client;
      })();
      try {
        return await connecting;
      } finally {
        connecting = undefined;
      }
    },
    async close(): Promise<void> {
      if (ownsClient && client?.isOpen) await client.quit();
    },
  };
}

/** Collect every key a `SCAN … MATCH` yields (node-redis v4 yields keys, v5 batches). */
export async function scanKeys(c: RedisLike, match: string): Promise<string[]> {
  const out: string[] = [];
  for await (const entry of c.scanIterator({ MATCH: match, COUNT: 100 })) {
    if (Array.isArray(entry)) out.push(...entry);
    else out.push(entry);
  }
  return out;
}

/** Shared implementation — connection, prefixing, SCAN, watch, CAS, close. */
function buildRedisStorage(
  options: RedisStorageOptions,
  codec: RedisValueCodec,
): RedisEntitlementsStorage {
  const fullPrefix = options.prefix ? `${options.prefix}:` : "";
  const connection = redisConnection(options, "storage/redis");
  const getClient = connection.get;

  /** Prepend the namespace to a caller key. */
  const toRedisKey = (key: string): string => `${fullPrefix}${key}`;
  /** Strip the namespace off a Redis key, yielding the caller key. */
  const fromRedisKey = (key: string): string =>
    fullPrefix && key.startsWith(fullPrefix) ? key.slice(fullPrefix.length) : key;

  return {
    async getItem<T>(key: string): Promise<T | null> {
      const c = await getClient();
      return ((await codec.get(c, toRedisKey(key))) as T | null) ?? null;
    },

    async setItem<T>(key: string, value: T): Promise<void> {
      const c = await getClient();
      await codec.set(c, toRedisKey(key), value);
    },

    async removeItem(key: string): Promise<void> {
      const c = await getClient();
      await c.del(toRedisKey(key));
    },

    async getKeys(prefix: string): Promise<string[]> {
      const c = await getClient();
      const keys = await scanKeys(c, `${escapeRedisGlob(toRedisKey(prefix))}*`);
      return keys.map(fromRedisKey).filter((key) => key.startsWith(prefix));
    },

    async compareAndSwap<T>(input: { key: string; expected: T | null; next: T }): Promise<boolean> {
      const c = await getClient();
      const result = await c.eval(CAS_SCRIPT, {
        keys: [toRedisKey(input.key)],
        arguments: [
          input.expected === null ? "0" : "1",
          input.expected === null ? "" : JSON.stringify(input.expected),
          JSON.stringify(input.next),
          codec.kind,
        ],
      });
      return Number(result) === 1;
    },

    async watch(
      prefix: string,
      callback: (event: StorageChangeEvent) => void,
    ): Promise<() => void> {
      // Keyspace notifications publish to `__keyspace@<db>__:<key>`; subscribe to
      // all key events under our namespaced prefix and translate them.
      const c = await getClient();
      const subscriber = c.duplicate();
      connection.attachErrorHandler(subscriber);
      await subscriber.connect();
      const pattern = `__keyspace@*__:${escapeRedisGlob(toRedisKey(prefix))}*`;
      await subscriber.pSubscribe(pattern, (event: string, channel: string) => {
        const idx = channel.indexOf("__:");
        if (idx === -1) return;
        const key = fromRedisKey(channel.slice(idx + 3));
        if (!key.startsWith(prefix)) return;
        const type: StorageChangeEvent["type"] =
          event === "del" || event === "expired" ? "remove" : "update";
        callback({ type, key });
      });
      return () => {
        void subscriber.disconnect();
      };
    },

    close: connection.close,
  } satisfies RedisEntitlementsStorage;
}

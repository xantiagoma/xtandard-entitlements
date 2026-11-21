import { afterAll, describe, expect, test, vi } from "vitest";
import {
  createRedisJSONStorage,
  createRedisStorage,
  type RedisEntitlementsStorage,
} from "../src/storage/redis.ts";
import { isCompareAndSwap, isWatchable } from "../src/storage/contract.ts";
import { runStorageContractTests } from "./storage-contract.ts";

const REDIS_URL = process.env.REDIS_URL;

/**
 * Live conformance — runs only when `REDIS_URL` is set. Every storage gets a
 * unique key prefix so each contract test starts empty; everything is cleaned
 * up in `afterAll`. The RedisJSON variant runs when the server has the JSON
 * module (Redis 8 / Redis Stack); `REDIS_JSON=0` skips it.
 */
describe.skipIf(!REDIS_URL)("redis storage (live)", () => {
  const runId = `xtandard-entitlements-test:${Date.now()}`;
  let counter = 0;
  const opened: RedisEntitlementsStorage[] = [];
  const make = (factory: typeof createRedisStorage) => () => {
    const storage = factory({ url: REDIS_URL, prefix: `${runId}:${counter++}` });
    opened.push(storage);
    return storage;
  };

  runStorageContractTests("redis", make(createRedisStorage), { compareAndSwap: true });
  describe.skipIf(process.env.REDIS_JSON === "0")("RedisJSON", () => {
    runStorageContractTests("redis-json", make(createRedisJSONStorage), { compareAndSwap: true });
  });

  test("compareAndSwap compares structurally (key order, number formatting)", async () => {
    for (const storage of [make(createRedisStorage)(), make(createRedisJSONStorage)()]) {
      await storage.setItem("ent/c", { a: 1, b: [1.5, { c: null }] });
      expect(
        await storage.compareAndSwap<unknown>({
          key: "ent/c",
          expected: { b: [1.5, { c: null }], a: 1.0 },
          next: { a: 2 },
        }),
      ).toBe(true);
      expect(await storage.getItem("ent/c")).toEqual({ a: 2 });
      expect(
        await storage.compareAndSwap<unknown>({ key: "ent/c", expected: { a: 3 }, next: 1 }),
      ).toBe(false);
      expect(
        await storage.compareAndSwap<unknown>({ key: "ent/c", expected: { a: 2, x: 1 }, next: 1 }),
      ).toBe(false);
    }
  });

  test("watch delivers update and remove events (keyspace notifications)", async () => {
    // Keyspace notifications are off by default; enable them for this test.
    const { createClient } = await import("redis");
    const cfg = createClient({ url: REDIS_URL });
    await cfg.connect();
    await cfg.configSet("notify-keyspace-events", "KEA");
    await cfg.quit();

    const storage = make(createRedisStorage)();
    const events: { type: string; key: string }[] = [];
    const off = await storage.watch("ent/watch/", (e) => events.push(e));
    await storage.setItem("ent/watch/k", { v: 1 });
    await storage.removeItem("ent/watch/k");
    await new Promise((r) => setTimeout(r, 500));
    off();
    expect(events).toContainEqual({ type: "update", key: "ent/watch/k" });
    expect(events).toContainEqual({ type: "remove", key: "ent/watch/k" });
  });

  test("close() leaves a borrowed client open", async () => {
    const { createClient } = await import("redis");
    const client = createClient({ url: REDIS_URL });
    await client.connect();
    const storage = createRedisStorage({ client: client as never, prefix: `${runId}:borrowed` });
    await storage.setItem("ent/b", 1);
    await storage.removeItem("ent/b");
    await storage.close();
    expect(client.isOpen).toBe(true);
    await client.quit();
  });

  afterAll(async () => {
    for (const storage of opened) {
      for (const key of await storage.getKeys("")) await storage.removeItem(key);
      await storage.close();
    }
  });
});

/** A fake node-redis client (Map-backed): enough for prefixing, SCAN batches and codecs. */
function fakeClient() {
  const strings = new Map<string, string>();
  const docs = new Map<string, unknown>();
  const client = {
    isOpen: true,
    on: vi.fn(() => client),
    connect: async () => client,
    quit: vi.fn(async () => undefined),
    get: async (key: string) => strings.get(key) ?? null,
    set: async (key: string, value: string) => {
      strings.set(key, value);
    },
    del: async (key: string) => {
      strings.delete(key);
      docs.delete(key);
    },
    eval: vi.fn(async () => 1),
    json: {
      get: async (key: string) => docs.get(key) ?? null,
      set: async (key: string, _path: string, value: unknown) => {
        docs.set(key, structuredClone(value));
      },
    },
    // node-redis v5 yields batches of keys.
    async *scanIterator(options?: { MATCH?: string }) {
      const match = options?.MATCH ?? "*";
      const literal = match.slice(0, -1).replace(/\\(.)/g, "$1");
      yield [...strings.keys(), ...docs.keys()].filter((k) => k.startsWith(literal));
    },
    duplicate: () => client,
    pSubscribe: async () => undefined,
    disconnect: async () => undefined,
  };
  return client;
}

describe("redis storage (fake client)", () => {
  test("prefixes keys, strips them from getKeys and escapes glob characters", async () => {
    const client = fakeClient();
    const storage = createRedisStorage({ client: client as never, prefix: "ns" });
    await storage.setItem("ent/a*b/k", { v: 1 });
    expect(await client.get("ns:ent/a*b/k")).toBe('{"v":1}');
    expect(await storage.getKeys("ent/a*b/")).toEqual(["ent/a*b/k"]);
    expect(await storage.getItem("ent/a*b/k")).toEqual({ v: 1 });
    await storage.removeItem("ent/a*b/k");
    expect(await storage.getItem("ent/a*b/k")).toBeNull();
  });

  test("compareAndSwap sends the codec and the expectation to the Lua script", async () => {
    const client = fakeClient();
    const storage = createRedisJSONStorage({ client: client as never });
    expect(
      await storage.compareAndSwap<unknown>({ key: "k", expected: null, next: { a: 1 } }),
    ).toBe(true);
    expect(client.eval).toHaveBeenLastCalledWith(expect.stringContaining("cjson"), {
      keys: ["k"],
      arguments: ["0", "", '{"a":1}', "json"],
    });
    client.eval.mockResolvedValueOnce(0);
    expect(await storage.compareAndSwap<unknown>({ key: "k", expected: { a: 1 }, next: 2 })).toBe(
      false,
    );
  });

  test("the JSON variant stores documents and explains a client without json", async () => {
    const client = fakeClient();
    const storage = createRedisJSONStorage({ client: client as never });
    await storage.setItem("ent/j", { a: [1] });
    expect(await storage.getItem("ent/j")).toEqual({ a: [1] });
    const bare = { ...fakeClient(), json: undefined };
    await expect(createRedisJSONStorage({ client: bare as never }).getItem("x")).rejects.toThrow(
      /RedisJSON/,
    );
  });

  test("shape: watchable + CAS, close() before connecting is a no-op, onError attaches", async () => {
    const storage = createRedisStorage({ url: "redis://localhost:6399", onError: () => {} });
    expect(isWatchable(storage)).toBe(true);
    expect(isCompareAndSwap(storage)).toBe(true);
    await expect(storage.close()).resolves.toBeUndefined();
    const client = fakeClient();
    const borrowed = createRedisStorage({ client: client as never });
    expect(client.on).toHaveBeenCalledWith("error", expect.any(Function));
    await borrowed.close();
    expect(client.quit).not.toHaveBeenCalled();
  });
});

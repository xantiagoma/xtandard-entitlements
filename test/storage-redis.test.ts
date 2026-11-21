/**
 * Redis storage: the kit conformance suite on the wrapped drivers, offline on
 * the kit's `fakeRedis` (strings + RedisJSON, its Lua scripts, a repeating
 * SCAN, glob PSUBSCRIBE) and live when `REDIS_URL` is set.
 */

import { asRedisClient, fakeRedis } from "@xtandard/kit/storage/testing";
import { afterAll, describe, expect, test } from "vitest";
import {
  createRedisJSONStorage,
  createRedisStorage,
  type RedisEntitlementsStorage,
} from "../src/storage/redis.ts";
import { isCompareAndSwap, isWatchable } from "../src/storage/contract.ts";
import { runStorageContractTests } from "./storage-contract.ts";

const REDIS_URL = process.env.REDIS_URL;
const t = { describe, test, expect };
const capabilities = { compareAndSwap: true, watch: { settleMs: 300 } };

describe("redis storage (fakeRedis)", () => {
  runStorageContractTests(
    "redis (fake)",
    () => createRedisStorage({ client: asRedisClient(fakeRedis()), prefix: "ns" }),
    { t, capabilities },
  );
  runStorageContractTests(
    "redis-json (fake)",
    () => createRedisJSONStorage({ client: asRedisClient(fakeRedis()), prefix: "ns" }),
    { t, capabilities },
  );

  test("prefixes keys with `prefix:` and strips them from getKeys", async () => {
    const fake = fakeRedis();
    const storage = createRedisStorage({ client: asRedisClient(fake), prefix: "ns" });
    await storage.setItem("ent/customers/org_1", { v: 1 });
    expect([...fake.strings.keys()]).toEqual(["ns:ent/customers/org_1"]);
    expect(await storage.getKeys("ent/")).toEqual(["ent/customers/org_1"]);
  });

  test("shape: watchable + CAS; close() before connecting is a no-op", async () => {
    const storage = createRedisStorage({ url: "redis://localhost:6399", onError: () => {} });
    expect(isWatchable(storage)).toBe(true);
    expect(isCompareAndSwap(storage)).toBe(true);
    await expect(storage.close()).resolves.toBeUndefined();
  });
});

describe.skipIf(!REDIS_URL)("redis storage (live)", () => {
  const runId = `xtandard-entitlements-test:${Date.now()}`;
  let counter = 0;
  const opened: RedisEntitlementsStorage[] = [];
  const make = (factory: typeof createRedisStorage) => () => {
    const storage = factory({ url: REDIS_URL, prefix: `${runId}:${counter++}` });
    opened.push(storage);
    return storage;
  };

  test("keyspace notifications are on (for the watch cases)", async () => {
    const { createClient } = await import("redis");
    const cfg = createClient({ url: REDIS_URL });
    await cfg.connect();
    await cfg.configSet("notify-keyspace-events", "KEA");
    await cfg.quit();
  });

  runStorageContractTests("redis (live)", make(createRedisStorage), {
    t,
    capabilities: { compareAndSwap: true, watch: { settleMs: 500 } },
    timeout: 20_000,
  });
  describe.skipIf(!process.env.REDIS_JSON_URL && process.env.REDIS_JSON !== "1")(
    "RedisJSON",
    () => {
      runStorageContractTests("redis-json (live)", make(createRedisJSONStorage), {
        t,
        capabilities: { compareAndSwap: true, watch: { settleMs: 500 } },
        timeout: 20_000,
      });
    },
  );

  afterAll(async () => {
    for (const storage of opened) {
      for (const key of await storage.getKeys("")) await storage.removeItem(key);
      await storage.close();
    }
  });
});

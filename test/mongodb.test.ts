/**
 * Live MongoDB suites (storage + counters) — run only when `MONGO_URL` is set.
 * A unique database per run keeps repeated runs isolated; it is dropped in
 * `afterAll`.
 */
import { MongoClient } from "mongodb";
import { afterAll, describe, expect, test } from "vitest";
import { createMongoCounterStore, type MongoCounterStore } from "../src/counters/mongodb.ts";
import { createMongoStorage, type MongoEntitlementsStorage } from "../src/storage/mongodb.ts";
import { runCounterContractTests } from "./counter-contract.ts";
import { runStorageContractTests } from "./storage-contract.ts";

const MONGO_URL = process.env.MONGO_URL;
const dbName = `xtandard_entitlements_test_${Date.now()}`;

describe.skipIf(!MONGO_URL)("mongodb (live)", () => {
  let n = 0;
  const storages: MongoEntitlementsStorage[] = [];
  const counters: MongoCounterStore[] = [];
  const makeStorage = () => {
    const s = createMongoStorage({ url: MONGO_URL, dbName, collectionName: `kv_${n++}` });
    storages.push(s);
    return s;
  };
  const makeCounters = (now?: () => number) => {
    const c = createMongoCounterStore({ url: MONGO_URL, dbName, collectionName: `c_${n++}`, now });
    counters.push(c);
    return c;
  };

  runStorageContractTests("mongodb", makeStorage, {
    t: { describe, test, expect },
    capabilities: { compareAndSwap: true, watch: false },
    timeout: 20_000,
  });
  runCounterContractTests("mongodb", () => makeCounters(), { keys: true, concurrency: 50 });

  test("storage: defaults to the xtandard_entitlements db and entitlements_kv collection", async () => {
    const s = createMongoStorage({ url: MONGO_URL });
    storages.push(s);
    const key = `ent/test/${dbName}`;
    await s.setItem(key, { v: 1 });
    const client = new MongoClient(MONGO_URL!);
    await client.connect();
    const doc = await client
      .db("xtandard_entitlements")
      .collection<{ _id: string }>("entitlements_kv")
      .findOne({ _id: key });
    expect(doc).toMatchObject({ value: { v: 1 } });
    await s.removeItem(key);
    await client.close();
  });

  test("counters: expiry and claims follow the injected clock", async () => {
    let t = 1_000;
    const c = makeCounters(() => t);
    await c.add("usage/e", 5, { expiresAt: 2_000 });
    expect(await c.add("usage/e", 9, { max: 10 })).toEqual({ applied: 0, value: 5 });
    expect(await c.claim("idem/x", 500)).toBe(true);
    expect(await c.claim("idem/x", 500)).toBe(false);
    await c.set("cap/s", 3);
    t = 2_000;
    expect(await c.get(["usage/e", "cap/s"])).toEqual([0, 3]);
    expect(await c.add("usage/e", 1)).toEqual({ applied: 1, value: 1 });
    expect(await c.claim("idem/x", 500)).toBe(true);
    expect((await c.keys("")).sort()).toEqual(["cap/s", "usage/e"]);
    await c.release("idem/x");
    expect(await c.claim("idem/x", 500)).toBe(true);
  });

  test("counters: case- and metacharacter-exact keys; fractional math", async () => {
    const c = makeCounters();
    for (const k of ["usage/A/x", "usage/a/x", "usage/./x", "usage/(/x"]) await c.add(k, 1);
    expect(await c.keys("usage/A/")).toEqual(["usage/A/x"]);
    expect(await c.keys("usage/./")).toEqual(["usage/./x"]);
    await c.add("usage/f", 0.1);
    expect((await c.add("usage/f", 0.2)).value).toBe(0.1 + 0.2);
    expect(await c.get([])).toEqual([]);
    await c.delete([]);
  });

  afterAll(async () => {
    for (const s of storages) await s.close();
    for (const c of counters) await c.close();
    const client = new MongoClient(MONGO_URL!);
    await client.connect();
    await client.db(dbName).dropDatabase();
    await client.close();
  });
});

describe("mongodb adapters without a server", () => {
  test("require a client or url", async () => {
    await expect(createMongoStorage({}).getItem("k")).rejects.toThrow(
      /@xtandard\/entitlements\/storage\/mongodb.*client.*url/,
    );
    await expect(createMongoCounterStore({}).get(["k"])).rejects.toThrow(
      /@xtandard\/entitlements\/counters\/mongodb.*client.*url/,
    );
    await expect(createMongoStorage({}).close()).resolves.toBeUndefined();
  });
});

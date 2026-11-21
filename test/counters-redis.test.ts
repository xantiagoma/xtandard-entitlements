import { afterAll, describe, expect, test } from "vitest";
import { createRedisCounterStore, type RedisCounterStore } from "../src/counters/redis.ts";
import { runCounterContractTests } from "./counter-contract.ts";

const REDIS_URL = process.env.REDIS_URL;

describe.skipIf(!REDIS_URL)("redis counters (live)", () => {
  const runId = `xtandard-entitlements-counters-test:${Date.now()}`;
  let n = 0;
  const opened: RedisCounterStore[] = [];
  const make = () => {
    const c = createRedisCounterStore({ url: REDIS_URL, prefix: `${runId}:${n++}` });
    opened.push(c);
    return c;
  };

  runCounterContractTests("redis", make, { keys: true, concurrency: 100 });

  test("fractions and large integers round-trip exactly (%.17g)", async () => {
    const c = make();
    await c.add("usage/f", 0.1);
    expect((await c.add("usage/f", 0.2)).value).toBe(0.1 + 0.2);
    const big = 2 ** 53 - 1;
    expect(await c.add("usage/big", big)).toEqual({ applied: big, value: big });
    expect(await c.add("usage/tiny", 1e-7)).toEqual({ applied: 1e-7, value: 1e-7 });
  });

  test("expiresAt maps to PEXPIREAT; adds without a hint keep the TTL", async () => {
    const c = make();
    await c.add("usage/e", 1, { expiresAt: Date.now() + 300 });
    await c.add("usage/e", 1);
    expect(await c.get(["usage/e"])).toEqual([2]);
    await c.set("cap/s", 5, { expiresAt: Date.now() + 300 });
    await new Promise((r) => setTimeout(r, 450));
    expect(await c.get(["usage/e", "cap/s"])).toEqual([0, 0]);
  });

  test("claims expire after their TTL and stay out of keys()", async () => {
    const c = make();
    expect(await c.claim("idem/x", 200)).toBe(true);
    expect(await c.claim("idem/x", 200)).toBe(false);
    await c.add("usage/a", 1);
    expect(await c.keys("")).toEqual(["usage/a"]);
    await new Promise((r) => setTimeout(r, 300));
    expect(await c.claim("idem/x", 200)).toBe(true);
  });

  test("keys escape glob metacharacters", async () => {
    const c = make();
    for (const k of ["usage/*/a", "usage/x/b", "usage/[/c", "usage/?/d"]) await c.add(k, 1);
    expect(await c.keys("usage/*/")).toEqual(["usage/*/a"]);
    expect(await c.keys("usage/[/")).toEqual(["usage/[/c"]);
    expect(await c.keys("usage/?/")).toEqual(["usage/?/d"]);
  });

  afterAll(async () => {
    for (const c of opened) {
      await c.delete(await c.keys(""));
      await c.close();
    }
  });
});

describe("redis counters (fake client)", () => {
  function fake() {
    const strings = new Map<string, string>();
    const calls: Array<{ keys?: string[]; arguments?: string[] }> = [];
    const client = {
      isOpen: true,
      on: () => client,
      connect: async () => client,
      quit: async () => undefined,
      get: async (k: string) => strings.get(k) ?? null,
      set: async () => undefined,
      del: async (k: string | string[]) => {
        for (const x of [k].flat()) strings.delete(x);
      },
      eval: async (_script: string, opts: { keys?: string[]; arguments?: string[] }) => {
        calls.push(opts);
        return ["-0", "3"];
      },
      async *scanIterator() {
        yield "p:usage/a";
        yield "p:_claims/idem/x";
      },
      duplicate: () => client,
      pSubscribe: async () => undefined,
      disconnect: async () => undefined,
    };
    return { client, strings, calls };
  }

  test("namespaces keys, normalizes -0, falls back to GET without MGET, hides claims", async () => {
    const { client, strings, calls } = fake();
    strings.set("p:usage/a", "2.5");
    const c = createRedisCounterStore({ client: client as never, prefix: "p" });
    expect(await c.get(["usage/a", "usage/b"])).toEqual([2.5, 0]);
    expect(await c.get([])).toEqual([]);
    expect(await c.add("usage/a", 1, { max: 3, partial: true, expiresAt: 10.7 })).toEqual({
      applied: 0,
      value: 3,
    });
    expect(calls.at(-1)).toEqual({ keys: ["p:usage/a"], arguments: ["1", "3", "", "1", "10"] });
    await c.set("cap/x", 1);
    expect(calls.at(-1)).toEqual({ keys: ["p:cap/x"], arguments: ["1", ""] });
    await c.claim("idem/x", 0.5);
    expect(calls.at(-1)).toEqual({ keys: ["p:_claims/idem/x"], arguments: ["1"] });
    expect(await c.keys("")).toEqual(["usage/a"]);
    await c.delete([]);
    await c.delete(["usage/a"]);
    await c.release("idem/x");
    expect(strings.size).toBe(0);
    await expect(c.add("usage/a", Number.NaN)).rejects.toThrow();
    await expect(c.add("usage/a", 1, { max: Number.POSITIVE_INFINITY })).rejects.toThrow();
    await expect(c.set("usage/a", Number.NaN)).rejects.toThrow();
    await c.close();
  });

  test("the default namespace is entitlements:counters", async () => {
    const { client, calls } = fake();
    const c = createRedisCounterStore({ client: client as never });
    await c.add("usage/a", 1);
    expect(calls[0]?.keys).toEqual(["entitlements:counters:usage/a"]);
  });
});

import { describe, expect, it } from "vitest";
import { createMemoryCounterStore } from "../src/counters/memory.ts";
import { createKvCounterStore } from "../src/counters/kv.ts";
import { createBufferedCounterStore } from "../src/counters/buffered.ts";
import { computeApplied } from "../src/counters/contract.ts";
import { createMemoryStorage } from "../src/storage/memory.ts";
import type { EntitlementsStorage } from "../src/storage/contract.ts";
import { runCounterContractTests } from "./counter-contract.ts";

runCounterContractTests("memory", () => createMemoryCounterStore(), { keys: true });
runCounterContractTests(
  "kv (memory storage CAS)",
  () => createKvCounterStore(createMemoryStorage()),
  {
    keys: true,
  },
);
runCounterContractTests(
  "buffered(memory)",
  () => createBufferedCounterStore(createMemoryCounterStore(), { flushInterval: 0 }),
  {
    keys: true,
  },
);

describe("computeApplied", () => {
  it("handles bounds", () => {
    expect(computeApplied(5, 3)).toBe(3);
    expect(computeApplied(5, 3, { max: 7 })).toBe(0);
    expect(computeApplied(5, 3, { max: 7, partial: true })).toBe(2);
    expect(computeApplied(5, -7, { min: 0 })).toBe(0);
    expect(computeApplied(5, -7, { min: 0, partial: true })).toBe(-5);
    expect(computeApplied(5, -3, { max: 1 })).toBe(-3);
  });
});

describe("memory counters", () => {
  it("expires values and claims by the injected clock", async () => {
    let t = 1_000;
    const c = createMemoryCounterStore({ now: () => t });
    await c.add("usage/e", 5, { expiresAt: 2_000 });
    expect(await c.get(["usage/e"])).toEqual([5]);
    expect(await c.claim("idem/x", 500)).toBe(true);
    t = 2_000;
    expect(await c.get(["usage/e"])).toEqual([0]);
    expect(await c.claim("idem/x", 500)).toBe(true);
  });
});

describe("kv counters", () => {
  it("refuses storage without compareAndSwap", () => {
    const plain: EntitlementsStorage = {
      getItem: async () => null,
      setItem: async () => {},
      removeItem: async () => {},
      getKeys: async () => [],
    };
    expect(() => createKvCounterStore(plain)).toThrow(/compareAndSwap/);
  });

  it("gives up after maxRetries under constant contention", async () => {
    const storage = createMemoryStorage();
    const contended: EntitlementsStorage = Object.assign(Object.create(storage), {
      compareAndSwap: async () => false,
    });
    const c = createKvCounterStore(contended, { maxRetries: 3 });
    await expect(c.add("usage/x", 1)).rejects.toThrow(/contended/);
  });
});

describe("buffered counters", () => {
  it("decides locally and flushes deltas in one add per key", async () => {
    const inner = createMemoryCounterStore();
    const calls: number[] = [];
    const spy = {
      ...inner,
      add: async (k: string, a: number, o?: object) => (calls.push(a), inner.add(k, a, o)),
    };
    const b = createBufferedCounterStore(spy, { flushInterval: 0 });
    for (let i = 0; i < 5; i++) await b.add("usage/b", 2, { max: 7 });
    expect(await b.get(["usage/b"])).toEqual([6]); // 2+2+2, the rest refused
    expect(await inner.get(["usage/b"])).toEqual([0]);
    expect(b.pendingKeys()).toBe(1);
    await b.flush();
    expect(calls).toEqual([6]);
    expect(await inner.get(["usage/b"])).toEqual([6]);
    expect(b.pendingKeys()).toBe(0);
  });

  it("keeps the delta when a flush fails and retries", async () => {
    const inner = createMemoryCounterStore();
    let fail = true;
    const errors: unknown[] = [];
    const flaky = {
      ...inner,
      add: async (k: string, a: number, o?: object) => {
        if (fail) throw new Error("down");
        return inner.add(k, a, o);
      },
    };
    const b = createBufferedCounterStore(flaky, {
      flushInterval: 0,
      onError: (e) => errors.push(e),
    });
    await b.add("usage/f", 3);
    await b.flush();
    expect(errors).toHaveLength(1);
    expect(b.pendingKeys()).toBe(1);
    fail = false;
    await b.close();
    expect(await inner.get(["usage/f"])).toEqual([3]);
  });

  it("refreshes from the inner store after refreshAfter (other instances)", async () => {
    let t = 0;
    const inner = createMemoryCounterStore();
    const b = createBufferedCounterStore(inner, {
      flushInterval: 0,
      refreshAfter: 1000,
      now: () => t,
    });
    expect(await b.get(["usage/r"])).toEqual([0]);
    await inner.add("usage/r", 4); // another instance
    expect(await b.get(["usage/r"])).toEqual([0]);
    t = 1001;
    expect(await b.get(["usage/r"])).toEqual([4]);
  });

  it("flushes on the interval and when maxPending keys are dirty", async () => {
    const inner = createMemoryCounterStore();
    const b = createBufferedCounterStore(inner, { flushInterval: 10, maxPending: 2 });
    await b.add("usage/1", 1);
    await b.add("usage/2", 1); // hits maxPending → flush
    await new Promise((r) => setTimeout(r, 5));
    expect(await inner.get(["usage/1", "usage/2"])).toEqual([1, 1]);
    await b.add("usage/3", 1);
    await new Promise((r) => setTimeout(r, 30));
    expect(await inner.get(["usage/3"])).toEqual([1]);
    await b.close();
  });
});

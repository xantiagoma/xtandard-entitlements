/**
 * Reusable conformance suite for the {@link CounterStore} port (ADR 0004).
 * Every counter driver runs it. The concurrency tests are the point: N
 * parallel bounded adds must never push a counter past `max`.
 *
 * @module
 */

import { describe, expect, test } from "vitest";
import type { CounterStore } from "../src/counters/contract.ts";

/** A factory producing a fresh, empty store for each test. */
export type MakeCounters = () => Promise<CounterStore> | CounterStore;

/** Options for {@link runCounterContractTests}. */
export interface CounterContractOptions {
  /** Parallel adds in the concurrency test. Default 50. */
  concurrency?: number;
  /** The store supports `keys(prefix)`. */
  keys?: boolean;
  /** Skip fractional-amount checks (integer-only backends). */
  integersOnly?: boolean;
}

/** Register the full contract suite for a counter driver. */
export function runCounterContractTests(
  name: string,
  make: MakeCounters,
  options: CounterContractOptions = {},
): void {
  const n = options.concurrency ?? 50;
  describe(`CounterStore contract: ${name}`, () => {
    test("missing keys read as 0", async () => {
      const c = await make();
      expect(await c.get(["usage/a", "usage/b"])).toEqual([0, 0]);
    });

    test("add accumulates and returns applied + value", async () => {
      const c = await make();
      expect(await c.add("usage/x", 3)).toEqual({ applied: 3, value: 3 });
      expect(await c.add("usage/x", 4)).toEqual({ applied: 4, value: 7 });
      expect(await c.get(["usage/x"])).toEqual([7]);
    });

    test("max is all-or-nothing by default", async () => {
      const c = await make();
      await c.add("usage/m", 8);
      expect(await c.add("usage/m", 3, { max: 10 })).toEqual({ applied: 0, value: 8 });
      expect(await c.add("usage/m", 2, { max: 10 })).toEqual({ applied: 2, value: 10 });
      expect(await c.add("usage/m", 1, { max: 10 })).toEqual({ applied: 0, value: 10 });
    });

    test("partial applies as much as fits (never negative)", async () => {
      const c = await make();
      await c.add("usage/p", 8);
      expect(await c.add("usage/p", 5, { max: 10, partial: true })).toEqual({
        applied: 2,
        value: 10,
      });
      expect(await c.add("usage/p", 5, { max: 10, partial: true })).toEqual({
        applied: 0,
        value: 10,
      });
      await c.add("usage/q", 12);
      expect(await c.add("usage/q", 5, { max: 10, partial: true })).toEqual({
        applied: 0,
        value: 12,
      });
    });

    test("negative adds with min clamp (refunds)", async () => {
      const c = await make();
      await c.add("usage/r", 3);
      expect(await c.add("usage/r", -2, { min: 0 })).toEqual({ applied: -2, value: 1 });
      expect(await c.add("usage/r", -5, { min: 0 })).toEqual({ applied: 0, value: 1 });
      expect(await c.add("usage/r", -5, { min: 0, partial: true })).toEqual({
        applied: -1,
        value: 0,
      });
    });

    test("unbounded negative adds go below zero", async () => {
      const c = await make();
      expect((await c.add("usage/neg", -2)).value).toBe(-2);
    });

    if (!options.integersOnly) {
      test("fractional amounts", async () => {
        const c = await make();
        await c.add("usage/f", 0.5);
        const r = await c.add("usage/f", 0.25, { max: 1 });
        expect(r.applied).toBeCloseTo(0.25);
        expect(r.value).toBeCloseTo(0.75);
      });
    }

    test("set overwrites; delete removes", async () => {
      const c = await make();
      await c.add("cap/s", 5);
      await c.set("cap/s", 2);
      expect(await c.get(["cap/s"])).toEqual([2]);
      await c.delete(["cap/s", "cap/missing"]);
      expect(await c.get(["cap/s"])).toEqual([0]);
    });

    test("claim is set-if-absent; release frees it", async () => {
      const c = await make();
      expect(await c.claim("idem/k", 60_000)).toBe(true);
      expect(await c.claim("idem/k", 60_000)).toBe(false);
      await c.release("idem/k");
      expect(await c.claim("idem/k", 60_000)).toBe(true);
    });

    test("concurrent claims: exactly one wins", async () => {
      const c = await make();
      const results = await Promise.all(
        Array.from({ length: 10 }, () => c.claim("idem/race", 60_000)),
      );
      expect(results.filter(Boolean)).toHaveLength(1);
    });

    test(`${n} concurrent bounded adds never exceed max`, async () => {
      const c = await make();
      const results = await Promise.all(
        Array.from({ length: n }, () => c.add("usage/race", 1, { max: Math.floor(n / 2) })),
      );
      expect(results.filter((r) => r.applied === 1)).toHaveLength(Math.floor(n / 2));
      expect(await c.get(["usage/race"])).toEqual([Math.floor(n / 2)]);
    });

    test(`${n} concurrent partial adds fill exactly to max`, async () => {
      const c = await make();
      const results = await Promise.all(
        Array.from({ length: n }, () => c.add("usage/prace", 3, { max: n, partial: true })),
      );
      expect(results.reduce((s, r) => s + r.applied, 0)).toBe(n);
      expect(await c.get(["usage/prace"])).toEqual([n]);
    });

    test("rejects non-finite amounts", async () => {
      const c = await make();
      await expect(c.add("usage/bad", Number.NaN)).rejects.toThrow();
      await expect(c.add("usage/bad", Number.POSITIVE_INFINITY)).rejects.toThrow();
    });

    if (options.keys) {
      test("keys lists non-zero counters under a prefix", async () => {
        const c = await make();
        await c.add("usage/k1/a", 1);
        await c.add("usage/k1/b", 2);
        await c.add("usage/k2/c", 3);
        expect((await c.keys!("usage/k1/")).sort()).toEqual(["usage/k1/a", "usage/k1/b"]);
      });
    }
  });
}

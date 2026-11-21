/**
 * Reusable conformance suite for the {@link EntitlementsStorage} contract (the
 * flags/webhooks KV contract). Each driver's test calls
 * {@link runStorageContractTests}. No `.test.ts` suffix: it only runs when
 * imported.
 *
 * @module
 */

import { describe, expect, test } from "vitest";
import { customerKey } from "../src/keys.ts";
import { isCompareAndSwap, type EntitlementsStorage } from "../src/storage/contract.ts";

/** A factory producing a fresh, empty storage for each test. */
export type MakeStorage = () => Promise<EntitlementsStorage> | EntitlementsStorage;

/** Optional capabilities a backend opts into. */
export interface StorageContractOptions {
  /** Run compare-and-swap semantics tests. */
  compareAndSwap?: boolean;
}

/** Register the full contract suite for a driver. */
export function runStorageContractTests(
  name: string,
  makeStorage: MakeStorage,
  options: StorageContractOptions = {},
): void {
  describe(`EntitlementsStorage contract: ${name}`, () => {
    test("returns null for a missing key", async () => {
      const storage = await makeStorage();
      expect(await storage.getItem("ent/customers/missing")).toBeNull();
    });

    test("round-trips an object value", async () => {
      const storage = await makeStorage();
      const value = {
        id: "org_1",
        subscriptions: [{ plan: "pro", quantity: 2 }],
        nested: { x: 1 },
      };
      await storage.setItem(customerKey("org_1"), value);
      expect(await storage.getItem(customerKey("org_1"))).toEqual(value);
    });

    test("round-trips primitive values", async () => {
      const storage = await makeStorage();
      await storage.setItem("ent/links/stripe/cus_1", "org_1");
      expect(await storage.getItem("ent/links/stripe/cus_1")).toBe("org_1");
    });

    test("overwrites an existing key", async () => {
      const storage = await makeStorage();
      await storage.setItem("ent/k", { v: 1 });
      await storage.setItem("ent/k", { v: 2 });
      expect(await storage.getItem("ent/k")).toEqual({ v: 2 });
    });

    test("removeItem deletes a key; missing is a no-op", async () => {
      const storage = await makeStorage();
      await storage.setItem("ent/k", { v: 1 });
      await storage.removeItem("ent/k");
      expect(await storage.getItem("ent/k")).toBeNull();
      await expect(storage.removeItem("ent/nope")).resolves.toBeUndefined();
    });

    test("getKeys lists nested keys under a prefix, isolated", async () => {
      const storage = await makeStorage();
      await storage.setItem(customerKey("a"), { v: 1 });
      await storage.setItem(customerKey("b/with slash"), { v: 2 });
      await storage.setItem("ent/reservations/r1", { v: 3 });
      expect((await storage.getKeys("ent/customers/")).sort()).toEqual(
        [customerKey("a"), customerKey("b/with slash")].sort(),
      );
      expect(await storage.getKeys("ent/reservations/")).toEqual(["ent/reservations/r1"]);
      expect(await storage.getKeys("ent/nothing/")).toEqual([]);
    });
  });

  if (options.compareAndSwap) {
    describe(`compareAndSwap semantics: ${name}`, () => {
      test("succeeds only when expectations hold", async () => {
        const storage = await makeStorage();
        if (!isCompareAndSwap(storage)) throw new Error("storage has no compareAndSwap");
        expect(
          await storage.compareAndSwap({ key: "ent/c", expected: { v: 1 }, next: { v: 2 } }),
        ).toBe(false);
        expect(await storage.compareAndSwap({ key: "ent/c", expected: null, next: { v: 1 } })).toBe(
          true,
        );
        expect(await storage.compareAndSwap({ key: "ent/c", expected: null, next: { v: 9 } })).toBe(
          false,
        );
        expect(
          await storage.compareAndSwap({ key: "ent/c", expected: { v: 0 }, next: { v: 2 } }),
        ).toBe(false);
        expect(
          await storage.compareAndSwap({ key: "ent/c", expected: { v: 1 }, next: { v: 2 } }),
        ).toBe(true);
        expect(await storage.getItem("ent/c")).toEqual({ v: 2 });
      });

      test("concurrent swaps from the same expectation: exactly one wins", async () => {
        const storage = await makeStorage();
        if (!isCompareAndSwap(storage)) throw new Error("storage has no compareAndSwap");
        await storage.setItem("ent/race", { n: 0 });
        const results = await Promise.all(
          Array.from({ length: 8 }, (_, i) =>
            storage.compareAndSwap({ key: "ent/race", expected: { n: 0 }, next: { n: i + 1 } }),
          ),
        );
        expect(results.filter(Boolean)).toHaveLength(1);
      });
    });
  }
}

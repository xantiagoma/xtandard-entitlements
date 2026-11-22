import { describe, expect, it, test } from "vitest";
import { createMemoryStorage } from "../src/storage/memory.ts";
import { isCompareAndSwap, isWatchable } from "../src/storage/contract.ts";
import { runStorageContractTests } from "./storage-contract.ts";

runStorageContractTests("memory", () => createMemoryStorage(), {
  t: { describe, test, expect },
  capabilities: { compareAndSwap: true, watch: true },
});

describe("memory storage (entitlements entry)", () => {
  it("is watchable and compare-and-swap capable, and takes seed data", async () => {
    const storage = createMemoryStorage({ initial: { "ent/seed": { a: 1 } } });
    expect(isWatchable(storage)).toBe(true);
    expect(isCompareAndSwap(storage)).toBe(true);
    expect(await storage.getItem("ent/seed")).toEqual({ a: 1 });
  });
});

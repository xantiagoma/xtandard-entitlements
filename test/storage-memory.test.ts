import { describe, expect, it } from "vitest";
import { createMemoryStorage } from "../src/storage/memory.ts";
import { isCompareAndSwap, isWatchable } from "../src/storage/contract.ts";
import { runStorageContractTests } from "./storage-contract.ts";

runStorageContractTests("memory", () => createMemoryStorage(), { compareAndSwap: true });

describe("memory storage extras", () => {
  it("is watchable and compare-and-swap capable", () => {
    const storage = createMemoryStorage();
    expect(isWatchable(storage)).toBe(true);
    expect(isCompareAndSwap(storage)).toBe(true);
  });

  it("clones on read and write", async () => {
    const storage = createMemoryStorage({ initial: { "ent/seed": { a: 1 } } });
    expect(await storage.getItem("ent/seed")).toEqual({ a: 1 });
    const value = { nested: { count: 1 } };
    await storage.setItem("ent/k", value);
    value.nested.count = 99;
    expect((await storage.getItem<typeof value>("ent/k"))?.nested.count).toBe(1);
  });

  it("watch fires on update and remove, filtered by prefix", async () => {
    const storage = createMemoryStorage();
    const events: string[] = [];
    const off = await storage.watch("ent/customers/", (e) => events.push(`${e.type}:${e.key}`));
    await storage.setItem("ent/customers/a", 1);
    await storage.setItem("ent/other/b", 2);
    await storage.compareAndSwap({ key: "ent/customers/a", expected: 1, next: 2 });
    await storage.removeItem("ent/customers/a");
    await new Promise((r) => setTimeout(r, 0));
    expect(events).toEqual([
      "update:ent/customers/a",
      "update:ent/customers/a",
      "remove:ent/customers/a",
    ]);
    off();
  });
});

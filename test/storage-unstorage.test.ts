import { createStorage } from "unstorage";
import { describe, expect, test } from "vitest";
import { createUnstorageStorage } from "../src/storage/unstorage.ts";
import { runStorageContractTests } from "./storage-contract.ts";

runStorageContractTests("unstorage (memory driver)", () =>
  createUnstorageStorage({ storage: createStorage() }),
);

describe("createUnstorageStorage specifics", () => {
  test("getKeys returns slash-separated keys, not unstorage's colon form", async () => {
    const storage = createUnstorageStorage({ storage: createStorage() });
    await storage.setItem("ent/customers/org_1", { v: 1 });
    await storage.setItem("ent/activity-log", { v: 2 });
    const keys = await storage.getKeys("ent/");
    expect(keys.sort()).toEqual(["ent/activity-log", "ent/customers/org_1"]);
    for (const k of keys) expect(k).not.toContain(":");
  });

  test("keys with characters unstorage rewrites round-trip verbatim", async () => {
    const storage = createUnstorageStorage({ storage: createStorage() });
    const keys = ["ent/a:b", "ent/q?x", "ent/end$", "ent/pct%3A", "ent/back\\slash"];
    for (const k of keys) await storage.setItem(k, k);
    for (const k of keys) expect(await storage.getItem(k)).toBe(k);
    expect((await storage.getKeys("ent/")).sort()).toEqual([...keys].sort());
    expect(await storage.getKeys("ent/a:")).toEqual(["ent/a:b"]);
  });

  test("auto-deserializes JSON values and yields null for missing", async () => {
    const storage = createUnstorageStorage({ storage: createStorage() });
    expect(await storage.getItem("ent/none")).toBeNull();
    await storage.setItem("ent/obj", { nested: { ok: true } });
    expect(await storage.getItem("ent/obj")).toEqual({ nested: { ok: true } });
  });
});

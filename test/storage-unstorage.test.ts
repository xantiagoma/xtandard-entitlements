import { createStorage } from "unstorage";
import { describe, expect, test } from "vitest";
import { createUnstorageStorage } from "../src/storage/unstorage.ts";
import { runStorageContractTests } from "./storage-contract.ts";

runStorageContractTests(
  "unstorage (memory driver)",
  () => createUnstorageStorage({ storage: createStorage() }),
  { t: { describe, test, expect }, capabilities: { compareAndSwap: false, watch: false } },
);

describe("createUnstorageStorage (entitlements entry)", () => {
  test("reads keys an earlier release wrote with every `$` encoded", async () => {
    const raw = createStorage();
    // entitlements ≤ 0.1.1 encoded every `$` (and `:`) as %XX before handing keys to unstorage.
    await raw.setItem("ent:price%24usd%24", { v: 1 });
    const storage = createUnstorageStorage({ storage: raw });
    expect(await storage.getItem("ent/price$usd$")).toEqual({ v: 1 });
    expect(await storage.getKeys("ent/")).toEqual(["ent/price$usd$"]);
  });
});

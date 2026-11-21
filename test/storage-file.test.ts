import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, test } from "vitest";
import { isCompareAndSwap, isWatchable } from "../src/storage/contract.ts";
import { clearFileStorage, createFileStorage } from "../src/storage/file.ts";
import { runStorageContractTests } from "./storage-contract.ts";

const roots: string[] = [];

function freshDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "xtandard-entitlements-file-"));
  roots.push(dir);
  return join(dir, "store");
}

afterAll(async () => {
  await Promise.all(roots.map((dir) => clearFileStorage({ dir })));
});

runStorageContractTests("file", () => createFileStorage({ dir: freshDir() }), {
  t: { describe, test, expect },
  capabilities: { compareAndSwap: true, watch: { settleMs: 150 } },
});

describe("file storage (entitlements entry)", () => {
  it("is watchable and compare-and-swap capable", () => {
    const storage = createFileStorage({ dir: freshDir() });
    expect(isWatchable(storage)).toBe(true);
    expect(isCompareAndSwap(storage)).toBe(true);
  });

  it("clearFileStorage removes everything", async () => {
    const dir = freshDir();
    const storage = createFileStorage({ dir });
    await storage.setItem("ent/customers/a", { v: 1 });
    await clearFileStorage({ dir });
    expect(await storage.getKeys("ent/")).toEqual([]);
  });

  it("reads keys at the paths earlier releases wrote (encoded segments, .json leaves)", async () => {
    const dir = freshDir();
    await createFileStorage({ dir }).setItem("ent/customers/Acme", { v: 7 });
    const { readdir } = await import("node:fs/promises");
    expect(await readdir(join(dir, "ent", "customers"))).toEqual(["^acme.json"]);
    expect(await createFileStorage({ dir }).getItem("ent/customers/Acme")).toEqual({ v: 7 });
  });
});

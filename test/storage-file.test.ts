import { mkdtempSync } from "node:fs";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
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
  compareAndSwap: true,
});

describe("file storage extras", () => {
  it("is watchable and compare-and-swap capable", () => {
    const storage = createFileStorage({ dir: freshDir() });
    expect(isWatchable(storage)).toBe(true);
    expect(isCompareAndSwap(storage)).toBe(true);
  });

  it("getKeys on a missing base dir returns empty", async () => {
    const storage = createFileStorage({ dir: freshDir() });
    expect(await storage.getKeys("ent/")).toEqual([]);
  });

  it("clearFileStorage removes everything", async () => {
    const dir = freshDir();
    const storage = createFileStorage({ dir });
    await storage.setItem("ent/customers/a", { v: 1 });
    await clearFileStorage({ dir });
    expect(await storage.getKeys("ent/")).toEqual([]);
  });

  it("persists across instances pointed at the same dir", async () => {
    const dir = freshDir();
    await createFileStorage({ dir }).setItem("ent/customers/a", { v: 7 });
    expect(await createFileStorage({ dir }).getItem("ent/customers/a")).toEqual({ v: 7 });
  });

  it("writes atomically (no temp files left behind) and ignores non-json files", async () => {
    const dir = freshDir();
    const storage = createFileStorage({ dir });
    await Promise.all(
      Array.from({ length: 10 }, (_, i) => storage.setItem("ent/customers/a", { i })),
    );
    expect(await readdir(join(dir, "ent", "customers"))).toEqual(["a.json"]);
    expect((await storage.getItem<{ i: number }>("ent/customers/a"))?.i).toBe(9);
  });

  it("serializes compare-and-swap with writes in one process (no lost updates)", async () => {
    const storage = createFileStorage({ dir: freshDir() });
    await storage.setItem("ent/n", 0);
    const bump = async () => {
      for (;;) {
        const cur = (await storage.getItem<number>("ent/n")) ?? 0;
        if (await storage.compareAndSwap({ key: "ent/n", expected: cur, next: cur + 1 })) return;
      }
    };
    await Promise.all(Array.from({ length: 10 }, bump));
    expect(await storage.getItem("ent/n")).toBe(10);
  });

  it("surfaces non-ENOENT errors", async () => {
    const dir = freshDir();
    const storage = createFileStorage({ dir });
    // A directory where the key's file should be: reads and removes fail (EISDIR / EPERM).
    await mkdir(join(dir, "ent", "x.json"), { recursive: true });
    await expect(storage.getItem("ent/x")).rejects.toThrow();
    await expect(storage.removeItem("ent/x")).rejects.toThrow();
    // A file where a directory should be: walking fails with ENOTDIR only below it.
    await writeFile(join(dir, "plain"), "x");
    await expect(createFileStorage({ dir: join(dir, "plain") }).getKeys("")).rejects.toThrow();
  });

  it("keeps mixed-case, reserved-character and dot-segment keys distinct and inside the dir", async () => {
    const dir = freshDir();
    const storage = createFileStorage({ dir });
    const keys = [
      "ent/Acme",
      "ent/acme",
      "ent/a^b",
      "ent/q?:*|",
      "ent/../escape",
      "ent//empty",
      "ent/%",
    ];
    for (const k of keys) await storage.setItem(k, k);
    for (const k of keys) expect(await storage.getItem(k)).toBe(k);
    expect((await storage.getKeys("ent/")).sort()).toEqual([...keys].sort());
    expect(await readdir(dirname(dir))).toEqual(["store"]);
  });

  it("watch reports updates and removes under the prefix", async () => {
    const storage = createFileStorage({ dir: freshDir() });
    const events: string[] = [];
    const off = await storage.watch("ent/customers/", (e) => events.push(`${e.type}:${e.key}`));
    await storage.setItem("ent/customers/w", { v: 1 });
    await storage.setItem("ent/other/x", { v: 1 });
    await new Promise((r) => setTimeout(r, 150));
    await storage.removeItem("ent/customers/w");
    await new Promise((r) => setTimeout(r, 150));
    off();
    expect(events).toContain("update:ent/customers/w");
    expect(events).toContain("remove:ent/customers/w");
    expect(events.some((e) => e.includes("ent/other/"))).toBe(false);
  });
});

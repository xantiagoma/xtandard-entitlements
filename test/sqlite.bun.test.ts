/**
 * `bun:sqlite` drivers (storage + counters, and Drizzle over bun:sqlite). Runs
 * via `bun test` (bun:sqlite is unavailable under Node); the vitest-based
 * conformance suites run unchanged because Bun maps `vitest` to `bun:test`.
 *
 *   bun test test/sqlite.bun.test.ts
 */
import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { createDrizzleCounterStore } from "../src/counters/drizzle.ts";
import { createSqliteCounterStore } from "../src/counters/sqlite.ts";
import { sqliteCountersTable, sqliteEntitlementsTable } from "../src/drizzle/sqlite.ts";
import { isCompareAndSwap } from "../src/storage/contract.ts";
import { createDrizzleStorage } from "../src/storage/drizzle.ts";
import { createSqliteStorage } from "../src/storage/sqlite.ts";
import { runCounterContractTests } from "./counter-contract.ts";
import { runStorageContractTests } from "./storage-contract.ts";

runStorageContractTests("sqlite (bun:sqlite)", () => createSqliteStorage({ table: "kv" }), {
  compareAndSwap: true,
});
runCounterContractTests("sqlite (bun:sqlite)", () => createSqliteCounterStore(), { keys: true });

runStorageContractTests(
  "drizzle (bun:sqlite)",
  () => {
    const db = new Database(":memory:");
    db.run("CREATE TABLE xtandard_entitlements_kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    return createDrizzleStorage({ db: drizzle(db), table: sqliteEntitlementsTable() });
  },
  { compareAndSwap: true },
);
runCounterContractTests(
  "drizzle counters (bun:sqlite)",
  () => {
    const db = new Database(":memory:");
    db.run(
      "CREATE TABLE xtandard_entitlements_counters (key TEXT PRIMARY KEY, value REAL NOT NULL DEFAULT 0, applied REAL NOT NULL DEFAULT 0, expires_at INTEGER)",
    );
    return createDrizzleCounterStore({ db: drizzle(db), table: sqliteCountersTable() });
  },
  { keys: true },
);

describe("sqlite storage", () => {
  test("persists to a borrowed database and leaves it open", async () => {
    const db = new Database(":memory:");
    const storage = createSqliteStorage({ database: db });
    await storage.setItem("ent/customers/a", { b: 1, a: 2 });
    expect(isCompareAndSwap(storage)).toBe(true);
    storage.close();
    const row = db.query("SELECT value FROM xtandard_entitlements_kv").get() as { value: string };
    expect(row.value).toBe('{"a":2,"b":1}'); // canonical JSON
    db.close();
  });

  test("rejects unsafe table names", () => {
    expect(() => createSqliteStorage({ table: "bad; drop" })).toThrow();
  });
});

describe("sqlite counters", () => {
  test("expiry, claims and sweeps follow the injected clock", async () => {
    let t = 1_000;
    const c = createSqliteCounterStore({ now: () => t });
    await c.add("usage/e", 5, { expiresAt: 2_000 });
    expect(await c.claim("idem/x", 500)).toBe(true);
    expect(await c.claim("idem/x", 500)).toBe(false);
    t = 2_000;
    expect(await c.get(["usage/e"])).toEqual([0]);
    expect(await c.claim("idem/x", 500)).toBe(true);
    t = 5_000;
    expect(await c.purgeExpired()).toBe(2);
    await c.close();
  });

  test("a borrowed database survives close()", async () => {
    const db = new Database(":memory:");
    const c = createSqliteCounterStore({ database: db, table: "ctr" });
    await c.add("usage/x", 2);
    await c.close();
    expect((db.query("SELECT value FROM ctr").get() as { value: number }).value).toBe(2);
    db.close();
  });
});

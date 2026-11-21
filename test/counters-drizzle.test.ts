import { createClient } from "@libsql/client";
import { drizzle as drizzleLibsql } from "drizzle-orm/libsql";
import { drizzle } from "drizzle-orm/pglite";
import { describe, expect, test } from "vitest";
import { createDrizzleCounterStore } from "../src/counters/drizzle.ts";
import { pgCountersTable } from "../src/drizzle/pg.ts";
import { sqliteCountersTable } from "../src/drizzle/sqlite.ts";
import { runCounterContractTests } from "./counter-contract.ts";
import { createTableSql } from "./drizzle-ddl.ts";
import { pglite, uniqueTable } from "./pglite.ts";

const SQLITE_DDL =
  "CREATE TABLE xtandard_entitlements_counters (key TEXT PRIMARY KEY, value REAL NOT NULL DEFAULT 0, applied REAL NOT NULL DEFAULT 0, expires_at INTEGER)";

async function pgStore(now?: () => number) {
  const table = pgCountersTable(uniqueTable("counters"));
  await pglite().exec(createTableSql(table));
  return createDrizzleCounterStore({ db: drizzle(pglite()), table, now });
}

async function sqliteStore(now?: () => number) {
  const client = createClient({ url: ":memory:" });
  await client.execute(SQLITE_DDL);
  return createDrizzleCounterStore({
    db: drizzleLibsql(client),
    table: sqliteCountersTable(),
    now,
  });
}

runCounterContractTests("drizzle (pg/pglite)", () => pgStore(), { keys: true, concurrency: 20 });
runCounterContractTests("drizzle (sqlite/libsql)", () => sqliteStore(), { keys: true });

for (const [name, make] of [
  ["pg", pgStore],
  ["sqlite", sqliteStore],
] as const) {
  describe(`drizzle counters (${name}): expiry, claims, exact keys`, () => {
    test("values and claims expire by the injected clock", async () => {
      let t = 1_000;
      const c = await make(() => t);
      await c.add("usage/e", 5, { expiresAt: 2_000 });
      expect(await c.add("usage/e", 9, { max: 10 })).toEqual({ applied: 0, value: 5 });
      expect(await c.claim("idem/x", 500)).toBe(true);
      expect(await c.claim("idem/x", 500)).toBe(false);
      await c.set("cap/s", 3, { expiresAt: 5_000 });
      t = 2_000;
      expect(await c.get(["usage/e", "cap/s"])).toEqual([0, 3]);
      expect(await c.claim("idem/x", 500)).toBe(true);
      expect(await c.keys("")).toEqual(["cap/s"]);
      t = 9_000;
      await c.purgeExpired();
      expect(await c.claim("idem/x", 500)).toBe(true);
      await c.release("idem/x");
      expect(await c.claim("idem/x", 500)).toBe(true);
    });

    test("keys are case- and metacharacter-exact", async () => {
      const c = await make();
      for (const k of [
        "usage/A/x",
        "usage/a/x",
        "usage/%/x",
        "usage/_/x",
        "usage/*/x",
        "usage/[/x",
      ]) {
        await c.add(k, 1);
      }
      expect(await c.get(["usage/A/x", "usage/a/x"])).toEqual([1, 1]);
      expect(await c.keys("usage/A/")).toEqual(["usage/A/x"]);
      expect(await c.keys("usage/%/")).toEqual(["usage/%/x"]);
      expect(await c.keys("usage/_/")).toEqual(["usage/_/x"]);
      expect(await c.keys("usage/*/")).toEqual(["usage/*/x"]);
      expect(await c.keys("usage/[/")).toEqual(["usage/[/x"]);
      expect(await c.get([])).toEqual([]);
      await c.delete([]);
    });
  });
}

describe("drizzle counters", () => {
  test("refuses a MySQL-looking db without transaction/execute", async () => {
    const c = createDrizzleCounterStore({
      db: {},
      table: pgCountersTable(),
      dialect: "mysql",
    });
    await expect(c.add("usage/x", 1)).rejects.toThrow(/transaction/);
  });
});

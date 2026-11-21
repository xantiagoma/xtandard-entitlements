import { createClient } from "@libsql/client";
import { getTableName } from "drizzle-orm";
import { drizzle as drizzleLibsql } from "drizzle-orm/libsql";
import { text } from "drizzle-orm/pg-core";
import { drizzle } from "drizzle-orm/pglite";
import { describe, expect, test } from "vitest";
import { mysqlCountersTable, mysqlEntitlementsTable } from "../src/drizzle/mysql.ts";
import { pgCountersTable, pgEntitlementsTable } from "../src/drizzle/pg.ts";
import { sqliteCountersTable, sqliteEntitlementsTable } from "../src/drizzle/sqlite.ts";
import { isWatchable } from "../src/storage/contract.ts";
import {
  affectedRows,
  createDrizzleStorage,
  detectDrizzleDialect,
} from "../src/storage/drizzle.ts";
import { pglite, uniqueTable } from "./pglite.ts";
import { runStorageContractTests } from "./storage-contract.ts";

/** A fresh KV table in the shared PGlite. */
async function pgTable() {
  const name = uniqueTable("kv");
  await pglite().exec(
    `CREATE TABLE ${name} (key text COLLATE "C" PRIMARY KEY, value jsonb NOT NULL)`,
  );
  return pgEntitlementsTable(name);
}

/**
 * The shared contract suite over a Postgres Drizzle database (in-process
 * PGlite) and a SQLite one (libSQL `:memory:`). The test creates the table
 * (mirroring a consumer's migration — the adapter issues no DDL); this also
 * proves real Drizzle dbs satisfy the adapter's structural `db` type.
 */
runStorageContractTests(
  "drizzle (pg/pglite)",
  async () => createDrizzleStorage({ db: drizzle(pglite()), table: await pgTable() }),
  { compareAndSwap: true },
);

runStorageContractTests(
  "drizzle (sqlite/libsql)",
  async () => {
    const client = createClient({ url: ":memory:" });
    await client.execute(
      "CREATE TABLE entitlements_kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
    );
    return createDrizzleStorage({
      db: drizzleLibsql(client),
      table: sqliteEntitlementsTable("entitlements_kv"),
    });
  },
  { compareAndSwap: true },
);

describe("createDrizzleStorage", () => {
  test("detects the dialect from the db, or refuses", () => {
    expect(detectDrizzleDialect(drizzle(pglite()))).toBe("pg");
    expect(detectDrizzleDialect(drizzleLibsql(createClient({ url: ":memory:" })))).toBe("sqlite");
    expect(() => detectDrizzleDialect({})).toThrow(/dialect/);
    expect(() => detectDrizzleDialect(null)).toThrow(/dialect/);
  });

  test("an explicit dialect skips detection", async () => {
    const storage = createDrizzleStorage({
      db: drizzle(pglite()),
      table: await pgTable(),
      dialect: "pg",
    });
    await storage.setItem("ent/k", { n: 1 });
    await storage.setItem("ent/k", { n: 2 });
    expect(await storage.getItem("ent/k")).toEqual({ n: 2 });
    expect(isWatchable(storage)).toBe(false);
  });

  test("affectedRows reads mysql2 and PlanetScale result shapes", () => {
    expect(affectedRows([{ affectedRows: 1 }, []])).toBe(1);
    expect(affectedRows({ rowsAffected: 2 })).toBe(2);
    expect(affectedRows(undefined)).toBe(0);
  });
});

describe("table factories — shape", () => {
  test("all three dialects expose the required columns", () => {
    for (const t of [pgEntitlementsTable(), mysqlEntitlementsTable(), sqliteEntitlementsTable()]) {
      expect(t.key).toBeDefined();
      expect(t.value).toBeDefined();
    }
    for (const t of [pgCountersTable(), mysqlCountersTable(), sqliteCountersTable()]) {
      expect(t.key && t.value && t.applied && t.expiresAt).toBeDefined();
      expect(t.expiresAt.name).toBe("expires_at");
    }
  });

  test("default table names say entitlements", () => {
    for (const t of [pgEntitlementsTable(), mysqlEntitlementsTable(), sqliteEntitlementsTable()]) {
      expect(getTableName(t)).toBe("xtandard_entitlements_kv");
    }
    for (const t of [pgCountersTable(), mysqlCountersTable(), sqliteCountersTable()]) {
      expect(getTableName(t)).toBe("xtandard_entitlements_counters");
    }
  });

  test("keys are case-sensitive by construction (collations)", () => {
    expect(pgEntitlementsTable().key.getSQLType()).toBe('text COLLATE "C"');
    expect(pgCountersTable().key.getSQLType()).toBe('text COLLATE "C"');
    expect(mysqlEntitlementsTable().key.getSQLType()).toBe(
      "varchar(512) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin",
    );
    expect(mysqlCountersTable("c", { keyLength: 191 }).key.getSQLType()).toContain("varchar(191)");
  });

  test("schema, extraColumns and extraIndexes extend the tables", () => {
    const t = pgEntitlementsTable("kv", {
      schema: "billing",
      extraColumns: () => ({ tenantId: text("tenant_id") }),
    });
    expect((t as unknown as Record<string, unknown>).tenantId).toBeDefined();
    // Accepting extraIndexes must not throw (Drizzle invokes it lazily at SQL-gen).
    expect(() => pgCountersTable("c", { extraIndexes: () => [] })).not.toThrow();
    expect(() => mysqlEntitlementsTable("kv", { extraIndexes: () => [] })).not.toThrow();
    expect(() => sqliteCountersTable("c", { extraIndexes: () => [] })).not.toThrow();
  });
});

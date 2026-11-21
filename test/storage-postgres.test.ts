import { PGlite } from "@electric-sql/pglite";
import { afterAll, describe, expect, test } from "vitest";
import {
  createPostgresStorage,
  postgresStorageSchema,
  type PostgresEntitlementsStorage,
} from "../src/storage/postgres.ts";
import { isCompareAndSwap } from "../src/storage/contract.ts";
import { pglite, uniqueTable } from "./pglite.ts";
import { runStorageContractTests } from "./storage-contract.ts";

const CAPABILITIES = {
  t: { describe, test, expect },
  capabilities: { compareAndSwap: true, watch: false },
};

/**
 * Run the shared contract suite against the Postgres adapter, backed by an
 * in-process PGlite instance so no server is required and the tests always
 * run. Each invocation gets a FRESH PGlite for isolation.
 */
runStorageContractTests(
  "postgres (pglite)",
  async () => createPostgresStorage({ client: pglite(), table: uniqueTable("kv") }),
  CAPABILITIES,
);

/** Adapter-specific behaviour against in-process PGlite. */
describe("createPostgresStorage (pglite)", () => {
  test("defaults to the xtandard_entitlements_kv table", async () => {
    const client = new PGlite();
    const storage = createPostgresStorage({ client });
    await storage.setItem("ent/customers/org_1", { id: "org_1" });
    const { rows } = await client.query<{ key: string }>(
      "SELECT key FROM xtandard_entitlements_kv",
    );
    expect(rows.map((r) => r.key)).toEqual(["ent/customers/org_1"]);
    expect(isCompareAndSwap(storage)).toBe(true);
  });
});

describe("createPostgresStorage shape", () => {
  test("rejects an unsafe table name", () => {
    expect(() => createPostgresStorage({ client: pglite(), table: "bad; DROP TABLE x" })).toThrow(
      /Invalid table/,
    );
  });

  test("postgresStorageSchema emits the C-collated DDL", () => {
    expect(postgresStorageSchema()).toContain("xtandard_entitlements_kv");
    expect(postgresStorageSchema("t")).toContain('key text COLLATE "C" PRIMARY KEY');
  });

  test("close() with a borrowed client is a safe no-op", async () => {
    const s = createPostgresStorage({ client: pglite(), table: "kv" });
    await expect(s.close()).resolves.toBeUndefined();
  });
});

/**
 * Optional live-server suite — runs only when `POSTGRES_URL` is set, so CI
 * without a Postgres server simply skips it. Cleans up after itself.
 */
describe.skipIf(!process.env.POSTGRES_URL)("createPostgresStorage (live)", () => {
  const run = Date.now();
  let n = 0;
  const opened: PostgresEntitlementsStorage[] = [];

  runStorageContractTests(
    "postgres (live)",
    () => {
      const s = createPostgresStorage({
        connectionString: process.env.POSTGRES_URL,
        table: `xtandard_entitlements_test_${run}_${n++}`,
      });
      opened.push(s);
      return s;
    },
    CAPABILITIES,
  );

  afterAll(async () => {
    // A storage a case already closed can't run queries: drop the run's tables directly.
    for (const s of opened) await s.close().catch(() => {});
    const { Pool } = await import("pg");
    const pool = new Pool({ connectionString: process.env.POSTGRES_URL });
    for (let i = 0; i < n; i++) {
      await pool.query(`DROP TABLE IF EXISTS xtandard_entitlements_test_${run}_${i}`);
    }
    await pool.end();
  });
});

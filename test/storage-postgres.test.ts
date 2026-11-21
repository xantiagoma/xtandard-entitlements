import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  createPostgresStorage,
  postgresStorageSchema,
  type PostgresEntitlementsStorage,
} from "../src/storage/postgres.ts";
import { isCompareAndSwap } from "../src/storage/contract.ts";
import { pglite, uniqueTable } from "./pglite.ts";
import { runStorageContractTests } from "./storage-contract.ts";

/**
 * Run the shared contract suite against the Postgres adapter, backed by an
 * in-process PGlite instance so no server is required and the tests always
 * run. Each invocation gets a FRESH PGlite for isolation.
 */
runStorageContractTests(
  "postgres (pglite)",
  async () => createPostgresStorage({ client: pglite(), table: uniqueTable("kv") }),
  { compareAndSwap: true },
);

/** Adapter-specific behaviour against in-process PGlite. */
describe("createPostgresStorage (pglite)", () => {
  let storage: PostgresEntitlementsStorage;

  beforeAll(() => {
    storage = createPostgresStorage({ client: pglite(), table: uniqueTable("entitlements_test") });
  });

  test("round-trips a nested object value and is CAS-capable", async () => {
    const value = { id: "org_1", revision: 3, subscriptions: [{ plan: "pro" }] };
    await storage.setItem("ent/customers/org_1", value);
    expect(await storage.getItem("ent/customers/org_1")).toEqual(value);
    expect(isCompareAndSwap(storage)).toBe(true);
  });

  test("compareAndSwap compares jsonb structurally (key order is irrelevant)", async () => {
    await storage.setItem("ent/cas/order", { a: 1, b: { c: [1, 2] } });
    expect(
      await storage.compareAndSwap({
        key: "ent/cas/order",
        expected: { b: { c: [1, 2] }, a: 1 },
        next: { a: 2 },
      }),
    ).toBe(true);
    expect(await storage.getItem("ent/cas/order")).toEqual({ a: 2 });
  });

  test("handles deeply nested keys", async () => {
    await storage.setItem("ent/links/stripe/cus_1", "org_1");
    expect(await storage.getKeys("ent/links/stripe/")).toEqual(["ent/links/stripe/cus_1"]);
  });

  test("parses string jsonb values defensively", async () => {
    const client = {
      query: async (text: string) =>
        text.startsWith("SELECT")
          ? { rows: [{ value: '{"x":1}' }, { value: "not json" }] }
          : { rows: [] },
    };
    const s = createPostgresStorage({ client });
    expect(await s.getItem("k")).toEqual({ x: 1 });
  });

  test("retries the DDL after a failure", async () => {
    let fail = true;
    const pg = pglite();
    const table = uniqueTable();
    const client = {
      query: async (text: string, params?: unknown[]) => {
        if (fail && text.startsWith("CREATE")) {
          fail = false;
          throw new Error("transient");
        }
        return pg.query(text, params) as Promise<{ rows: Array<Record<string, unknown>> }>;
      },
    };
    const s = createPostgresStorage({ client, table });
    await expect(s.getItem("k")).rejects.toThrow("transient");
    expect(await s.getItem("k")).toBeNull();
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
    { compareAndSwap: true },
  );

  afterAll(async () => {
    for (const s of opened) {
      for (const key of await s.getKeys("")) await s.removeItem(key);
      await s.close();
    }
  });
});

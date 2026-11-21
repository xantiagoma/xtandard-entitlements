import { createClient } from "@libsql/client";
import { afterAll, describe, expect, test } from "vitest";
import { createLibsqlCounterStore } from "../src/counters/libsql.ts";
import {
  createPostgresCounterStore,
  postgresCounterSchema,
  type PostgresCounterStore,
} from "../src/counters/postgres.ts";
import { appliedSql, sqlNumber } from "../src/counters/sql.ts";
import type { LibsqlClientLike } from "../src/storage/libsql.ts";
import { runCounterContractTests } from "./counter-contract.ts";
import { pglite, uniqueTable } from "./pglite.ts";

runCounterContractTests(
  "postgres (pglite)",
  () => createPostgresCounterStore({ client: pglite(), table: uniqueTable() }),
  { keys: true, concurrency: 20 },
);
runCounterContractTests("libsql (:memory:)", () => createLibsqlCounterStore({ url: ":memory:" }), {
  keys: true,
});

describe.skipIf(!process.env.POSTGRES_URL)("postgres counters (live)", () => {
  const run = Date.now();
  let n = 0;
  const opened: PostgresCounterStore[] = [];
  runCounterContractTests(
    "postgres (live)",
    () => {
      const c = createPostgresCounterStore({
        connectionString: process.env.POSTGRES_URL,
        table: `xtandard_entitlements_counters_test_${run}_${n++}`,
      });
      opened.push(c);
      return c;
    },
    { keys: true, concurrency: 100 },
  );
  afterAll(async () => {
    for (let i = 0; i < n; i++) {
      await opened[0]?.purgeExpired().catch(() => {});
    }
    const { Pool } = await import("pg");
    const pool = new Pool({ connectionString: process.env.POSTGRES_URL });
    for (let i = 0; i < n; i++) {
      await pool.query(`DROP TABLE IF EXISTS xtandard_entitlements_counters_test_${run}_${i}`);
    }
    await pool.end();
    for (const c of opened) await c.close();
  });
});

/** Expiry, claims and sweeps against the injected clock, for both SQL dialects. */
for (const [name, make] of [
  [
    "postgres",
    (now: () => number) =>
      createPostgresCounterStore({ client: pglite(), table: uniqueTable(), now }),
  ],
  ["libsql", (now: () => number) => createLibsqlCounterStore({ url: ":memory:", now })],
] as const) {
  describe(`${name} counters: expiry and claims`, () => {
    test("values expire by the clock and restart with the new hint", async () => {
      let t = 1_000;
      const c = make(() => t);
      expect(await c.add("usage/e", 5, { expiresAt: 2_000 })).toEqual({ applied: 5, value: 5 });
      expect(await c.add("usage/e", 1)).toEqual({ applied: 1, value: 6 }); // keeps the hint
      expect(await c.add("usage/e", 9, { max: 10 })).toEqual({ applied: 0, value: 6 });
      t = 2_000;
      expect(await c.get(["usage/e"])).toEqual([0]);
      expect(await c.keys("usage/")).toEqual([]);
      expect(await c.add("usage/e", 2, { max: 10 })).toEqual({ applied: 2, value: 2 });
      t = 10_000; // the restarted value has no hint: it never expires
      expect(await c.get(["usage/e"])).toEqual([2]);
      await c.set("usage/s", 4, { expiresAt: 20_000 });
      expect(await c.get(["usage/s", "usage/missing"])).toEqual([4, 0]);
      t = 20_000;
      expect(await c.get(["usage/s"])).toEqual([0]);
    });

    test("a refusal keeps the old expiry; a refused new key reads 0", async () => {
      let t = 0;
      const c = make(() => t);
      await c.add("usage/r", 5, { expiresAt: 100 });
      expect(await c.add("usage/r", 9, { max: 10, expiresAt: 500 })).toEqual({
        applied: 0,
        value: 5,
      });
      t = 100;
      expect(await c.get(["usage/r"])).toEqual([0]);
      expect(await c.add("usage/new", 11, { max: 10 })).toEqual({ applied: 0, value: 0 });
      expect(await c.get(["usage/new"])).toEqual([0]);
    });

    test("claims expire by TTL and stay out of keys()", async () => {
      let t = 0;
      const c = make(() => t);
      expect(await c.claim("usage/k", 100)).toBe(true);
      expect(await c.claim("usage/k", 100)).toBe(false);
      await c.add("usage/k", 1);
      expect(await c.keys("")).toEqual(["usage/k"]);
      t = 100;
      expect(await c.claim("usage/k", 100)).toBe(true);
      expect(await c.claim("usage/k", 100)).toBe(false);
      t = 250;
      expect(await c.purgeExpired()).toBe(1);
      expect(await c.claim("usage/k", 100)).toBe(true);
    });

    test("keys and counters are case- and metacharacter-exact", async () => {
      const c = make(Date.now);
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
      await c.delete([]);
      expect(await c.get([])).toEqual([]);
    });

    test("large integers stay exact and fractional bounds use double math", async () => {
      const c = make(Date.now);
      const big = 2 ** 53 - 2;
      expect(await c.add("usage/big", big)).toEqual({ applied: big, value: big });
      expect(await c.add("usage/big", 1, { max: 2 ** 53 - 1 })).toEqual({
        applied: 1,
        value: 2 ** 53 - 1,
      });
      await c.add("usage/frac", 0.1);
      expect((await c.add("usage/frac", 0.2)).value).toBe(0.1 + 0.2);
      expect(await c.add("usage/tiny", 1e-7)).toEqual({ applied: 1e-7, value: 1e-7 });
      expect(await c.add("usage/huge", 1e21)).toEqual({ applied: 1e21, value: 1e21 });
    });
  });
}

describe("postgres counters", () => {
  test("createTable: false skips the DDL (apply postgresCounterSchema yourself)", async () => {
    const pg = pglite();
    const table = uniqueTable();
    const c = createPostgresCounterStore({ pool: pg, createTable: false, table });
    await expect(c.add("usage/x", 1)).rejects.toThrow();
    await pg.exec(postgresCounterSchema(table));
    expect(await c.add("usage/x", 1)).toEqual({ applied: 1, value: 1 });
    expect(postgresCounterSchema()).toContain(
      'xtandard_entitlements_counters (key text COLLATE "C"',
    );
  });

  test("retries the DDL after a failure and rejects unsafe tables", async () => {
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
    const c = createPostgresCounterStore({ client, table });
    await expect(c.get(["k"])).rejects.toThrow("transient");
    expect(await c.get(["k"])).toEqual([0]);
    expect(() => createPostgresCounterStore({ client, table: "x; drop" })).toThrow(/Invalid/);
    await expect(c.close()).resolves.toBeUndefined();
  });
});

describe("libsql counters", () => {
  test("borrowed client stays open after close()", async () => {
    const client = createClient({ url: ":memory:" });
    const c = createLibsqlCounterStore({ client: client as unknown as LibsqlClientLike });
    await c.add("usage/x", 2);
    await c.close();
    expect(
      (await client.execute("SELECT value FROM xtandard_entitlements_counters")).rows[0]?.value,
    ).toBe(2);
    client.close();
  });
});

describe("sql literals", () => {
  test("numbers are finite literals; negatives are parenthesized", () => {
    expect(sqlNumber(3)).toBe("3");
    expect(sqlNumber(-2.5)).toBe("(-2.5)");
    expect(sqlNumber(1e21)).toBe("1e+21");
    expect(() => sqlNumber(Number.NaN)).toThrow();
    expect(appliedSql("c", 1, {})).toBe("1");
    expect(appliedSql("c", -1, { max: 3 })).toBe("(-1)");
  });
});

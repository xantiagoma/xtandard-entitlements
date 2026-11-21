/**
 * Engine-level integration: the same short scenario — concurrent consumption
 * up to a limit, one-off grants, reserve/settle, idempotency — against every
 * counter driver available in-process (plus Redis / Mongo / Postgres when
 * their URLs are set) on a compare-and-swap state storage, proving the ports
 * compose.
 */
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/pglite";
import { describe, expect, it } from "vitest";
import type { CounterStore } from "../src/counters/contract.ts";
import { createDrizzleCounterStore } from "../src/counters/drizzle.ts";
import { createKvCounterStore } from "../src/counters/kv.ts";
import { createLibsqlCounterStore } from "../src/counters/libsql.ts";
import { createMemoryCounterStore } from "../src/counters/memory.ts";
import { createMongoCounterStore } from "../src/counters/mongodb.ts";
import { createPostgresCounterStore } from "../src/counters/postgres.ts";
import { createRedisCounterStore } from "../src/counters/redis.ts";
import { pgCountersTable } from "../src/drizzle/pg.ts";
import { isCompareAndSwap, type EntitlementsStorage } from "../src/storage/contract.ts";
import { createLibsqlStorage, type LibsqlClientLike } from "../src/storage/libsql.ts";
import { createPostgresStorage } from "../src/storage/postgres.ts";
import { createTestEntitlements } from "../src/testing.ts";
import { createTableSql } from "./drizzle-ddl.ts";
import { catalog } from "./fixtures.ts";
import { pglite, uniqueTable } from "./pglite.ts";

type Make = () => Promise<{ counters: CounterStore; storage: EntitlementsStorage }>;

const run = Date.now();
const drivers: Array<[string, Make]> = [
  [
    "postgres counters + postgres storage (pglite)",
    async () => {
      return {
        counters: createPostgresCounterStore({ client: pglite(), table: uniqueTable() }),
        storage: createPostgresStorage({ client: pglite(), table: uniqueTable() }),
      };
    },
  ],
  [
    "libsql counters + libsql storage",
    async () => {
      // TODO(kit#24): drop the cast once `LibsqlClientLike.batch` accepts a real Client.
      const client = createClient({ url: ":memory:" }) as unknown as LibsqlClientLike;
      return {
        counters: createLibsqlCounterStore({ client }),
        storage: createLibsqlStorage({ client }),
      };
    },
  ],
  [
    "drizzle pg counters + postgres storage (pglite)",
    async () => {
      const table = pgCountersTable(uniqueTable());
      await pglite().exec(createTableSql(table));
      return {
        counters: createDrizzleCounterStore({ db: drizzle(pglite()), table }),
        storage: createPostgresStorage({ client: pglite(), table: uniqueTable() }),
      };
    },
  ],
  [
    "kv counters over postgres CAS storage (pglite)",
    async () => {
      const storage = createPostgresStorage({ client: pglite(), table: uniqueTable() });
      return { counters: createKvCounterStore(storage), storage };
    },
  ],
  [
    "memory counters + libsql storage",
    async () => ({
      counters: createMemoryCounterStore(),
      storage: createLibsqlStorage({ url: ":memory:" }),
    }),
  ],
];
if (process.env.REDIS_URL) {
  drivers.push([
    "redis counters + postgres storage (pglite)",
    async () => ({
      counters: createRedisCounterStore({
        url: process.env.REDIS_URL,
        prefix: `xtandard-entitlements-engine:${run}:${Math.random()}`,
      }),
      storage: createPostgresStorage({ client: pglite(), table: uniqueTable() }),
    }),
  ]);
}
if (process.env.MONGO_URL) {
  drivers.push([
    "mongodb counters + postgres storage (pglite)",
    async () => ({
      counters: createMongoCounterStore({
        url: process.env.MONGO_URL,
        dbName: `entitlements_engine_${run}`,
        collectionName: `c_${Math.random().toString(36).slice(2)}`,
      }),
      storage: createPostgresStorage({ client: pglite(), table: uniqueTable() }),
    }),
  ]);
}
if (process.env.POSTGRES_URL) {
  drivers.push([
    "postgres counters + postgres storage (live)",
    async () => {
      const n = Math.random().toString(36).slice(2);
      return {
        counters: createPostgresCounterStore({
          connectionString: process.env.POSTGRES_URL,
          table: `xtandard_entitlements_engine_c_${n}`,
        }),
        storage: createPostgresStorage({
          connectionString: process.env.POSTGRES_URL,
          table: `xtandard_entitlements_engine_s_${n}`,
        }),
      };
    },
  ]);
}

describe.each(drivers)("engine over %s", (_name, make) => {
  it("concurrent consumption never passes the limit; grants, reserve/settle, idempotency", async () => {
    const { counters, storage } = await make();
    expect(isCompareAndSwap(storage)).toBe(true);
    const { ent } = createTestEntitlements({ catalog, storage, counters, usageSeries: false });
    await ent.subscribe("org", { plan: "free" });

    // exports: 5/day on free — 12 parallel consumers, exactly 5 succeed.
    const results = await Promise.all(
      Array.from({ length: 12 }, () => ent.consume("org", "exports")),
    );
    expect(results.filter((r) => r.allowed)).toHaveLength(5);
    expect((await ent.check("org", "exports")).used).toBe(5);

    // api_calls: 1000 allowance + a 50 grant, drained in order; a refusal counts nothing.
    await ent.grant("org", { feature: "api_calls", amount: 50 });
    expect((await ent.consume("org", "api_calls", 1_000)).allowed).toBe(true);
    expect((await ent.consume("org", "api_calls", 60)).allowed).toBe(false);
    expect((await ent.check("org", "api_calls")).remaining).toBe(50);
    expect((await ent.consume("org", "api_calls", 50)).remaining).toBe(0);

    // idempotency: the same key applies once.
    const first = await ent.consume("org2", "api_calls", 10, { idempotencyKey: "req-1" });
    const again = await ent.consume("org2", "api_calls", 10, { idempotencyKey: "req-1" });
    expect(first.allowed && again.duplicate).toBe(true);
    expect((await ent.check("org2", "api_calls")).used).toBe(10);

    // reserve / settle refunds the unused part.
    const r = await ent.reserve("org2", "api_calls", 100);
    expect((await ent.check("org2", "api_calls")).used).toBe(110);
    await ent.settle(r.reservation!.id, 40);
    expect((await ent.check("org2", "api_calls")).used).toBe(50);

    // revisioned customer writes went through compare-and-swap.
    await ent.subscribe("org", { plan: "pro" });
    expect((await ent.check("org", "export_pdf")).allowed).toBe(true);
    await (counters as { close?: () => Promise<void> }).close?.();
  });
});

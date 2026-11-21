/**
 * Split planes: customer state in **Postgres**, usage counters in **Redis**,
 * and write-behind (**buffered**) counters for a soft, high-volume meter —
 * shown across two "app instances" sharing the same backends.
 *
 *   docker compose up -d     # Postgres on :55432, Redis on :56379
 *   bun run demo             # or, from the repo root: bun run examples:postgres-redis --demo
 *   docker compose down -v
 *
 * DATABASE_URL / REDIS_URL override the compose defaults. Without reachable
 * services the demo prints how to start them and exits 0 (skipped).
 */
import { createEntitlements, keys, type CustomerState } from "@xtandard/entitlements";
import { defineCatalog, feature } from "@xtandard/entitlements/catalog";
import { createBufferedCounterStore } from "@xtandard/entitlements/counters/buffered";
import { createRedisCounterStore } from "@xtandard/entitlements/counters/redis";
import { createPostgresStorage } from "@xtandard/entitlements/storage/postgres";
import { catalog } from "../../shared/catalog.ts";
import { equal, info, runDemo, step } from "../../shared/demo-kit.ts";

const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgres://entitlements:entitlements@localhost:55432/entitlements";
const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:56379";

// The shared catalog, with `api_calls` switched to write-behind metering: a soft
// meter where a small overshoot across instances is fine (never seats or credits).
const softCatalog = defineCatalog({
  features: {
    ...catalog.features,
    api_calls: feature.metered({
      name: "API calls",
      unit: "call",
      reset: "month",
      metering: "buffered",
    }),
  },
  plans: catalog.plans,
  addons: catalog.addons,
});

/** One app instance: its own connections, cache and write-behind buffer. */
function createInstance() {
  const storage = createPostgresStorage({ connectionString: DATABASE_URL });
  const strict = createRedisCounterStore({ url: REDIS_URL });
  const buffered = createBufferedCounterStore(strict, { flushInterval: "1s", closeInner: false });
  const ent = createEntitlements({
    catalog: softCatalog,
    storage, // customers, subscriptions, grants: durable, revisioned (compare-and-swap)
    counters: { default: strict, buffered }, // every strict consume = one Redis round trip
  });
  return {
    ent,
    buffered,
    storage,
    async close() {
      await ent.close(); // flushes the buffer
      await buffered.close();
      await strict.close();
      await storage.close();
    },
  };
}

/** Resolve within `ms`, or reject. */
const within = <T>(ms: number, p: Promise<T>) =>
  Promise.race([
    p,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout")), ms)),
  ]);

/** Are both services reachable? (Probes with throwaway clients.) */
async function servicesUp(): Promise<boolean> {
  const { Client } = await import("pg");
  const pg = new Client({ connectionString: DATABASE_URL });
  const { createClient } = await import("redis");
  const redis = createClient({ url: REDIS_URL, socket: { reconnectStrategy: false } });
  redis.on("error", () => {});
  try {
    await within(2_000, pg.connect());
    await within(2_000, redis.connect());
    return true;
  } catch {
    return false;
  } finally {
    await pg.end().catch(() => {});
    if (redis.isOpen) await redis.quit().catch(() => {});
  }
}

if (!(await servicesUp())) {
  console.log(`⏭  postgres-redis: skipped — Postgres (${DATABASE_URL}) or Redis (${REDIS_URL}) is not reachable.
   Start them with:  cd examples/postgres-redis && docker compose up -d
   (or set DATABASE_URL / REDIS_URL), then run the demo again.`);
  process.exit(0);
}

runDemo("Postgres state + Redis counters × @xtandard/entitlements", async () => {
  const run = Date.now().toString(36); // fresh customer ids per run (the data persists)
  const org = `org_pg_${run}`;
  const a = createInstance();
  const b = createInstance();

  try {
    step("State lives in Postgres: instance A writes, instance B reads");
    await a.ent.updateCustomer(org, { name: "Postgres Inc." });
    await a.ent.subscribe(org, { plan: "pro" });
    const seen = await b.ent.entitlements(org);
    equal(
      seen.plans.map((p) => p.plan),
      ["pro"],
      "B resolves the plan A wrote",
    );
    // One jsonb row per customer in xtandard_entitlements_kv, revisioned for compare-and-swap.
    const row = await a.storage.getItem<CustomerState>(keys.customerKey(org));
    equal(row?.revision, 2, `row ${keys.customerKey(org)} at revision 2`);

    step("Strict counters in Redis: 20 concurrent seat requests across both instances");
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) => (i % 2 ? a : b).ent.consume(org, "seats")),
    );
    equal(results.filter((r) => r.allowed).length, 10, "exactly 10 seats granted (Pro: 10)");
    equal((await b.ent.check(org, "seats")).used, 10, "never past the limit, refusals not counted");

    step("Buffered counters: a soft meter decided locally, flushed in batches");
    for (let i = 0; i < 100; i++) await a.ent.consume(org, "api_calls");
    const last = await a.ent.consume(org, "api_calls");
    equal([last.buffered, last.used], [true, 101], "decided in memory on A (buffered: true)");
    info(`A has ${a.buffered.pendingKeys()} key(s) waiting to be flushed`);
    equal((await b.ent.check(org, "api_calls")).used, 0, "B can't see it yet (not flushed)");
    await a.buffered.flush(); // the 1 s timer would do this; ent.close() does too
    // B caches what it read for `refreshAfter` (5 s); a new instance reads Redis now.
    const fresh = createInstance();
    equal((await fresh.ent.check(org, "api_calls")).used, 101, "after the flush: one Redis add");
    await fresh.close();
  } finally {
    await a.close();
    await b.close();
  }
});

# Postgres + Redis × @xtandard/entitlements

**Split planes**: customer state (subscriptions, grants, overrides) in Postgres, usage counters in
Redis, plus **write-behind counters** for a soft, high-volume meter — across two app instances
sharing the same backends ([`src/demo.ts`](./src/demo.ts)).

```ts
const ent = createEntitlements({
  catalog, // api_calls: feature.metered({ reset: "month", metering: "buffered" })
  storage: createPostgresStorage({ connectionString: process.env.DATABASE_URL }),
  counters: {
    default: strict, // createRedisCounterStore({ url: process.env.REDIS_URL })
    buffered: createBufferedCounterStore(strict, { flushInterval: "1s" }),
  },
});
```

## Run it

```bash
cd examples/postgres-redis
docker compose up -d                       # Postgres on :55432, Redis on :56379
bun run examples:postgres-redis --demo     # from the repo root (or: bun run demo here)
docker compose down -v
```

`DATABASE_URL` / `REDIS_URL` point it elsewhere. Without reachable services the demo says how to
start them and exits 0 (skipped), so it is safe in CI.

## What the demo shows

1. **State in Postgres** — instance A subscribes a customer; instance B (cold cache) resolves the
   same plan. One `jsonb` row per customer in `xtandard_entitlements_kv`, revisioned so writes from
   any number of instances are compare-and-swap safe.
2. **Strict counters in Redis** — 20 concurrent seat requests split across both instances against
   a 10-seat plan: exactly 10 are granted. Every `add` is one Lua script; refusals never count.
3. **Buffered counters** — `api_calls` (switched to `metering: "buffered"` for this example)
   decides in A's memory (`buffered: true`) and reaches Redis as one `add` per flush. B can't see
   unflushed usage, which is why buffered metering is for soft meters only — across N instances a
   limit can overshoot by what each has not flushed yet. Never use it for seats or prepaid credits.

The two planes never need a cross-store transaction: state writes are revisioned, counter writes
are self-contained atomic operations. → [Storage guide](../../docs/STORAGE.md)

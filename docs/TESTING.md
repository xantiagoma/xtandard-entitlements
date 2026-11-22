# Testing

## Testing your app

`@xtandard/entitlements/testing` gives you an in-memory engine with a controllable clock, so you can
cross period boundaries, trial ends and expiries without waiting:

```ts
import { createTestEntitlements } from "@xtandard/entitlements/testing";
import { catalog } from "../src/catalog";

test("free plan resets monthly", async () => {
  const { ent, clock, thresholds } = createTestEntitlements({
    catalog,
    now: "2026-11-30T23:00:00Z",
  });
  await ent.consume("org_1", "api_calls", 1_000);
  expect((await ent.consume("org_1", "api_calls")).allowed).toBe(false);
  expect(thresholds.map((t) => t.threshold)).toEqual([0.8, 1]);

  clock.advance("2h"); // December
  expect((await ent.consume("org_1", "api_calls")).allowed).toBe(true);
});
```

It collects `usage`, `thresholds` and hook `events` for assertions; your own listeners and hooks
still run. Any option of `createEntitlements` can be passed (storage, counters, hooks, …).

## Testing this repository

```sh
bun run check      # lint + format check + typecheck
bun run test       # vitest: unit, conformance, adapters, type tests (test/*.test-d.ts)
bun run test:bun   # bun:sqlite drivers + Bun-runtime tests (test/*.bun.test.ts)
bun run test:e2e   # Playwright: admin UI, portal and React embeds
```

- **Conformance suites** — `test/storage-contract.ts` runs the shared `@xtandard/kit/storage/testing`
  suite (the one every xtandard driver runs: exact keys, metacharacters, empty segments, CAS incl.
  legacy non-canonical rows, watch) on each wrapped state driver with the `ent` key root, Redis
  offline on the kit's `fakeRedis`; `test/counter-contract.ts` (counters: bounded and partial adds
  under 50-way concurrency, refunds, claims) runs against every counter driver. Live Redis / MongoDB / Postgres / MySQL variants run when `REDIS_URL`, `MONGO_URL`,
  `POSTGRES_URL`, `MYSQL_URL` are set (CI sets them); Postgres also runs in-process on PGlite.
- **Engine** — `test/engine.test.ts`: refusals never count, 1 500 concurrent consumers against a 1 000
  limit, grant ordering and compensation, overage, credits, reserve / settle, idempotency, thresholds
  once per period, trials, versions, hooks, failure modes and cross-instance invalidation.
- **Billing** — per-provider transition matrices with signed fixtures (trial → active → past_due →
  canceled, upgrades, quantity changes, out-of-order and duplicate deliveries, bad signatures).
- Coverage thresholds are enforced in CI (`bun run test:coverage`).

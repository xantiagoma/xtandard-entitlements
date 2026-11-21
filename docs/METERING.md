# Metering

How `check`, `consume`, `reserve` / `settle` and `release` work, and what they guarantee
([ADR 0005](./ADR/0005-consumption-model.md), [ADR 0009](./ADR/0009-decisions-and-denials.md)).

## Decisions

Every runtime call returns a `CheckResult` — denials are data, not exceptions:

```ts
const r = await ent.consume("org_42", "api_calls", 5, { idempotencyKey: req.id });
// {
//   allowed: false,
//   reason: "limit_reached",          // included | within_limit | overage_allowed | limit_reached |
//                                     // not_in_plan | disabled_by_override | granted_by_override |
//                                     // subscription_inactive | unknown_feature | fallback
//   denial: "payment_required",       // 402: an upgrade would allow it — or "forbidden" (403)
//   unlockedBy: ["pro", "business"],  // cheapest first
//   limit: 1000, used: 998, remaining: 2, resetsAt: "2026-12-01T00:00:00.000Z",
// }
```

`ent.require()` and `ent.consumeOrThrow()` throw `EntitlementDeniedError` (with `.status` 402 / 403 and
`.result`) for handlers that prefer exceptions; the framework guards turn it into a JSON response.

## Buckets: where a unit comes from

For a metered or credits feature, a request for `n` units is taken from, in order:

1. the **period allowance**: plan limit + add-ons × quantity + recurring grants, counted on
   `usage/{customer}/{feature}/{period}`;
2. each active **one-off grant** (`ent.grant(customer, { feature, amount, expiresAt?, priority? })`),
   lowest `priority` first, then soonest expiry;
3. **overage**, when the plan entry says `overage: "allow"` (optionally capped by `overageLimit`) — the
   decision says `reason: "overage_allowed"` and reports `overage`.

The common case (no grants, no overage) is **one atomic counter operation**: "add `n` if the result
stays ≤ limit". Across several buckets the engine takes what each can give, in order, and **refunds
everything** if the total cannot be covered. Either way **a refusal never counts**, and concurrent
consumers can never push usage past the limit (they may, rarely, see a spurious refusal while another
request's partial takes are being refunded).

Capacity features (seats) use one counter: `consume` adds within the limit, `release` subtracts
(clamped at 0), and `setUsage` overwrites it with your source of truth (e.g. `count(*)` of members).

## Idempotency

`consume(customer, feature, n, { idempotencyKey })` claims the key for `idempotencyTtl` (default 24 h).
A repeat returns the current state with `duplicate: true` and changes nothing; a refused call releases
the key so the client can retry.

## Reserve and settle

For work whose cost is only known afterwards (LLM calls, renders, exports):

```ts
const r = await ent.reserve("org_42", "gpt_tokens", 8_000, { ttl: "5m" });
if (!r.allowed) return upgrade(r);
const usage = await callModel(prompt);
await ent.settle(r.reservation!.id, usage.totalTokens); // refunds the unused part, or takes the extra
```

`settle` past the reservation records the extra even beyond the limit by default (the work happened);
pass `{ overage: "cap" }` to take only what fits. `cancelReservation(id)` releases everything. Expired
reservations are released by `ent.sweep()` (the panel can run it on an interval).

## Thresholds and usage events

- `onUsage(event)` fires (fire-and-forget) on every successful consume, reserve, settle, release and
  `setUsage`.
- `onThreshold(event)` fires **once per period** when usage crosses a feature's `thresholds` (default
  80 % and 100 %) — wire it to email, Slack or [`@xtandard/webhooks`](./ECOSYSTEM.md).

## Counters

Usage lives in a `CounterStore` ([ADR 0004](./ADR/0004-state-storage-and-counter-ports.md)), separate
from the state storage that holds customers, so you can keep state in Postgres and counters in Redis.
Every driver implements `add` as a single atomic backend operation; see [Storage](./STORAGE.md).

### Write-behind counters

High-volume, soft meters can skip the per-request round trip ([ADR 0006](./ADR/0006-write-behind-counters.md)):

```ts
import { createBufferedCounterStore } from "@xtandard/entitlements/counters/buffered";

const strict = createRedisCounterStore({ url: process.env.REDIS_URL });
const ent = createEntitlements({
  catalog, // api_calls: feature.metered({ reset: "month", metering: "buffered" })
  counters: {
    default: strict,
    buffered: createBufferedCounterStore(strict, { flushInterval: "2s" }),
  },
});
```

Buffered features decide locally and flush deltas in batches; decisions carry `buffered: true`. Across
N instances a limit can be overshot by what each instance has not flushed yet — never use it for seats
or prepaid credits. `ent.close()` flushes.

## Failure modes

| Situation                               | Behaviour (default)                               | Option                        |
| --------------------------------------- | ------------------------------------------------- | ----------------------------- |
| State storage down, customer cached     | serve the last-known-good snapshot, `stale: true` | —                             |
| State storage down, customer not cached | resolve as the default plan, `reason: "fallback"` | `fallback: "deny" \| "allow"` |
| Counter store down: `consume`           | refused, `reason: "fallback"` (fail closed)       | `counterFallback: "allow"`    |
| Counter store down: `check`             | answer from the plan alone, `stale: true`         | —                             |

Boolean and value features never touch counters; with the customer cached they are pure memory reads
([ADR 0003](./ADR/0003-memory-first-snapshots.md)).

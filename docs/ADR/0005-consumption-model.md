# ADR 0005 — Consumption Model: Buckets, Atomic Takes, Refusals Never Count, Reserve/Settle

**Status:** Accepted ★

---

## Context

A metered feature's balance comes from several sources: the plan's per-period allowance, add-ons
(× quantity), recurring grants, one-off grants with expiry and priority (OpenMeter's grant model),
and optionally a shared credit pool (Autumn/Polar credits). AI workloads only know the real cost after
the call (Closure, resvary). byo-oss's rule — _a refusal never counts_ — is the property users rely on.

## Decision

**Buckets.** For `(customer, feature, now)` the engine builds an ordered bucket plan:

1. the **period allowance** counter `usage/{customer}/{feature}/{periodKey}` with
   `max = plan + Σ add-on × quantity + Σ recurring grants` (no `max` when unlimited);
2. each active **one-off grant** counter `grant/{customer}/{grantId}` with `max = grant.amount`,
   ordered by `priority` (ascending), then soonest `expiresAt`, then `createdAt`;
3. **overage**: when the plan allows it (`overage: "allow"`, optional `overageLimit`), the remainder
   goes to the period counter above the allowance and is reported as `overage`.

**Takes.** The common single-bucket case is one all-or-nothing `add(key, n, { max })` round trip.
Across buckets the engine takes `partial` amounts in order; if the plan cannot cover `n`, it refunds
every take (compensation) and returns `limit_reached`. Concurrent consumers may briefly see the
in-flight takes (a spurious refusal is possible; an over-grant is not).

**Credits.** A feature with `creditCost: { ai_credits: rate }` consumes `n × rate` from the credit
feature's buckets and records `n` on its own period counter (for analytics and its own optional limit),
compensating both on failure.

**Capacity** features (seats) use `cap/{customer}/{feature}`: `consume` adds within the limit,
`release` subtracts (clamped at 0), `setUsage` overwrites with the host's source of truth.

**Idempotency.** `consume(..., { idempotencyKey })` first `claim`s `idem/{customer}/{key}`; a
duplicate returns the original success (`duplicate: true`); a refusal releases the claim.

**Reserve / settle.** `reserve(customer, feature, n, { ttl })` takes like `consume` and stores a
reservation `{ id, takes[], expiresAt }` in state storage. `settle(id, actual)` refunds the unused part
(LIFO across takes) or takes the extra (`overage: "record"` by default — the work already happened —
or `"cap"`). `release(id)` = `settle(id, 0)`. Expired reservations are released lazily and by
`ent.sweep()` (the panel can run it on an interval).

**Events.** Every successful consume/settle emits `onUsage` (fire-and-forget) and, when usage crosses a
configured threshold (default 80 % and 100 %), `onThreshold` once per period.

## Consequences

- Strict mode can never over-grant; the price is one counter round trip per consume.
- Compensation means a crash between take and refund can leak at most one request's amount until the
  period resets — documented, and observable in the admin usage view.

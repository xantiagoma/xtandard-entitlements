# ADR 0003 — Memory-First Per-Customer Snapshots, Last-Known-Good, Explicit Fallbacks

**Status:** Accepted ★ (adapts `@xtandard/flags` ADR 0002 "memory-first runtime evaluation")

---

## Context

`check()` runs on every gated request. Flags' runtime promise — evaluation never reads storage on the
request path, and storage outages serve last-known-good — is exactly what an entitlement gate needs.
Unlike flags there is one document **per customer**, not one snapshot per environment, so the cache is
keyed and bounded.

## Decision

- The engine keeps an LRU of **customer snapshots**: `{ state, resolved, loadedAt, stale }`, where
  `resolved` is the pure `resolve(catalog, state, now)` output (ADR 0002). Default capacity 10 000
  customers, `cacheTtl` 30 s.
- A miss loads from state storage once (concurrent misses share one in-flight load). An expired entry
  is served immediately and refreshed in the background (stale-while-revalidate).
- A failing refresh **keeps the last-known-good snapshot** and marks it `stale` (surfaced as
  `stale: true` on decisions). It is never evicted because of an error.
- Writes made through the engine update the cache immediately; storages that implement `watch`
  (memory, Redis, file, or any storage wrapped with `withWatch`) invalidate other instances.
- Boolean and value features are answered from memory with **zero I/O**. Metered/capacity checks read
  their counters (one batched `get`), unless the counter store is buffered (ADR 0006).
- Time-dependent state (trial ends, grant/override expiry, period rollover) is evaluated at decision
  time from `now`, not baked into the snapshot, so no cron is needed for correctness.
- Fallbacks are explicit options, not accidents:
  - `fallback: "default-plan"` (default) — a customer that cannot be loaded _and_ has no cached
    snapshot resolves as "no subscriptions", i.e. the default plan. Decision `reason: "fallback"`.
    Alternatives: `"deny"` and `"allow"`.
  - `counterFallback: "deny"` (default) — when the counter store is unreachable, `consume` is refused
    (fail closed) and `check` answers from the plan alone with `stale: true`. Alternative `"allow"`.
- A customer with no state document is valid: it is on the default plan. State is created on the
  first mutation.

## Consequences

- Gates keep working through storage outages, with an auditable reason.
- Cross-instance staleness is bounded by `cacheTtl` unless the storage pushes changes.

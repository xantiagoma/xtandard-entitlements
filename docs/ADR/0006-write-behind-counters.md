# ADR 0006 — Write-Behind Counters as an Opt-In Decorator

**Status:** Accepted ★

---

## Context

Some meters are high-volume and soft (API calls on a generous plan, tokens with overage allowed): a
network round trip per increment is waste. Closure batches Redis into Postgres; Stigg caches at the
edge. Strict limits (seats, prepaid credits) must not be buffered.

## Decision

`createBufferedCounterStore(inner, { flushInterval: "1s", maxPending: 1000 })` wraps any
`CounterStore`:

- `add` is decided **locally** against a cached value + pending delta, then the delta is queued;
  `flush()` (interval, size threshold, `close()`) sends one unbounded `add` per key to `inner` and
  refreshes the cached value from the result.
- Across N instances the worst-case overshoot is bounded by `N × (pending per key)`; it is documented
  next to the option and surfaced on decisions as `buffered: true`.
- The engine can route per feature: `counters: { default: strictStore, buffered: bufferedStore,
  features: { api_calls: "buffered" } }`, or per catalog feature with `metering: "buffered"`.
- `claim`, `set` and `delete` pass straight through (they are not hot).
- A failed flush keeps the pending delta and retries; `close()` flushes before shutdown.

## Consequences

- Strict by default; buffering is an explicit, per-feature trade.
- Daily usage-series counters (graphs) always go through a buffered path — they are best-effort.

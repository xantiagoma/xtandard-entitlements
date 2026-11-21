# Architecture

`@xtandard/entitlements` is a library: the engine runs inside your process, against storage you
already operate. This page shows how the pieces fit; the decisions behind them are in the
[ADRs](./ADR/0001-single-package-subpath-exports.md).

```mermaid
flowchart LR
  subgraph app[Your app]
    H[Request handlers] -->|check / consume / reserve| E
    G[Framework guards<br/>requireEntitlement] --> E
    R[React hooks<br/>useEntitlement, Gate] -->|portal API| P
    E[Engine<br/>createEntitlements]
    P[Panel<br/>createFetchHandler] --> E
  end
  C[(Catalog<br/>catalog.ts)] -.typed import.-> E
  C -.-> R
  E -->|customers, reservations,<br/>links, activity| S[(State storage<br/>KV contract)]
  E -->|atomic add / claim| K[(Counter store)]
  B[Billing providers<br/>Stripe · Polar · Paddle · Lemon Squeezy] -->|signed webhooks| P
  P -->|admin SPA · customer portal| U[Browsers]
  E -.hooks.-> A[@xtandard/audit]
  E -.onThreshold.-> W[@xtandard/webhooks]
  E -.context enricher / provider.-> F[@xtandard/flags · OpenFeature]
```

## Two planes

- **Runtime plane** — `check`, `consume`, `reserve`, `settle`, `release`, `entitlements`. On the request
  path. Reads a per-customer snapshot from memory (last-known-good on storage failure), and talks only
  to the counter store, with one atomic operation per consume in the common case. Never throws for a
  denial. Observed through `onUsage` / `onThreshold` (fire-and-forget).
- **Control plane** — subscriptions, trials, grants, overrides, usage resets, provider links,
  customer profile. Revisioned read-modify-write of one customer document (compare-and-swap when the
  storage supports it, a per-customer lock always), wrapped in `before` (may deny) / `after` hooks and
  recorded as activity. Billing webhooks, the admin UI, the CLI and your code all go through it.

## Data

| Where          | What                                                                                                                          | Key                                                                  |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| Catalog (code) | features, plans + versions, add-ons, provider mappings                                                                        | —                                                                    |
| State storage  | one `CustomerState` per customer: subscriptions, grants, overrides, provider links, trials                                    | `ent/customers/{id}`                                                 |
| State storage  | reservations, provider-customer links, activity lists                                                                         | `ent/reservations/…`, `ent/links/…`, `ent/activity/…`                |
| Counter store  | period allowance, one-off grant balances, capacity counts, daily usage series, idempotency / threshold / webhook-event claims | `usage/…`, `grant/…`, `cap/…`, `daily/…`, `idem/…`, `thr/…`, `evt/…` |

Resolution is a pure function of the catalog, the customer document and the clock
(`resolveEntitlements`), so time-based state — trial ends, grant and override expiry, period rollover
— needs no background job.

## Package layout

One package, subpath exports ([ADR 0001](./ADR/0001-single-package-subpath-exports.md)):

| Subpath                                                     | Contents                                                                          |
| ----------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `@xtandard/entitlements`                                    | engine, resolver, periods, schema, storage / counter / hook / billing contracts   |
| `/catalog`                                                  | `defineCatalog`, `feature`, `pricingTable` — zero dependencies                    |
| `/storage/*`, `/drizzle/*`                                  | state storage drivers and Drizzle table helpers ([Storage](./STORAGE.md))         |
| `/counters/*`                                               | counter drivers ([Storage](./STORAGE.md)), `buffered`, `kv`                       |
| `/billing`, `/billing/*`                                    | billing intake and providers ([Billing](./BILLING.md))                            |
| `/flags`                                                    | OpenFeature provider, hook and context enricher ([OpenFeature](./OPENFEATURE.md)) |
| `/bridges/*`                                                | `@xtandard/audit` and `@xtandard/webhooks` bridges ([Ecosystem](./ECOSYSTEM.md))  |
| `/elysia`, `/elysia2`, `/hono`, `/express`, `/bun`, `/next` | panel + guards ([Adapters](./ADAPTERS.md))                                        |
| `/auth/*`, `/authorization/*`, `/hooks/*`                   | panel auth, authorization and hook implementations                                |
| `/react`, `/react/embed`                                    | hooks + gates, and the embedded dashboard / portal ([UI](./UI.md))                |
| `/testing`                                                  | in-memory engine with a test clock                                                |

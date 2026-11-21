# Changelog

All notable changes to `@xtandard/entitlements`. Versions follow ZeroVer (`0.x`); entries are
generated from conventional commits with `changelogen` (see [Releases](./docs/RELEASES.md)).

## v0.1.1

Docs-only release so npm shows the current README.

### Documentation

- **readme:** npm link in the ecosystem row; `@xtandard/audit` and `@xtandard/links` in the ecosystem table ([#12](https://github.com/xantiagoma/xtandard-entitlements/pull/12), [#22](https://github.com/xantiagoma/xtandard-entitlements/pull/22))
- **site:** "The xtandard ecosystem" cards on the docs home page ([#23](https://github.com/xantiagoma/xtandard-entitlements/pull/23))

### Chore

- **fmt:** pre-commit formatting no longer fails on `.mdx`- or `CHANGELOG.md`-only commits ([#24](https://github.com/xantiagoma/xtandard-entitlements/pull/24))

## v0.1.0

First release.

### Features

- **Catalog** (`/catalog`, zero dependencies): `defineCatalog` with boolean, metered, credits, capacity
  and value features; plans with groups, defaults, trials and versions (grandfathering); add-ons with
  quantities and `requires`; provider item mappings; `pricingTable()`; fully typed keys and values.
- **Engine**: `createEntitlements` — memory-first per-customer snapshots with last-known-good and
  explicit fallbacks; `check` / `consume` / `release` / `reserve` + `settle` with buckets (allowance →
  one-off grants → overage) where a refusal never counts; credits (`creditCost`); idempotency keys;
  once-per-period thresholds; decisions with `reason`, 402-vs-403 `denial` and `unlockedBy`; grants,
  overrides, trials, plan migration, usage set/reset, provider links, activity, daily usage series;
  `before` / `after` hooks; `onUsage` / `onThreshold` taps; `/testing` engine with a test clock.
- **Storage** (10 state drivers: memory, file, Redis + RedisJSON, Postgres, Drizzle pg/mysql/sqlite,
  MongoDB, SQLite, libSQL, unstorage, Cloudflare KV) and **counters** (memory, buffered write-behind,
  KV over compare-and-swap, Redis, Postgres, SQLite, libSQL, MongoDB, Drizzle), each with a
  conformance suite.
- **Billing**: `createBilling` intake (verified, idempotent, order-safe webhooks; reconcile; checkout
  and billing-portal link-outs; usage export) with Stripe, Polar, Paddle, Lemon Squeezy, better-auth
  Stripe and manual providers — no SDK dependencies.
- **Flags bridge** (`/flags`): OpenFeature provider, hook and context enricher for `@xtandard/flags`.
- **Bridges** to `@xtandard/audit` and `@xtandard/webhooks`.
- **Panel**: `createFetchHandler` with the admin + runtime + portal HTTP API (OpenAPI 3.1), auth
  (none / basic / delegated), authorization (none / roles / delegated), customer-scoped portal
  tokens, CORS, a log hook; adapters for Bun, Hono, Express, Elysia 1 and 2, Next.js, with
  `requireEntitlement` guards.
- **UI**: admin SPA and customer portal; `/react` hooks and components (`Gate`, `UsageMeter`,
  `PricingTable`, `UpgradePrompt`); `/react/embed` dashboard and portal.
- **CLI** (`xtandard-entitlements`: serve, check, consume, grant, override, subscribe, customers,
  pricing, sweep) and a standalone Bun server + Dockerfile.
- Examples (11), docs site, brand kit.

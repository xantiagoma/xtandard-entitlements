<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/xantiagoma/xtandard-entitlements/main/docs/assets/lockup-horizontal-dark.svg" />
  <img src="https://raw.githubusercontent.com/xantiagoma/xtandard-entitlements/main/docs/assets/lockup-horizontal-light.svg" alt="xtandard-entitlements" width="560" />
</picture>

**Plans, entitlements and usage metering for TypeScript apps — as a library.**

Declare your pricing model in code, gate features and meter usage in-process with atomic counters,
sync plan state from any billing provider, and give your team an admin UI and your customers a
usage portal. Your database, your process — no per-seat SaaS, no separate service.

[![CI](https://github.com/xantiagoma/xtandard-entitlements/actions/workflows/ci.yml/badge.svg)](https://github.com/xantiagoma/xtandard-entitlements/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/%40xtandard%2Fentitlements)](https://www.npmjs.com/package/@xtandard/entitlements)
[![license](https://img.shields.io/badge/license-MIT-blue)](./LICENSE)
[![docs](https://img.shields.io/badge/docs-me.xantiagoma.com-a3e635)](https://me.xantiagoma.com/xtandard-entitlements/)

**Documentation: [me.xantiagoma.com/xtandard-entitlements](https://me.xantiagoma.com/xtandard-entitlements/)** — guides and the full API reference.

<img src="https://raw.githubusercontent.com/xantiagoma/xtandard-entitlements/main/docs/assets/ui-customer.png" alt="Customer detail: plan, entitlements with usage bars, grants and overrides" width="800" />

</div>

> `check()` is a memory read. `consume()` is one atomic step — and a refused request never counts.
> Every answer says _why_, whether an upgrade would help (402) or not (403), and which plans would.

## Contents

- [Why another entitlements tool?](#why-another-entitlements-tool)
- [Quickstart](#quickstart)
- [The catalog](#the-catalog)
- [Checking and metering](#checking-and-metering)
- [Billing providers](#billing-providers)
- [Admin UI and customer portal](#admin-ui-and-customer-portal)
- [React](#react)
- [Feature flags (OpenFeature)](#feature-flags-openfeature)
- [Storage](#storage)
- [Subpath exports](#subpath-exports)
- [Examples](#examples)
- [Documentation](#documentation)
- [Project status](#project-status)
- [The xtandard ecosystem](#the-xtandard-ecosystem)
- [License](#license)

## Why another entitlements tool?

Every SaaS ends up writing `if (user.plan === "pro")`, then limits, then usage counters, then trials,
then "can you comp this customer 1 000 extra API calls until Friday?". The products that solve it —
Stigg, Schematic, Autumn Cloud — are hosted services. The open ones are billing services (Lago,
Flexprice: AGPL; OpenMeter: Go + Kafka + ClickHouse), and the embeddable libraries are each boxed in:
PayKit is Stripe + Postgres + Next.js only, Subscrio is Postgres-only, byo-oss/entitlements is a
better-auth plugin ([research](./docs/research/landscape.md)).

`@xtandard/entitlements` is the missing piece: **billing-provider-agnostic, storage-pluggable,
framework-agnostic**, with a typed catalog, atomic metering, grants and overrides, an admin UI and a
customer portal — and it plugs into `@xtandard/flags` so rollouts and plan gates share one decision.
Invoicing, tax, dunning and payments stay with your provider ([non-goals](./docs/ADR/0015-non-goals.md)).

## Quickstart

```sh
bun add @xtandard/entitlements   # or npm i / pnpm add
```

```ts
// catalog.ts — your pricing model, importable anywhere (zero dependencies)
import { defineCatalog, feature } from "@xtandard/entitlements/catalog";

export const catalog = defineCatalog({
  features: {
    seats: feature.capacity({ name: "Seats", unit: "seat" }),
    api_calls: feature.metered({ name: "API calls", unit: "call", reset: "month" }),
    export_pdf: feature.boolean({ name: "PDF export" }),
  },
  plans: {
    free: { name: "Free", default: true, features: { seats: 3, api_calls: 1_000 } },
    pro: {
      name: "Pro",
      trial: { days: 14 },
      price: { amount: 2900, currency: "usd", interval: "month" },
      providers: { stripe: ["price_pro_monthly"] },
      features: { seats: 10, api_calls: { limit: 100_000, overage: "allow" }, export_pdf: true },
    },
  },
});
```

```ts
// server.ts
import { createEntitlements } from "@xtandard/entitlements";
import { createRedisStorage } from "@xtandard/entitlements/storage/redis";
import { createRedisCounterStore } from "@xtandard/entitlements/counters/redis";
import { catalog } from "./catalog";

export const ent = createEntitlements({
  catalog,
  storage: createRedisStorage({ url: process.env.REDIS_URL }),
  counters: createRedisCounterStore({ url: process.env.REDIS_URL }),
});

// In a handler:
const decision = await ent.consume(org.id, "api_calls");
if (!decision.allowed) {
  return Response.json(decision, { status: decision.denial === "payment_required" ? 402 : 403 });
}
```

Mount the admin UI, the customer portal and billing webhooks in your app with one line per framework
(see [Admin UI and customer portal](#admin-ui-and-customer-portal)), or run the
[standalone server](./docs/DEPLOYMENT.md).

## The catalog

Five feature kinds — **boolean**, **metered** (resets per day / week / month / billing period),
**credits** (a balance other features draw from), **capacity** (seats, projects) and **value**
(max upload size, support tier) — on plans with groups, defaults, trials and **versions**
(grandfathered subscribers keep the limits they bought), plus stackable **add-ons**. Feature and plan
keys are inferred, so `ent.check(org, "exprot_pdf")` is a type error and value features return typed
values. `pricingTable(catalog)` renders the same catalog for your pricing page.
→ [Catalog guide](./docs/CATALOG.md)

## Checking and metering

```ts
await ent.check(org, "export_pdf"); // { allowed, reason: "included" } — zero I/O when cached
await ent.consume(org, "api_calls", 5, { idempotencyKey: req.id }); // atomic; refusals never count
await ent.consume(org, "seats"); // capacity: one more seat if it fits
await ent.release(org, "seats"); // a seat freed

// Work whose cost is known afterwards (LLM tokens):
const r = await ent.reserve(org, "gpt_tokens", 8_000, { ttl: "5m" });
await ent.settle(r.reservation!.id, usage.totalTokens);

// Operators:
await ent.grant(org, {
  feature: "api_calls",
  amount: 1_000,
  expiresAt: "2026-12-31",
  reason: "outage credit",
});
await ent.override(org, { feature: "export_pdf", enabled: true, reason: "pilot" });
await ent.startTrial(org, "pro");
```

Decisions carry `reason`, `denial` (`payment_required` → 402, `forbidden` → 403), `unlockedBy`
(cheapest plans first), `limit` / `used` / `remaining` / `resetsAt`. Usage is drawn from the period
allowance, then one-off grants by priority, then overage; `onThreshold` fires once per period at 80 %
and 100 %. The hot path reads a memory-first snapshot with last-known-good fallback, so gates keep
working when storage blips. → [Metering guide](./docs/METERING.md)

## Billing providers

Plan state is provider-agnostic; providers feed it. Stripe, Polar, Paddle, Lemon Squeezy,
better-auth's Stripe plugin and `manual` ship in the box — no SDKs, verified webhooks, idempotent and
order-safe intake, reconcile, and checkout / billing-portal link-outs:

```ts
import { createBilling } from "@xtandard/entitlements/billing";
import { createStripeProvider } from "@xtandard/entitlements/billing/stripe";

const billing = createBilling(ent, {
  providers: [
    createStripeProvider({
      secretKey: process.env.STRIPE_SECRET_KEY!,
      webhookSecret: process.env.STRIPE_WEBHOOK_SECRET!,
    }),
  ],
});
```

→ [Billing guide](./docs/BILLING.md)

## Admin UI and customer portal

```ts
import { Hono } from "hono";
import { entitlementsPanel, requireEntitlement } from "@xtandard/entitlements/hono";

const app = new Hono();
app.route(
  "/billing",
  entitlementsPanel({ entitlements: ent, billing, basePath: "/billing", portal: { secret } }),
);
app.post(
  "/export",
  requireEntitlement(ent, "export_pdf", { customer: (c) => c.get("orgId") }),
  exportPdf,
);
```

The panel serves the admin UI (catalog, customers, plans, grants, overrides, usage charts, activity),
the customer portal (current plan, usage vs. limits, upgrade link-outs) behind short-lived portal
tokens, the JSON API ([HTTP API](./docs/HTTP_API.md), with OpenAPI) and the billing webhooks. Adapters
for Hono, Elysia (1 and 2), Express, Bun and Next.js. → [Adapters](./docs/ADAPTERS.md) ·
[Portal](./docs/PORTAL.md) · [UI](./docs/UI.md)

## React

```tsx
import {
  EntitlementsProvider,
  Gate,
  UsageMeter,
  UpgradePrompt,
} from "@xtandard/entitlements/react";

<EntitlementsProvider baseUrl="/billing" token={portalToken}>
  <UsageMeter feature="api_calls" />
  <Gate feature="export_pdf" fallback={<UpgradePrompt feature="export_pdf" />}>
    <ExportButton />
  </Gate>
</EntitlementsProvider>;
```

Small hooks and unstyled components (`useEntitlement`, `<Gate>`, `<UsageMeter>`, `<PricingTable>`,
`<UpgradePrompt>`), plus the full dashboard and portal as embeddable components
(`@xtandard/entitlements/react/embed`). Client-side gates are UX; enforcement stays on the server.
→ [UI guide](./docs/UI.md)

## Feature flags (OpenFeature)

```ts
import { createEntitlementsHook } from "@xtandard/entitlements/flags";

OpenFeature.addHooks(createEntitlementsHook(ent, { customerKey: "orgId" }));
// @xtandard/flags rules can now target `plan in ["pro"]` or `entitlement.export_pdf == true`
```

Or use `createEntitlementsProvider(ent)` to evaluate features as OpenFeature flags.
→ [OpenFeature guide](./docs/OPENFEATURE.md)

## Storage

Two ports: **state storage** (customers, subscriptions, grants — the same KV contract and ten drivers
as `@xtandard/flags`: memory, file, Redis, Postgres, Drizzle, MongoDB, SQLite, libSQL, unstorage,
Cloudflare KV) and **counters** (atomic usage: memory, Redis, Postgres, SQLite, libSQL, MongoDB,
Drizzle, or any compare-and-swap storage), each with a conformance suite. Keep state in Postgres and
counters in Redis, or both in one database. → [Storage guide](./docs/STORAGE.md)

## Subpath exports

| Import                                                              | What                                                               |
| ------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `@xtandard/entitlements`                                            | `createEntitlements`, resolver, contracts, types                   |
| `@xtandard/entitlements/catalog`                                    | `defineCatalog`, `feature`, `pricingTable` (zero deps)             |
| `@xtandard/entitlements/storage/*` · `/drizzle/*`                   | state storage drivers                                              |
| `@xtandard/entitlements/counters/*`                                 | counter drivers, `buffered`, `kv`                                  |
| `@xtandard/entitlements/billing` · `/billing/*`                     | intake + Stripe, Polar, Paddle, Lemon Squeezy, better-auth, manual |
| `@xtandard/entitlements/flags`                                      | OpenFeature provider, hook, context enricher                       |
| `@xtandard/entitlements/bridges/audit` · `/bridges/webhooks`        | `@xtandard/audit` and `@xtandard/webhooks` bridges                 |
| `@xtandard/entitlements/{hono,elysia,elysia2,express,bun,next}`     | panel + `requireEntitlement` guards                                |
| `@xtandard/entitlements/auth/*` · `/authorization/*` · `/hooks/log` | panel auth, authorization, logging hook                            |
| `@xtandard/entitlements/react` · `/react/embed`                     | hooks + gates; embedded dashboard + portal                         |
| `@xtandard/entitlements/testing`                                    | in-memory engine with a test clock                                 |

## Examples

See [examples/](./examples/README.md): Hono, Elysia, Express, Bun, Next.js, a React app with gates and
the portal, Stripe webhooks, AI credits with reserve / settle, the flags bridge, Postgres + Redis.

## Documentation

[Getting started](./docs/GETTING_STARTED.md) · [Catalog](./docs/CATALOG.md) ·
[Metering](./docs/METERING.md) · [Billing](./docs/BILLING.md) · [Storage](./docs/STORAGE.md) ·
[Adapters](./docs/ADAPTERS.md) · [HTTP API](./docs/HTTP_API.md) · [Portal](./docs/PORTAL.md) ·
[UI](./docs/UI.md) · [OpenFeature](./docs/OPENFEATURE.md) · [Ecosystem](./docs/ECOSYSTEM.md) ·
[Hooks](./docs/HOOKS.md) · [Auth](./docs/AUTH.md) · [Authorization](./docs/AUTHORIZATION.md) ·
[Deployment](./docs/DEPLOYMENT.md) · [Architecture](./docs/ARCHITECTURE.md) ·
[Testing](./docs/TESTING.md) · [Releases](./docs/RELEASES.md) · [Brand](./docs/BRAND.md) ·
[Decisions (ADRs)](./docs/ADR/0001-single-package-subpath-exports.md)

## Project status

`0.x` (ZeroVer): the API is stabilizing; minor versions may break, patches don't. See the
[CHANGELOG](./CHANGELOG.md).

## The xtandard ecosystem

`@xtandard/entitlements` is one of a family of open-source, MIT-licensed projects that share the xtandard name. They are independent of each other: use any of them on its own.

| Project                                     | What it is                                                                                                                                                                                                      | Links                                                                                                                                                                      |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **`@xtandard/entitlements`** (this package) | An embeddable entitlements, plans and usage-metering engine: typed catalog, atomic metering, any billing provider, admin UI and customer portal                                                                 | [Docs](https://me.xantiagoma.com/xtandard-entitlements/) · [GitHub](https://github.com/xantiagoma/xtandard-entitlements)                                                   |
| **`@xtandard/lib`**                         | Lightweight, type-safe TypeScript utilities with a zero-dependency core                                                                                                                                         | [Docs](https://me.xantiagoma.com/xtandard/) · [GitHub](https://github.com/xantiagoma/xtandard) · [npm](https://www.npmjs.com/package/@xtandard/lib)                        |
| **`@xtandard/flags`**                       | A self-hosted, embeddable, OpenFeature-compatible feature-flag control plane with pluggable storage                                                                                                             | [Docs](https://me.xantiagoma.com/xtandard-flags/) · [GitHub](https://github.com/xantiagoma/xtandard-flags) · [npm](https://www.npmjs.com/package/@xtandard/flags)          |
| **`@xtandard/webhooks`**                    | A self-hosted, embeddable, Standard Webhooks-compliant outbound-webhooks control plane: a Svix alternative as a library                                                                                         | [Docs](https://me.xantiagoma.com/xtandard-webhooks/) · [GitHub](https://github.com/xantiagoma/xtandard-webhooks) · [npm](https://www.npmjs.com/package/@xtandard/webhooks) |
| **`@xtandard/audit`**                       | A self-hosted, embeddable, tamper-evident audit-log control plane for B2B SaaS: a WorkOS Audit Logs alternative as a library                                                                                    | [Docs](https://me.xantiagoma.com/xtandard-audit/) · [GitHub](https://github.com/xantiagoma/xtandard-audit) · [npm](https://www.npmjs.com/package/@xtandard/audit)          |
| **`@xtandard/links`**                       | Self-hosted, embeddable branded short links with click analytics, conversion attribution and deep links: a Dub / Bitly alternative as a library                                                                 | [Docs](https://me.xantiagoma.com/xtandard-links/) · [GitHub](https://github.com/xantiagoma/xtandard-links) · [npm](https://www.npmjs.com/package/@xtandard/links)          |
| **`@xtandard/xyte`**                        | A Zyte API-compatible `/v1/extract` client and server that runs on any proxy provider, or none                                                                                                                  | [Docs](https://me.xantiagoma.com/xyte/) · [GitHub](https://github.com/xantiagoma/xyte) · [npm](https://www.npmjs.com/package/@xtandard/xyte)                               |
| **xtandard-image**                          | A self-hosted image and video processing server in Go and libvips: imgproxy-compatible URLs plus the imgix, Cloudinary, ImageKit, Cloudflare and Thumbor dialects, with a TypeScript client (`@xtandard/image`) | [Docs](https://me.xantiagoma.com/xtandard-image/) · [GitHub](https://github.com/xantiagoma/xtandard-image) · [npm](https://www.npmjs.com/package/@xtandard/image)          |

### Related

- [drizzle-cursor](https://github.com/xantiagoma/drizzle-cursor): cursor-based pagination for Drizzle ORM
- [drizzle-audit](https://github.com/xantiagoma/drizzle-audit): configurable audit logging for Drizzle ORM — pairs with `@xtandard/audit/drizzle-audit` to give customers a verifiable log

## License

[MIT](./LICENSE)

# PLAN — `@xtandard/entitlements`

> Billing-provider-agnostic, storage-pluggable, framework-agnostic **entitlements, plans and
> usage-metering engine** — as an embeddable library. The Stigg / Schematic / Autumn niche, in the
> exact shape of `@xtandard/flags` and `@xtandard/webhooks`, and built to pair with `@xtandard/flags`.

Single source of truth for _what we are building and in what order_. Day-to-day status lives in
[WORKLOG.md](./WORKLOG.md). The brief is [MISSION.md](./MISSION.md); the market research is
[docs/research/landscape.md](./docs/research/landscape.md); decisions are in [docs/ADR](./docs/ADR).

## North star

- **The catalog is code.** Features, plans, add-ons, trials and plan versions are declared once in a
  zero-dependency, fully typed `defineCatalog()` file that the server, the browser and the public
  pricing page all import (ADR 0002).
- **`check()` is a memory read; `consume()` is one atomic step.** A customer's entitlements are
  resolved into an in-memory snapshot (last-known-good, like flags' runtime); usage goes through an
  atomic counter port where **a refusal never counts** (ADR 0003, 0004, 0005).
- **Answers, not 500s.** Every decision says why (`reason`), whether it is an upsell (`402`) or a hard
  no (`403`), what is left, when it resets, and which plans would unlock it (ADR 0009).
- **The billing provider is a port.** Plan _state_ is provider-agnostic; Stripe, Polar, Paddle, Lemon
  Squeezy, better-auth's Stripe plugin and `manual` are adapters that feed it (ADR 0007). Invoicing,
  tax, dunning and payments stay with the provider (ADR 0015).
- **Your database, your process.** `bun add` + the storage you already run. The admin UI and the
  customer portal mount inside the host app; nothing to operate.
- **One gate with flags.** Entitlements surface as an OpenFeature provider and as a flags
  evaluation-context enricher, so rollouts and plan gates share one decision point (ADR 0008).

## Reference repos and how closely we mirror them

`xtandard-flags` and `xtandard-webhooks` are **the** references for structure, tooling, naming and
docs; anything that differs is recorded in an ADR (index below). `xtandard-audit` (in progress) is a
third reference for the same shape.

| Area               | Mirrors                                                                 | Notes                                                                      |
| ------------------ | ----------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| Package layout     | `src/entry-*.ts` + `exports` + `vp pack` dual ESM/CJS                   | ADR 0001                                                                   |
| State storage      | the same 10 KV drivers, same factory names/options, `requirePeer`       | `EntitlementsStorage` = the flags KV contract (ADR 0004)                   |
| Counters           | —                                                                       | ★ new atomic `CounterStore` port + drivers + conformance (ADR 0004)        |
| Runtime            | flags' memory-first provider with last-known-good                       | per-customer snapshots + fallback modes (ADR 0003)                         |
| Server             | `createFetchHandler` → `{ fetch, engine, openapi }`, tiny router        | admin API + runtime API + portal API + billing webhook intake              |
| Auth/authorization | `auth/{none,basic,delegated}`, `authorization/{none,roles,delegated}`   | entitlements-specific action set                                           |
| Portal             | webhooks portal tokens (HMAC, stateless) + same-SPA reduced chrome      | customer-scoped (`entpt_`), ADR 0010                                       |
| UI                 | same SPA stack, tokens, primitives, theme, toasts                       | admin + customer portal                                                    |
| React              | `react` embeds (`Dashboard` / `Portal`)                                 | ★ `/react` = hooks + gates, `/react/embed` = dashboard + portal (ADR 0011) |
| Hooks              | `before` (veto) / `after` (side effects) around control-plane mutations | runtime taps `onUsage` / `onThreshold` are fire-and-forget                 |
| Adapters           | `{elysia,elysia2,hono,express,bun}` exporting `entitlementsPanel`       | ★ + `next` route handlers + per-framework `requireEntitlement` guards      |
| CLI                | `bin/xtandard-entitlements.mjs` → `dist/cli`                            | serve / check / consume / grant / override / plan / pricing / reconcile    |
| Tests              | vitest projects (core + elysia2), `*.bun.test.ts`, storage conformance  | + counter conformance, billing fixtures, playwright e2e, `test-d` types    |
| Docs               | README sections, `docs/*.md` set, ADRs, CHANGELOG (changelogen)         | Starlight site in `site/` + `pages.yml`                                    |
| Release            | `release.yml` (tag push → npm trusted publishing / OIDC)                | identical flow                                                             |

## Domain model (summary — `src/schema.ts` / `src/catalog.ts` are authoritative)

```ts
// Catalog (code, zero deps) — ADR 0002, 0012
const catalog = defineCatalog({
  features: {
    seats: feature.capacity({ name: "Seats", unit: "seat" }),
    api_calls: feature.metered({ name: "API calls", unit: "call", reset: "month" }),
    ai_credits: feature.credits({ name: "AI credits", unit: "credit", reset: "billing_period" }),
    gpt_tokens: feature.metered({
      name: "GPT tokens",
      reset: "never",
      creditCost: { ai_credits: 0.001 },
    }),
    export_pdf: feature.boolean({ name: "PDF export" }),
    max_upload_mb: feature.value<number>({ name: "Max upload (MB)", default: 10 }),
  },
  plans: {
    free: plan({ name: "Free", default: true, features: { api_calls: 1_000, seats: 3 } }),
    pro: plan({
      name: "Pro",
      version: 2,
      trial: { days: 14 },
      price: { amount: 2900, currency: "usd", interval: "month" }, // display only
      providers: { stripe: ["price_123"], polar: ["prod_1"] }, // provider item ids
      features: {
        api_calls: { limit: 100_000, overage: "allow" },
        seats: 10,
        export_pdf: true,
        ai_credits: 5_000,
        max_upload_mb: 500,
      },
      previous: { 1: { features: { api_calls: 50_000, seats: 5, export_pdf: true } } }, // grandfathered
    }),
  },
  addons: {
    extra_seats: addon({ name: "+5 seats", features: { seats: { add: 5 } }, quantity: true }),
  },
});

// Per-customer state (KV storage)
interface CustomerState {
  id: string; // your user / org / workspace id
  subscriptions: Subscription[]; // base plan + add-ons, provider-agnostic (ADR 0007)
  grants: Grant[]; // one-off or recurring balances, expiry + priority
  overrides: Override[]; // comp / raise limit / disable, reason + actor + expiry
  providers: Record<string, string>; // provider → provider customer id
  metadata: JsonObject;
  createdAt: string;
  updatedAt: string;
  revision: number;
}
interface Subscription {
  id: string;
  plan: string;
  version: number;
  kind: "base" | "addon";
  quantity: number;
  status: "active" | "trialing" | "past_due" | "paused" | "canceled" | "incomplete";
  periodStart: string;
  periodEnd: string;
  trialEndsAt?: string;
  cancelAtPeriodEnd?: boolean;
  provider: string;
  providerRef?: string;
}

// Decision (ADR 0009)
interface CheckResult {
  allowed: boolean;
  feature: string;
  kind: FeatureKind;
  reason:
    | "included"
    | "within_limit"
    | "overage_allowed"
    | "limit_reached"
    | "not_in_plan"
    | "disabled_by_override"
    | "granted_by_override"
    | "subscription_inactive"
    | "unknown_feature"
    | "unknown_customer"
    | "fallback";
  denial?: "payment_required" | "forbidden"; // 402 (upsell) vs 403 (hard no)
  limit?: number | null;
  used?: number;
  remaining?: number | null;
  resetsAt?: string | null;
  value?: JsonValue;
  unlockedBy: string[];
  stale?: boolean;
}
```

Counters (ADR 0004/0005): `usage/{customer}/{feature}/{periodKey}` (period allowance bucket),
`grant/{customer}/{grantId}` (per one-off grant bucket), `cap/{customer}/{feature}` (capacity), plus
best-effort daily series `daily/{customer}/{feature}/{yyyy-mm-dd}` for usage graphs.

## Engine surface

```ts
const ent = createEntitlements({
  catalog,
  storage,
  counters,
  billing,
  hooks,
  onUsage,
  onThreshold,
});
await ent.check(customer, "export_pdf"); // memory-first decision
await ent.consume(customer, "api_calls", 5, { idempotencyKey }); // atomic, refusal never counts
const r = await ent.reserve(customer, "gpt_tokens", 4_000, { ttl: "5m" });
await ent.settle(r.id, 3_412); // refund the rest / charge the extra
await ent.grant(customer, { feature: "ai_credits", amount: 1_000, expiresAt, reason, actor });
await ent.override(customer, { feature: "export_pdf", enabled: true, expiresAt, reason, actor });
await ent.subscribe(customer, { plan: "pro" }); // manual plan change (provider "manual")
await ent.setUsage(customer, "seats", 7); // capacity features
await ent.entitlements(customer); // full typed set with usage (UI / portal)
await ent.billing.handleWebhook("stripe", request); // provider intake → normalized state
ent.customer(customer).check("export_pdf"); // bound, typed client
```

## Module layout

```txt
src/
  index.ts              root: engine, schema, resolve, periods, contracts, handler, portal tokens
  catalog.ts            defineCatalog / feature.* / plan / addon / pricingTable  (→ /catalog, zero deps)
  schema.ts             types (CustomerState, Subscription, Grant, Override, CheckResult, …)
  resolve.ts            pure: (catalog, state, now) → EntitlementSet  (no I/O)
  periods.ts            reset windows: calendar (UTC) and billing-period anchored
  engine.ts             createEntitlements: check/consume/reserve/settle/grant/override/subscribe/…
  cache.ts              memory-first per-customer snapshots, LKG, refresh, watch invalidation
  ledger.ts             bucket plan + atomic take/compensate algorithm, reservations
  events.ts             onUsage / onThreshold sinks (fire-and-forget)
  validation.ts         valibot admin-path validation
  counters/             contract, memory, buffered (write-behind), redis, postgres, sqlite, libsql,
                        mongodb, drizzle, kv (CAS fallback)
  storage/              contract, memory, file, redis, postgres, drizzle, mongodb, sqlite, libsql,
                        unstorage, cloudflare-kv, watch   (mirrors flags)
  drizzle/              pg / mysql / sqlite table helpers (state + counters)
  billing/              contract, intake, verify (HMAC helpers), stripe, polar, paddle,
                        lemonsqueezy, better-auth, manual, usage-export
  flags.ts              OpenFeature provider + flags context enricher  (→ /flags)
  bridges/              audit (@xtandard/audit), webhooks (@xtandard/webhooks) — structural types
  portal.ts             portal tokens (stateless HMAC, customer-scoped)
  testing.ts            in-memory engine, fake clock, billing event factories, assertions
  auth/ authorization/ hooks/ server/ adapters/   (mirrors flags/webhooks; + adapters/next.ts)
  react/                hooks + Gate / UsageMeter / PricingTable / UpgradePrompt  (→ /react)
  react-embed.tsx       <EntitlementsDashboard>, <CustomerPortal>  (→ /react/embed)
  ui/                   React SPA → dist/ui (admin + portal chrome)
  cli.ts                xtandard-entitlements CLI
apps/standalone/        Bun server + Dockerfile
examples/               hono, elysia, express, bun, next, react-app, stripe-webhooks, flags-bridge,
                        ai-credits (reserve/settle), postgres-redis, storage-drivers
site/                   Starlight docs site
```

## Phases

1. **Research gate** — `docs/research/landscape.md`, verdict to t1r. ✅
2. **Design** — this file + ADRs 0001–0015, report to t1r.
3. **Scaffold** (lead) — tooling copied from flags/webhooks (package.json scripts, vite-plus,
   oxlint/oxfmt, tsconfigs, husky, mise, CI, release, LICENSE, CLAUDE.md). GitHub repo created.
4. **Spine** (lead) — catalog, schema, periods, resolve, counter contract + memory + buffered, state
   storage contract + memory, ledger, engine, cache, events, testing helpers; unit + type tests.
5. **Fan-out** (workers in worktrees, disjoint files):
   - **storage**: 10 KV drivers + conformance; counter drivers + counter conformance; drizzle tables;
   - **server**: routes/openapi/auth/authorization/portal tokens/adapters (+ next, guards)/CLI/standalone;
   - **billing**: providers + webhook intake + reconcile + usage export + transition matrix tests;
     flags bridge (OpenFeature provider + enricher); audit/webhooks bridges;
   - **ui**: SPA (admin + portal), React embeds, React hooks/components, playwright e2e.
6. **Brand** — logo (svg + png 128/256), horizontal + stacked lockups (light/dark), favicon
   (svg/ico/png) + apple-touch-icon, OG image, `docs/BRAND.md` (family reference:
   `xtandard-image/docs/BRAND.md`); used in README, site and the admin UI / portal.
7. **Docs + examples** — README (+ ecosystem section), `docs/*.md`, CHANGELOG, examples, site +
   `pages.yml`. Playwright **screenshots** of the real UI (admin, portal, React embeds, light + dark)
   against the seeded demo in `docs/assets/ui-*.png`. Site **preview** via hc, reviewed, URL to t1r,
   then Pages deploy verified live.
8. **Release prep** — `release.yml`, publint, `npm pack --dry-run`, READY TO PUBLISH to t1r, sibling
   ecosystem-table lines.

## Definition of done

See MISSION.md / ecosystem rules. Gate: `bun run check && bun run test && bun run test:bun && bun
run test:e2e` green locally and in GitHub Actions.

## ADR index (★ = deviation from / addition to flags + webhooks)

| ADR  | Decision                                                                              |
| ---- | ------------------------------------------------------------------------------------- |
| 0001 | Single package, subpath exports (mirrors)                                             |
| 0002 | Catalog as code: zero-dep, typed, shared by server, browser and pricing page ★        |
| 0003 | Memory-first per-customer snapshots, last-known-good, explicit fallback modes ★       |
| 0004 | Two ports: KV state storage (flags contract) + atomic counter store ★                 |
| 0005 | Consumption model: buckets, atomic take, refusal never counts, reserve/settle ★       |
| 0006 | Write-behind counters as an opt-in decorator (bounded overshoot) ★                    |
| 0007 | Billing provider is a port: normalized subscriptions, in-house webhook verification ★ |
| 0008 | Flags bridge: OpenFeature provider + evaluation-context enricher ★                    |
| 0009 | Decisions carry reasons; 402 (upsell) vs 403 (forbidden); `unlockedBy` ★              |
| 0010 | Bundled SPA admin + customer portal; customer-scoped portal tokens (mirrors webhooks) |
| 0011 | React: `/react` hooks + gates, `/react/embed` dashboard + portal ★                    |
| 0012 | Plan versions (grandfathering), trials, add-ons and plan groups ★                     |
| 0013 | Ecosystem bridges (audit, webhooks) by structural typing, no runtime deps ★           |
| 0014 | Periods and resets: UTC calendar windows or billing-period anchored ★                 |
| 0015 | Non-goals: invoicing, tax, dunning, payments ★                                        |

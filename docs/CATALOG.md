# Catalog

The catalog is your pricing model as TypeScript: **features**, **plans**, **add-ons**, trials and plan
versions. It is declared once with `defineCatalog()` and imported everywhere — your API handlers, your
React components and your public pricing page — from `@xtandard/entitlements/catalog`, which has **zero
dependencies** ([ADR 0002](./ADR/0002-catalog-as-code.md)).

```ts
// catalog.ts
import { defineCatalog, feature } from "@xtandard/entitlements/catalog";

export const catalog = defineCatalog({
  features: {
    seats: feature.capacity({ name: "Seats", unit: "seat" }),
    api_calls: feature.metered({ name: "API calls", unit: "call", reset: "month" }),
    ai_credits: feature.credits({ name: "AI credits", unit: "credit", reset: "billing_period" }),
    gpt_tokens: feature.metered({
      name: "GPT tokens",
      reset: "never",
      creditCost: { ai_credits: 0.01 },
    }),
    export_pdf: feature.boolean({ name: "PDF export" }),
    max_upload_mb: feature.value({ name: "Max upload (MB)", default: 10 }),
  },
  plans: {
    free: { name: "Free", default: true, features: { seats: 3, api_calls: 1_000 } },
    pro: {
      name: "Pro",
      version: 2,
      trial: { days: 14 },
      price: { amount: 2900, currency: "usd", interval: "month" },
      providers: { stripe: ["price_pro_monthly"], polar: ["prod_pro"] },
      features: {
        seats: 10,
        api_calls: { limit: 100_000, overage: "allow" },
        ai_credits: 5_000,
        export_pdf: true,
        max_upload_mb: 500,
      },
      previous: {
        1: {
          providers: { stripe: ["price_pro_legacy"] },
          features: { seats: 5, api_calls: 50_000, export_pdf: true },
        },
      },
    },
  },
  addons: {
    extra_seats: {
      name: "+5 seats",
      quantity: true,
      providers: { stripe: ["price_seats"] },
      features: { seats: { add: 5 } },
    },
  },
});
```

`defineCatalog` validates everything at definition time and throws one `CatalogError` listing every
problem (an unknown feature in a plan, two default plans in a group, a metered feature without a reset,
a provider price mapped twice, a credit cost pointing at a non-credits feature, …).

## Feature kinds

| Kind         | Builder                      | Plan entry                                                                        | What `check` answers                                               |
| ------------ | ---------------------------- | --------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| **boolean**  | `feature.boolean()`          | `true` / `false`                                                                  | on or off                                                          |
| **metered**  | `feature.metered({ reset })` | `number`, `"unlimited"`, `false`, or `{ limit, overage?, overageLimit?, reset? }` | used / remaining in the current period                             |
| **credits**  | `feature.credits({ reset })` | as metered                                                                        | a balance other features draw from                                 |
| **capacity** | `feature.capacity()`         | `number`, `"unlimited"`, `false`, or `{ limit, overage? }`                        | a current count against a ceiling (seats, projects) — never resets |
| **value**    | `feature.value({ default })` | any JSON value                                                                    | the value (max upload size, support tier)                          |

Common options: `name`, `description`, `unit` / `units` (labels), `hidden` (kept out of pricing tables
and the portal), `metadata`. Metered and credits features also take `metering: "buffered"`
([write-behind counters](./METERING.md#write-behind-counters)) and `thresholds` (default `[0.8, 1]`).

**Resets** are `"day"`, `"week"`, `"month"`, `"quarter"`, `"year"` (UTC calendar windows),
`"billing_period"` (the base subscription's period) or `"never"` ([ADR 0014](./ADR/0014-periods-and-resets.md)).
A reset is a new counter key — nothing runs on a schedule.

**Credits**: a metered feature with `creditCost: { ai_credits: 0.01 }` charges 0.01 credits per unit.
If no plan includes the feature itself, the credit pool alone decides; if a plan does give it a limit,
both must allow the request.

## Plans

| Option                            | Meaning                                                                                                        |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `features`                        | the entries above, typed per feature kind                                                                      |
| `group`                           | mutually exclusive group, default `"base"`: one entitled plan per group (the newest subscription wins)         |
| `default`                         | applies when the group has no entitled subscription (your free plan). One per group                            |
| `trial: { days }`                 | `startTrial()` length; provider trials arrive through webhooks the same way                                    |
| `version` / `previous`            | the current version and older ones still held by grandfathered subscribers                                     |
| `price`                           | display only (minor units) — money stays with the provider ([ADR 0015](./ADR/0015-non-goals.md))               |
| `providers`                       | provider item ids (Stripe prices, Polar products, Paddle prices, Lemon Squeezy variants) that map to this plan |
| `hidden`, `highlight`, `metadata` | presentation                                                                                                   |

### Versions (grandfathering)

Raising or lowering a live plan's limits must not silently change what existing customers bought
([ADR 0012](./ADR/0012-plan-versions-trials-addons.md)). Bump `version` and move the old features to
`previous`. A subscription pins the version it was created with; provider ids listed on an old version
map webhooks for legacy prices to that version. Moving customers is explicit:

```ts
await ent.migratePlan("org_42", "pro"); // one customer to the current version
await ent.migratePlan("*", "pro", 2); // everyone
```

## Add-ons

Add-ons stack on top of base plans: numeric features add `add × quantity` (`quantity: true` lets a
subscription carry a quantity), boolean features switch on, value features replace. `requires: ["pro"]`
limits an add-on to customers on one of those plans.

## How a customer's entitlements are resolved

`resolveEntitlements(catalog, state, now)` is pure (no I/O) and is what the engine caches per customer:

1. Subscriptions are entitled when their status is in `entitledStatuses` (default `active`, `trialing`,
   `past_due`), a trial has not ended, and a cancel-at-period-end has not passed.
2. One plan per group: the newest entitled subscription; else the group's default plan.
3. Add-ons whose `requires` is met add their amounts.
4. Grants: recurring grants raise the period allowance; one-off grants become their own balances
   ([Metering](./METERING.md)).
5. Active overrides replace the merged result (comp a feature, raise a limit, disable, change a value).

## Typed keys everywhere

```ts
import type { FeatureKey, PlanKey } from "@xtandard/entitlements/catalog";

type Feature = FeatureKey<typeof catalog>; // "seats" | "api_calls" | …
await ent.check("org_42", "exprot_pdf"); // ✗ type error
const { value } = await ent.check("org_42", "max_upload_mb"); // value: number | undefined
```

## Pricing tables

`pricingTable(catalog)` turns the catalog into display-ready JSON (plans in order, a cell per feature
with a label such as `"100,000 calls / month"`, `"Unlimited"`, `"✓"`, prices and trials). The panel
serves it publicly at `GET {basePath}/api/pricing`, and `<PricingTable>` renders it.

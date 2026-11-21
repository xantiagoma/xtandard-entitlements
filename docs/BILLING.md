# Billing

Entitlements sit **in front of** your billing provider. The provider (Stripe, Polar, Paddle, Lemon Squeezy, better-auth's Stripe plugin) stays the system of record for money; `@xtandard/entitlements` consumes its subscription state, maps it onto catalog plans and answers `check` / `consume` from memory. Switching providers is a catalog-mapping change, not a migration (ADR 0007).

```ts
import { createEntitlements } from "@xtandard/entitlements";
import { BillingVerificationError, createBilling } from "@xtandard/entitlements/billing";
import { createStripeProvider } from "@xtandard/entitlements/billing/stripe";

const ent = createEntitlements({ catalog, storage, counters });
const billing = createBilling(ent, {
  providers: [
    createStripeProvider({
      secretKey: process.env.STRIPE_SECRET_KEY!,
      webhookSecret: process.env.STRIPE_WEBHOOK_SECRET!,
    }),
  ],
});

// Any fetch-style route (the panel mounts this at POST {basePath}/webhooks/:provider):
export async function POST(request: Request) {
  try {
    const { outcome } = await billing.handleWebhook("stripe", request);
    return Response.json({ received: true, outcome });
  } catch (error) {
    if (error instanceof BillingVerificationError)
      return Response.json({ error: error.message }, { status: 400 });
    throw error;
  }
}
```

---

## Providers

Every provider is a subpath with **no SDK dependency**: verification is Web Crypto HMAC with a constant-time compare, REST calls are plain `fetch` (injectable via `fetch` for tests and proxies; `apiBase` for mock servers).

| Subpath                | Factory                      | Item id the catalog maps  | Webhook verification                                              | Reconcile | Checkout | Portal | Usage export      |
| ---------------------- | ---------------------------- | ------------------------- | ----------------------------------------------------------------- | --------- | -------- | ------ | ----------------- |
| `billing/stripe`       | `createStripeProvider`       | price (`price_…`)         | `Stripe-Signature: t=…,v1=…`, HMAC-SHA256 hex of `t.body`, 300 s  | ✓         | ✓        | ✓      | ✓ meter events    |
| `billing/polar`        | `createPolarProvider`        | product (`prod_…` / uuid) | Standard Webhooks (`webhook-id/-timestamp/-signature`), 300 s     | ✓         | ✓        | ✓      | ✓ event ingestion |
| `billing/paddle`       | `createPaddleProvider`       | price (`pri_…`)           | `Paddle-Signature: ts=…;h1=…`, HMAC-SHA256 hex of `ts:body`, 5 s  | ✓         | ✓        | ✓      | — (no meters)     |
| `billing/lemonsqueezy` | `createLemonSqueezyProvider` | variant id                | `X-Signature`, HMAC-SHA256 hex of the body (no timestamp)         | ✓         | ✓        | ✓      | —                 |
| `billing/better-auth`  | `betterAuthStripe`           | Stripe price              | none of ours — the plugin verifies Stripe and calls our callbacks | —         | plugin   | plugin | —                 |
| `billing/manual`       | `createManualProvider`       | —                         | —                                                                 | —         | —        | —      | —                 |

Webhook secrets accept an array during rotation (any one may match). Each module's TSDoc cites the provider documentation its scheme and payload shapes were checked against:

- Stripe — <https://docs.stripe.com/webhooks#verify-manually>, <https://docs.stripe.com/api/subscriptions/object> (billing periods live on subscription items since API 2025-03-31; the legacy top-level fields are a fallback).
- Polar — <https://docs.polar.sh/integrate/webhooks/delivery>. Secrets created on or after 2026-09-08 are Standard Webhooks (base64 key after `whsec_`); older ones are "Polar HMAC" (the UTF-8 bytes of the whole secret). Both keys are tried, like Polar's SDKs. The Standard Webhooks path is byte-compatible with `@xtandard/webhooks/receiver` (tested both ways).
- Paddle — <https://developer.paddle.com/webhooks/signature-verification> and Paddle's Node SDK validator (5-second window; raise `tolerance` if your queue adds latency).
- Lemon Squeezy — <https://docs.lemonsqueezy.com/help/webhooks/signing-requests>. Payloads carry no event id or signed timestamp: the idempotency id is the SHA-256 of the body, so a replayed delivery is a `duplicate`.

### Status mapping

Provider statuses collapse onto `active | trialing | past_due | paused | canceled | incomplete`; `entitledStatuses` (default `active`, `trialing`, `past_due`) decides access.

| Provider      | Mapping notes                                                                                                                                   |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Stripe        | 1:1, plus `unpaid` → `paused` (retries exhausted; Stripe advises revoking access) and `incomplete_expired` → `canceled`                         |
| Polar         | 1:1, plus `unpaid` → `paused`, `incomplete_expired` → `canceled`, `trial_ended` → `incomplete`; `subscription.revoked` → canceled               |
| Paddle        | 1:1; `scheduled_change.action = "cancel"` → `cancelAtPeriodEnd`; `subscription.canceled` → canceled                                             |
| Lemon Squeezy | `on_trial` → `trialing`; `cancelled` (grace period) → `active` + `cancelAtPeriodEnd` until `ends_at`; `unpaid` → `paused`; `expired` → canceled |

---

## Mapping provider items to plans

The catalog is the mapping. Item ids attach to plans, plan **versions** and add-ons:

```ts
const catalog = defineCatalog({
  features: { seats: feature.capacity(), export_pdf: feature.boolean() },
  plans: {
    pro: {
      version: 2,
      providers: { stripe: ["price_pro_monthly", "price_pro_yearly"], polar: ["prod_pro"] },
      features: { seats: 10, export_pdf: true },
      previous: {
        // A webhook for the old price lands on v1 — grandfathered customers keep v1's limits.
        1: { providers: { stripe: ["price_pro_2024"] }, features: { seats: 5, export_pdf: true } },
      },
    },
  },
  addons: {
    extra_seats: {
      quantity: true,
      providers: { stripe: ["price_seats"] },
      features: { seats: { add: 5 } },
    },
  },
});
```

- A provider subscription's **plan item** becomes one entitlements subscription with `providerRef = <provider subscription id>`; a price change on that subscription (upgrade / downgrade) updates the same entry, pinning the version the new price maps to.
- **Add-on items** become their own entries, `providerRef = <subscription id>:<item id>`, with the item's quantity.
- Items that **disappear** from a subscription → their entries are canceled. A subscription that is deleted → every entry it owns is canceled.
- **Unknown items** are skipped and reported through `onUnmapped({ reason: "unknown_item", … })` (default: a warning). A payload with only unknown items changes nothing (a catalog gap is likelier than a removal).

---

## Intake

`createBilling(ent, options)`:

| Option        | Default        | Description                                                                                |
| ------------- | -------------- | ------------------------------------------------------------------------------------------ |
| `providers`   | required       | Provider adapters; ids must be unique and match the catalog's `providers` keys.            |
| `metadataKey` | `"customerId"` | Subscription-metadata key carrying your customer id.                                       |
| `onUnmapped`  | warn           | Called for unknown items (`unknown_item`) and unresolvable customers (`unknown_customer`). |
| `eventTtl`    | `"7d"`         | How long processed webhook event ids are remembered.                                       |
| `now`         | `Date.now`     | Clock for cancellation / reconcile stamps (pass the engine's in tests).                    |
| `logger`      | `console`      | Non-fatal problems.                                                                        |

`handleWebhook(provider, request)` → `{ outcome, events }`:

| Outcome     | Meaning                                                                               |
| ----------- | ------------------------------------------------------------------------------------- |
| `applied`   | At least one subscription / customer change was written.                              |
| `duplicate` | This event id was already processed — nothing touched.                                |
| `stale`     | Every change was older than what is stored (out-of-order delivery) — nothing touched. |
| `ignored`   | Unhandled event type, unknown items, or a customer we cannot resolve.                 |

Errors: `BillingVerificationError` (bad signature, expired timestamp, malformed payload → **400**), `NotFoundError` (unknown provider → **404**). Anything else (storage down) propagates so the provider retries.

`apply(provider, events, { eventId? })` applies already-normalized `BillingEvent`s — for custom intakes, back-office tools and the better-auth callbacks.

### Customer resolution

1. An id the provider carries: Stripe `client_reference_id` (checkout) / `metadata[metadataKey]`, Polar `customer.external_id`, Paddle / Lemon Squeezy `custom_data[metadataKey]`.
2. Otherwise the link table `links/{provider}/{providerCustomer}` (`ent.link()` / `ent.resolveLink()`).
3. The first sighting of (1) links them, so later events without the id still resolve. Checkouts created through `billing.createCheckout` always carry it.

Unresolvable → `ignored` + `onUnmapped({ reason: "unknown_customer" })`.

### Idempotency and ordering

- **Duplicates.** Before applying, the intake claims `evt/{provider}/{eventId}` in the counter store (`claim`, TTL `eventTtl`). A second delivery of the same event is answered `duplicate`. If applying throws, the claim is released so the provider's retry is processed.
- **Out-of-order delivery.** Every write carries `providerUpdatedAt` (the provider's update time — Polar `modified_at`, Paddle `updated_at`, Lemon Squeezy `updated_at` — or the event time for Stripe). The engine ignores an update older than what it holds (`stale`); cancellations of vanished items carry the same guard.

---

## Reconcile

`billing.reconcile(customer, provider?)` pulls the provider's current subscriptions for the customer's linked provider account (`fetchSubscriptions`) and converges: upserts what the provider reports (stamped with the reconcile time when the provider has no update time, so older in-flight webhooks become stale) and cancels entries the provider no longer reports. It returns `{ customer, provider, upserted, canceled }` per provider — the admin's "Reconcile" button and `POST /api/customers/:id/reconcile`.

---

## Checkout and portal link-outs

```ts
const { url } = await billing.createCheckout("org_42", {
  plan: "pro", // or an add-on key
  quantity: 1,
  successUrl: "https://app.example.com/billing?ok=1",
  cancelUrl: "https://app.example.com/billing",
});
const portal = await billing.createPortalSession("org_42", {
  returnUrl: "https://app.example.com",
});
```

- The provider item is the first id mapped for that provider on the plan's **current** version (or the add-on).
- The provider customer comes from the customer's `providers` links; the email from the customer record. The plan's trial is offered unless the customer already used it.
- `provider` picks one explicitly; otherwise the first provider that can sell the plan (checkout) or that the customer is linked to (portal).
- `canCheckout` / `canManage` tell the portal UI whether to show the buttons.

| Provider      | Checkout                                                                | Portal                                 |
| ------------- | ----------------------------------------------------------------------- | -------------------------------------- |
| Stripe        | `POST /v1/checkout/sessions` (subscription mode, `client_reference_id`) | `POST /v1/billing_portal/sessions`     |
| Polar         | `POST /v1/checkouts/` (`external_customer_id`)                          | `POST /v1/customer-sessions/`          |
| Paddle        | `POST /transactions` → `checkout.url` (needs a default payment link)    | `POST /customers/{id}/portal-sessions` |
| Lemon Squeezy | `POST /v1/checkouts` (needs `storeId`; `custom` data carries the id)    | the customer's `urls.customer_portal`  |

---

## Usage export (optional)

Report metered usage to provider meters for usage-based pricing. Best-effort, batched, off the decision path:

```ts
import { createUsageExporter } from "@xtandard/entitlements/billing";

const exporter = createUsageExporter(stripe, {
  meters: { api_calls: "api_requests" }, // feature → meter / event name
  batch: { size: 100, interval: "5s" },
});
const ent = createEntitlements({ catalog, onUsage: exporter.onUsage });
exporter.attach(ent); // records carry the linked provider customer
// on shutdown
await exporter.close();
```

Only positive amounts from `consume`, `reserve` and `settle` are exported (configurable with `sources`); idempotent replays are skipped. Stripe sends one `POST /v1/billing/meter_events` per record (`identifier` = the idempotency key); Polar sends one `POST /v1/events/ingest` per batch keyed by `external_customer_id`, the amount in `metadata[meterProperty]`. A failed flush is reported to `onError` and dropped — the provider stays the system of record for money.

---

## better-auth recipe

If better-auth's Stripe plugin already owns your Stripe webhook, feed entitlements from its callbacks instead of mounting ours:

```ts
import { betterAuth } from "better-auth";
import { stripe } from "@better-auth/stripe";
import { betterAuthStripe } from "@xtandard/entitlements/billing/better-auth";

export const auth = betterAuth({
  plugins: [
    stripe({
      stripeClient,
      stripeWebhookSecret: process.env.STRIPE_WEBHOOK_SECRET!,
      createCustomerOnSignUp: true,
      subscription: { enabled: true, ...betterAuthStripe(ent) },
    }),
  ],
});
```

- `plans` is generated from the catalog (`toBetterAuthPlans`): one plugin plan per catalog plan with a Stripe price — `name` = plan key, `priceId`, `limits` (numbers, `null` = unlimited, booleans, values), `freeTrial`, `group`.
- `onSubscriptionComplete | Created | Update | Cancel | Deleted` normalize the plugin's `stripeSubscription` through the same Stripe mapping (upgrades, add-ons, legacy prices), with the plugin's `referenceId` as the customer (`customerId` overrides). Stripe event ids make them idempotent.
- Pass an existing `createBilling(...)` instead of the engine to share one intake (then pass `catalog` for `plans`).

---

## Non-goals

No invoices, prices, proration, tax, dunning, refunds or card data (ADR 0015). Prices in the catalog are display metadata; the provider bills. We consume its subscription state, optionally report usage to its meters, and link out to its checkout and billing portal.

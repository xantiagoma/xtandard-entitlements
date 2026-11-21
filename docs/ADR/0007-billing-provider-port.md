# ADR 0007 — The Billing Provider Is a Port

**Status:** Accepted ★

---

## Context

PayKit put Stripe in its schema (`0001_stripe_only_schema.sql`) and had to drop its Polar/Razorpay
work. The research verdict: keep plan _state_ provider-agnostic and sync from any provider.

## Decision

Subscriptions in state are provider-agnostic (`plan`, `version`, `status`, `periodStart/End`,
`trialEndsAt`, `quantity`, `provider`, `providerRef`). Providers implement:

```ts
interface BillingProvider {
  readonly id: string; // "stripe" | "polar" | …
  parseWebhook(request: Request): Promise<BillingWebhook>; // verify signature, normalize
  fetchSubscriptions?(providerCustomerId: string): Promise<ProviderSubscription[]>; // reconcile
  createCheckout?(input: CheckoutInput): Promise<{ url: string }>; // link-out
  createPortalSession?(input: PortalInput): Promise<{ url: string }>; // link-out
  reportUsage?(records: UsageRecord[]): Promise<void>; // optional usage export
}
```

- **Mapping to plans** comes from the catalog: `plan({ providers: { stripe: ["price_…"], polar: ["prod_…"] } })` (provider item ids)
  (Polar products, Paddle prices, Lemon Squeezy variants). Unmapped items are ignored with a warning.
- **Customer resolution**: our customer id from provider metadata (`metadataKey`, default
  `"customerId"`; Stripe also `client_reference_id`), else the link table
  `links/{provider}/{providerCustomerId}` maintained by `ent.billing.link()` and checkout.
- **Intake** (`POST {basePath}/webhooks/{provider}`): verify, `claim` the event id (idempotent), drop
  events older than the subscription's `providerUpdatedAt` (out-of-order safety), apply, update cache,
  fire `subscription.changed` hooks. Unknown event types → `200 ignored`.
- **Status mapping** is per provider into `active | trialing | past_due | paused | canceled |
incomplete`; `entitledStatuses` (default `active`, `trialing`, `past_due`) decides access.
- **Verification is in-house and zero-dependency** (Web Crypto HMAC, constant-time compare,
  timestamp tolerance): Stripe `t=…,v1=…`, Paddle `ts=…;h1=…`, Lemon Squeezy `X-Signature`, Polar
  Standard Webhooks (byte-compatible with `@xtandard/webhooks/receiver`, tested against it). No
  provider SDKs: REST calls use `fetch` (injectable for tests).
- **better-auth Stripe** has no webhook of ours: `betterAuthStripe(ent)` returns the plugin's
  `subscription` callbacks plus `plans` generated from the catalog.
- **manual**: the admin UI / `ent.subscribe()` set plans directly (comps, invoiced enterprise deals).
- A transition matrix (trial → active → past_due → canceled, upgrade/downgrade, quantity change,
  cancel at period end, resubscribe, out-of-order delivery, duplicate delivery) is tested per provider
  with recorded fixtures.

## Consequences

- Switching providers is a catalog-mapping change, not a migration.
- No SDK version drift; we own a small amount of signature code, covered by fixtures from each
  provider's docs.

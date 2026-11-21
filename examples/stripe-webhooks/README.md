# Stripe webhooks × @xtandard/entitlements

Stripe stays the system of record for money; entitlements follow its subscription state. This
example signs **realistic Stripe events locally** (no network, no Stripe account) and posts them
to the panel's webhook route, so you can watch each one land as a plan change.

## What's here

- **[`src/app.ts`](./src/app.ts)** — `createBilling(ent, { providers: [createStripeProvider({
webhookSecret })] })` passed to the panel as `billing`: it answers
  `POST /billing/webhooks/stripe` (signature-verified, idempotent, order-safe). With
  `STRIPE_SECRET_KEY` set it also powers reconcile and the portal's checkout / billing-portal
  link-outs.
- **[`src/stripe-events.ts`](./src/stripe-events.ts)** — Stripe `event` / `subscription` objects
  (the fields the provider reads, in Stripe's shapes) and `signStripePayload` from
  `@xtandard/entitlements/billing/stripe` — the same `t=…,v1=…` HMAC Stripe sends.
- The catalog maps Stripe prices to plans ([`../shared/catalog.ts`](../shared/catalog.ts)):
  `price_pro_monthly` → Pro v2, `price_pro_legacy` → **Pro v1** (grandfathered),
  `price_business_monthly` → Business, `price_extra_seats` → the `extra_seats` add-on (quantity).

## Run it

```bash
bun run examples:stripe-webhooks --demo   # from the repo root: the whole story in-process; exits 0

bun run examples:stripe-webhooks          # the panel on a free port …
cd examples/stripe-webhooks && bun run send http://localhost:<port>   # … and replay events into it
```

Against real Stripe test mode: `stripe listen --forward-to localhost:<port>/billing/webhooks/stripe`,
then start the server with `STRIPE_WEBHOOK_SECRET` set to the `whsec_…` the CLI prints.

## The demo

[`src/demo.ts`](./src/demo.ts) replays one customer's lifecycle and checks the entitlements after
each event:

| Event                                                 | Customer ends up on              |
| ----------------------------------------------------- | -------------------------------- |
| `checkout.session.completed` (`client_reference_id`)  | free — but `cus_…` is now linked |
| `customer.subscription.created` (trialing)            | Pro, trialing — 10 seats         |
| `customer.subscription.updated` (active)              | Pro, active                      |
| `customer.subscription.updated` (Business + 2× seats) | Business — 50 + 2 × 5 seats, SSO |
| `customer.subscription.deleted`                       | free again (the default plan)    |

Then: a duplicate delivery (`duplicate`, nothing changes), an older event arriving late (`stale`),
the legacy price landing on Pro **v1**, and a forged signature / replayed timestamp (`400`).

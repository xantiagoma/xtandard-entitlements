# ADR 0015 — Non-Goals: Invoicing, Tax, Dunning, Payments

**Status:** Accepted ★

---

## Context

Lago, Kill Bill and Flexprice are billing systems; they are services because invoicing, tax, dunning
and payment collection need durable workflows, compliance and a ledger. The gap we fill is the layer
_in front of_ the provider.

## Decision

`@xtandard/entitlements` does **not** compute invoices, prices, proration, tax, dunning or refunds and
never touches card data. Prices in the catalog are display metadata. The provider (Stripe, Polar,
Paddle, Lemon Squeezy, …) remains the system of record for money; we consume its subscription state
and, optionally, report usage to its meters. The portal links out to the provider's checkout and
billing portal.

## Consequences

- The package stays a library. Anything that needs a ledger of money is out of scope by design.

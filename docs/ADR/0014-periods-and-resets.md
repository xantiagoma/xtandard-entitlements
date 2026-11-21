# ADR 0014 — Periods and Resets: UTC Calendar Windows or Billing-Period Anchored

**Status:** Accepted ★

---

## Context

Metered features reset: per day, month, or "every billing cycle" (which starts on the subscription's
anchor day, not the 1st). Resets must not need a cron job, and two servers must agree on the window.

## Decision

- `reset: "day" | "week" | "month" | "quarter" | "year" | "billing_period" | "never"` on metered and
  credits features (plans may override per feature).
- Calendar windows are **UTC** (`week` starts Monday, ISO). `billing_period` uses the entitled base
  subscription's `periodStart`/`periodEnd` (rolling monthly from its start, Stripe-style day clamping, when
  the period data is stale); without one (free plan) it falls back to **UTC calendar months**. (An
  earlier draft anchored on the customer's `createdAt`, but a never-written customer has no stable
  `createdAt`, and re-anchoring on the first write would reset usage mid-month.)
- The **period key** is derived (`m:2026-11`, `w:2026-11-16`, `bp:2026-11-14T08:00:00.000Z`, `all`), so a reset is
  simply a new counter key — nothing to delete. Old keys get an `expiresAt` retention hint.
- `resetsAt` is reported on every decision. `ent.resetUsage(customer, feature)` (admin) deletes the
  current period key.
- Rollover of unused allowance is **not** in 0.x (use grants).

## Consequences

- Zero background jobs for correctness; consistent across instances with synchronized clocks.
- Time zones other than UTC are a possible future option, not a default.

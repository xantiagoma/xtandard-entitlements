# ADR 0010 — Bundled SPA: Admin + Customer Portal; Customer-Scoped Portal Tokens

**Status:** Accepted (mirrors flags ADR 0003 "bundled SPA" and webhooks ADR 0006 "portal tokens")

---

## Context

Stigg and Schematic sell two UIs: an operator console (look up a customer, comp a feature, see usage)
and a customer-facing widget (current plan, usage vs. limits, upgrade). Webhooks solved the identical
split with one SPA, two chromes, and stateless HMAC portal tokens.

## Decision

- One React SPA built to `dist/ui`, served by `createFetchHandler` under `basePath`, same stack and
  design tokens as flags/webhooks (Tailwind v4, Base UI primitives, TanStack Query, wouter, theme
  toggle, toasts).
- **Admin views:** Overview (customers by plan, recent changes, threshold alerts), Catalog (features ×
  plans matrix, versions, add-ons — read-only), Customers (search, detail: subscriptions, entitlement
  table with usage bars and reset times, grants, overrides, reservations, daily usage chart, activity),
  Activity (control-plane audit).
- **Customer portal:** current plan and status/trial, usage vs. limits, plan comparison with
  upgrade/downgrade link-outs (`createCheckout`), "Manage billing" link-out (`createPortalSession`).
  No invoices are rendered by us (ADR 0015).
- **Portal tokens:** `createPortalToken(secret, customerId, { expiresIn: "1h", scope })` →
  `entpt_` + base64url(`{ customer, exp, scope }`) + `.` + base64url(HMAC-SHA256). Verified statelessly
  by the panel (`portal: { secret }`); portal principals are force-scoped to their customer and to the
  portal actions (`portal:read`, `portal:checkout`, `portal:manage`); the host's authorization provider
  is not consulted for them.

## Consequences

- Two lines for hosts: mint a token after their own auth, render the portal.
- Revocation before expiry = rotate the portal secret.

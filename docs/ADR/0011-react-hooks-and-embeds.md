# ADR 0011 — React: `/react` for Hooks and Gates, `/react/embed` for Dashboard + Portal

**Status:** Accepted ★ (flags/webhooks ship only embeds under `/react`)

---

## Context

For flags and webhooks, React means "embed the admin". For entitlements the everyday React use is in
the host's *product* UI: hide a button, show a usage meter, render the pricing table. Those must be
tiny and dependency-free; the embedded dashboard bundles TanStack Query, Base UI and a stylesheet.

## Decision

- `@xtandard/entitlements/react` — **hooks and small components**: `EntitlementsProvider`,
  `useEntitlement`, `useEntitlements`, `useCustomer`, `<Gate>`, `<UsageMeter>`, `<PricingTable>`,
  `<UpgradePrompt>`, and `createEntitlementsReact<typeof catalog>()` for catalog-typed variants. The
  provider reads from the portal API (`/api/portal/me` with a portal token), a custom `fetcher`, or
  server-rendered `initial` data. Components are unstyled by default (`className`, `data-state`
  attributes) with an optional `@xtandard/entitlements/react/components.css`.
  Client-side gates are UX only; enforcement is server-side, and the docs say so.
- `@xtandard/entitlements/react/embed` — `<EntitlementsDashboard apiBaseUrl />` and
  `<CustomerPortal apiBaseUrl token />`, the SPA internals, same theme modes (`auto | inherit | light |
  dark`) and scoped stylesheet `@xtandard/entitlements/react/styles.css` as the siblings.

## Consequences

- `import { Gate } from "@xtandard/entitlements/react"` costs a few kB, not the dashboard bundle.
- One extra subpath compared to the siblings; documented in UI.md.

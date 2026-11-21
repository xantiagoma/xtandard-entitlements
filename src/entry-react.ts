/**
 * Hooks and small components for gating your product UI on a customer's plan:
 * `EntitlementsProvider`, `useEntitlement`, `useEntitlements`, `useCustomer`,
 * `<Gate>`, `<UsageMeter>`, `<PricingTable>`, `<UpgradePrompt>` and
 * `createEntitlementsReact<typeof catalog>()`. Plain React (a peer), no other
 * dependencies; optional default styles in
 * `@xtandard/entitlements/react/components.css`.
 *
 * **Client-side gates are UX only** — enforce on the server with `check` /
 * `consume` or the adapters' `requireEntitlement` guards.
 *
 * @module react
 */

export * from "./react/index.tsx";

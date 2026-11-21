/**
 * `@xtandard/entitlements/react/embed` — the admin dashboard and the customer
 * portal as React components, for hosts that want them inside their own React
 * tree instead of the bundled SPA the adapters serve.
 *
 * ```tsx
 * import { CustomerPortal, EntitlementsDashboard } from "@xtandard/entitlements/react/embed";
 * import "@xtandard/entitlements/react/styles.css";
 *
 * // Full admin — point it at wherever the panel is mounted:
 * <EntitlementsDashboard apiBaseUrl="/billing" />
 *
 * // Customer portal — pass a portal token minted server-side:
 * <CustomerPortal apiBaseUrl="/billing" token={portalToken} />
 * ```
 *
 * `react` and `react-dom` are peers; everything else (TanStack Query, Base UI,
 * styles) is bundled. The stylesheet is scoped under `.xtandard-entitlements`,
 * so it cannot leak into the host. For gating your own UI (`<Gate>`,
 * `useEntitlement`, `<UsageMeter>`), use the much smaller
 * `@xtandard/entitlements/react` instead.
 *
 * @module react/embed
 */

export * from "./react-embed.tsx";
export { default } from "./react-embed.tsx";

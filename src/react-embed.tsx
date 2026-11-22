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
 * @module
 */

import type { QueryClient } from "@tanstack/react-query";
import type { FetchLike } from "@xtandard/kit/ui";
import { createEmbed, type EmbedBaseProps, type EmbedRouting } from "@xtandard/kit/ui/embed";
import { App } from "./ui/App.tsx";
import * as api from "./ui/api.ts";
import { themeStore } from "./ui/theme.ts";
import "./ui/styles.css";

/** Theme modes for the embedded components (see {@link EntitlementsDashboardProps.theme}). */
export type EmbedTheme = "auto" | "inherit" | "light" | "dark";

/** Props for {@link EntitlementsDashboard}. */
export interface EntitlementsDashboardProps extends EmbedBaseProps {
  /**
   * Base URL where the panel API + `/config` are mounted (e.g. `"/billing"` or
   * `"https://admin.example.com/billing"`). Defaults to `""` (same origin, relative).
   */
  apiBaseUrl?: string;
  /**
   * `credentials` mode for API requests. Defaults to `"same-origin"`. For a
   * **cross-origin** embed with cookie auth set `"include"` — and enable `cors`
   * on the panel so it returns `Access-Control-Allow-Credentials`.
   */
  credentials?: RequestCredentials;
  /** Custom `fetch` (inject a bearer token / headers, instrument calls). */
  fetch?: FetchLike;
  /** Bring your own QueryClient; one is created if omitted. */
  queryClient?: QueryClient;
  /**
   * Theme handling. The embed never writes to the host document — it resolves a
   * theme and applies it to its own wrapper (`data-theme`).
   * - `"auto"` (default) — the panel's own system/light/dark switcher (persisted
   *   in localStorage).
   * - `"inherit"` — follow the host page, live: a `dark`/`light` class or
   *   `data-theme` on `<html>` (then `<body>`), falling back to the OS
   *   `prefers-color-scheme`. The switcher is hidden.
   * - `"light"` / `"dark"` — force one theme (switcher hidden).
   */
  theme?: EmbedTheme;
  /** Extra className on the root wrapper. */
  className?: string;
  /**
   * How the dashboard routes between views.
   * - `"hash"` (default) — routes in `location.hash`; never touches the host's router.
   * - `"browser"` — real history paths under `routerBase` (the host must serve a catch-all).
   * - `"memory"` — in-memory only; no URL coupling at all (the query string is kept).
   * - a custom wouter location hook.
   */
  routing?: EmbedRouting;
  /** Base path for `routing: "browser"` (e.g. `"/admin/billing"`). */
  routerBase?: string;
  /** Navbar logo image URL (replaces the mark + title). Overrides server `/config`. */
  logoUrl?: string;
}

/** Props for {@link CustomerPortal}. */
export interface CustomerPortalProps extends EntitlementsDashboardProps {
  /**
   * Portal token (`entpt_…`) minted server-side with `createPortalToken()`,
   * sent as `Authorization: Bearer` on every request. The panel force-scopes
   * every call to the token's customer.
   */
  token: string;
}

/**
 * The shared embed plumbing (`@xtandard/kit/ui/embed`): one theme per embed on
 * the `.xtandard-entitlements` wrapper, toasts and Base UI portals inside it,
 * the memory router keeping its query string, and the portal token attached
 * synchronously (queries refetch when it changes).
 */
const embed = createEmbed({
  App,
  scopeClass: "xtandard-entitlements",
  api,
  themeKey: themeStore,
  tokenRouting: "hash",
  displayNames: { dashboard: "EntitlementsDashboard", token: "CustomerPortal" },
});

/** The full admin dashboard (Overview, Catalog, Customers, Activity) as a React component. */
export const EntitlementsDashboard: React.FC<EntitlementsDashboardProps> = embed.Dashboard;

/**
 * The customer portal (plan, usage vs. limits, plan comparison with checkout,
 * "Manage billing") as a React component, scoped by a portal token.
 */
export const CustomerPortal: React.FC<CustomerPortalProps> = embed.TokenEmbed;

export { setApiBase, setApiToken } from "./ui/api.ts";
export type { FetchLike };
export {
  setThemePref,
  getThemePref,
  detectHostTheme,
  type ThemePref,
  type ResolvedTheme,
} from "./ui/theme.ts";
export default EntitlementsDashboard;

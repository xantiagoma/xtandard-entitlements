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

import React from "react";
import type { BaseLocationHook } from "wouter";
import { useHashLocation } from "wouter/use-hash-location";
import { useBrowserLocation } from "wouter/use-browser-location";
import { memoryLocation } from "wouter/memory-location";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { App } from "./ui/App.tsx";
import { ToastProvider } from "./ui/components/Toast.tsx";
import { setApiBase, setApiToken, type FetchLike } from "./ui/api.ts";
import { setPortalContainerRef } from "./ui/lib/portal-container.ts";
import {
  detectHostTheme,
  getThemePref,
  resolveTheme,
  subscribeSystemTheme,
  subscribeThemePref,
  watchHostTheme,
  type ResolvedTheme,
} from "./ui/theme.ts";
import "./ui/styles.css";

/** Theme modes for the embedded components (see {@link EntitlementsDashboardProps.theme}). */
export type EmbedTheme = "auto" | "inherit" | "light" | "dark";

/** Resolve the embed's theme for `mode`, re-rendering when its source changes. */
function useEmbedTheme(mode: EmbedTheme): ResolvedTheme {
  const read = React.useCallback((): ResolvedTheme => {
    if (mode === "light" || mode === "dark") return mode;
    if (mode === "inherit") return detectHostTheme();
    return resolveTheme(getThemePref());
  }, [mode]);

  const [resolved, setResolved] = React.useState<ResolvedTheme>(read);

  React.useEffect(() => {
    const update = () => setResolved(read());
    update();
    if (mode === "inherit") return watchHostTheme(update);
    if (mode === "auto") {
      const offPref = subscribeThemePref(update);
      const offSystem = subscribeSystemTheme(update);
      return () => {
        offPref();
        offSystem();
      };
    }
    return undefined;
  }, [mode, read]);

  return resolved;
}

/** Props for {@link EntitlementsDashboard}. */
export interface EntitlementsDashboardProps {
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
   * - `"memory"` — in-memory only; no URL coupling at all.
   * - a custom wouter location hook.
   */
  routing?: "hash" | "browser" | "memory" | BaseLocationHook;
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

let fallbackClient: QueryClient | undefined;
function getClient(): QueryClient {
  fallbackClient ??= new QueryClient({
    defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false } },
  });
  return fallbackClient;
}

function Embed({
  apiBaseUrl = "",
  credentials,
  fetch: fetchImpl,
  queryClient,
  theme = "auto",
  className,
  routing = "hash",
  routerBase = "",
  logoUrl,
  portal,
}: EntitlementsDashboardProps & { portal: boolean }): React.ReactElement {
  // Set the API base synchronously so child queries (run on mount) use it.
  setApiBase(apiBaseUrl, { credentials, fetch: fetchImpl });
  const resolvedTheme = useEmbedTheme(theme);
  const client = queryClient ?? getClient();

  // Point Base UI portals (popups, dialogs) at the scoped wrapper so they stay
  // inside `.xtandard-entitlements` — the embed stylesheet is scoped.
  const wrapperRef = React.useRef<HTMLDivElement>(null);
  setPortalContainerRef(wrapperRef);

  const memoryHook = React.useMemo(() => memoryLocation().hook, []);
  const { hook, base } = React.useMemo(() => {
    if (typeof routing === "function") return { hook: routing, base: routerBase };
    if (routing === "browser") return { hook: useBrowserLocation, base: routerBase };
    if (routing === "memory") return { hook: memoryHook, base: "" };
    return { hook: useHashLocation, base: "" };
  }, [routing, routerBase, memoryHook]);

  return (
    <QueryClientProvider client={client}>
      {/* Toasts render inside the wrapper so the scoped stylesheet + theme reach them. */}
      <div
        ref={wrapperRef}
        data-theme={resolvedTheme}
        className={className ? `xtandard-entitlements ${className}` : "xtandard-entitlements"}
      >
        <ToastProvider>
          <App
            locationHook={hook}
            base={base}
            logoUrl={logoUrl}
            showThemeToggle={theme === "auto"}
            forcePortal={portal}
          />
        </ToastProvider>
      </div>
    </QueryClientProvider>
  );
}

/** The full admin dashboard (Overview, Catalog, Customers, Activity) as a React component. */
export function EntitlementsDashboard(props: EntitlementsDashboardProps): React.ReactElement {
  return <Embed {...props} portal={false} />;
}

/**
 * The customer portal (plan, usage vs. limits, plan comparison with checkout,
 * "Manage billing") as a React component, scoped by a portal token.
 */
export function CustomerPortal({ token, ...rest }: CustomerPortalProps): React.ReactElement {
  // Attach the token synchronously so the first queries send it; the effect
  // keeps it current when the host swaps tokens (re-mint on expiry). The API
  // client is module-level state, so this assumes one embed per page.
  setApiToken(token);
  React.useEffect(() => {
    setApiToken(token);
  }, [token]);
  return <Embed {...rest} portal />;
}

export { setApiBase, setApiToken, type FetchLike } from "./ui/api.ts";
export {
  setThemePref,
  getThemePref,
  detectHostTheme,
  type ThemePref,
  type ResolvedTheme,
} from "./ui/theme.ts";
export default EntitlementsDashboard;

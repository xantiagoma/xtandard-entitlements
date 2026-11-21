import React from "react";
import { Router, Switch, Route, useLocation, useSearchParams, type BaseLocationHook } from "wouter";
import { useHashLocation } from "wouter/use-hash-location";
import { useQuery } from "@tanstack/react-query";
import { Lock } from "lucide-react";
import type { PanelConfig } from "./types.ts";
import { getApiToken, getConfig } from "./api.ts";
import { BrandMark } from "./components/ent-bits.tsx";
import { OverviewView } from "./views/OverviewView.tsx";
import { CatalogView } from "./views/CatalogView.tsx";
import { CustomersView } from "./views/CustomersView.tsx";
import { CustomerDetailView } from "./views/CustomerDetailView.tsx";
import { ActivityView } from "./views/ActivityView.tsx";
import { PortalView } from "./views/PortalView.tsx";
import { canLeave, cn, ThemeToggle } from "@xtandard/kit/ui";

interface NavTab {
  path: string;
  label: string;
  match: (loc: string) => boolean;
}

// Admin nav tabs. Portal mode has no tabs: it is a single page.
const NAV_TABS: NavTab[] = [
  { path: "/", label: "Overview", match: (l) => l === "/" },
  { path: "/catalog", label: "Catalog", match: (l) => l.startsWith("/catalog") },
  { path: "/customers", label: "Customers", match: (l) => l.startsWith("/customers") },
  { path: "/activity", label: "Activity", match: (l) => l.startsWith("/activity") },
];

declare global {
  interface Window {
    __ENTITLEMENTS_CONFIG__?: PanelConfig;
  }
}

function getBootstrap(): Partial<PanelConfig> {
  return typeof window === "undefined" ? {} : (window.__ENTITLEMENTS_CONFIG__ ?? {});
}

/**
 * The panel, wrapped in a wouter {@link Router}. `locationHook` + `base` make
 * routing pluggable: the bundled SPA uses browser history (clean paths, served by
 * the handler's SPA catch-all), while the embeds default to hash routing so they
 * never touch the host app's router.
 */
export function App({
  locationHook,
  searchHook,
  base = "",
  logoUrl,
  showThemeToggle = true,
  forcePortal = false,
}: {
  locationHook?: BaseLocationHook;
  /** The query-string source (the embed's memory router keeps `?customer=` etc.). */
  searchHook?: () => string;
  base?: string;
  /** Override the navbar logo image (otherwise taken from server `/config`). */
  logoUrl?: string;
  /** Show the system/light/dark switcher. Off when an embedding host owns the theme. */
  showThemeToggle?: boolean;
  /** Render the customer portal chrome regardless of `/config` (the portal embed). */
  forcePortal?: boolean;
}): React.ReactElement {
  return (
    <Router
      hook={locationHook ?? useHashLocation}
      {...(searchHook ? { searchHook } : {})}
      base={base}
    >
      <AppShell logoUrl={logoUrl} showThemeToggle={showThemeToggle} forcePortal={forcePortal} />
    </Router>
  );
}

function AppShell({
  logoUrl,
  showThemeToggle,
  forcePortal,
}: {
  logoUrl?: string;
  showThemeToggle: boolean;
  forcePortal: boolean;
}) {
  const bootstrap = getBootstrap();
  const [location, navigate] = useLocation();
  const [searchParams] = useSearchParams();

  const configQuery = useQuery({
    queryKey: ["config"],
    queryFn: getConfig,
    staleTime: 60_000,
  });

  const config = configQuery.data ?? (bootstrap as PanelConfig);
  const readonly = config?.readonly ?? false;
  // Portal mode: the request carries a portal token — reduced, single-page chrome.
  // A token we were handed means portal even when /config rejects it (expired /
  // invalid): the portal page then shows the error instead of the admin chrome.
  const portal = forcePortal || config?.mode === "portal" || getApiToken() !== null;

  // Branding: explicit props win, then server /config, then defaults.
  const brandTitle = config?.title || (portal ? "Billing" : "Entitlements");
  const brandLogoUrl = logoUrl ?? config?.logoUrl;

  // All in-app navigation funnels through here so a view with unsaved edits can
  // veto the move (wouter has no built-in blocker).
  const go = (path: string) => {
    if (!canLeave()) return;
    navigate(path);
  };

  const previewCustomer = !portal && location === "/portal" ? searchParams.get("customer") : null;

  if (configQuery.isLoading && !bootstrap.title && !forcePortal) {
    return <div className="h-screen bg-background" aria-busy="true" />;
  }

  return (
    <div className="flex min-h-screen flex-col bg-background text-foreground">
      {/* ── Top Nav ──────────────────────────────────────────────────────── */}
      <header className="sticky top-0 z-40 border-b border-border bg-background/85 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-6xl items-center gap-3 px-4 sm:px-6">
          <a
            href={portal ? undefined : "#"}
            onClick={(e) => {
              e.preventDefault();
              if (!portal) go("/");
            }}
            className="flex shrink-0 items-center gap-2 rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {brandLogoUrl ? (
              <img
                src={brandLogoUrl}
                alt={brandTitle}
                className="h-7 max-w-[320px] object-contain"
              />
            ) : (
              <>
                <BrandMark className="h-5 w-auto" />
                <span className="text-sm font-semibold tracking-tight">{brandTitle}</span>
              </>
            )}
          </a>

          {portal && config?.customer ? (
            <>
              <span className="select-none text-border">/</span>
              <span className="truncate font-mono text-[13px] text-muted-foreground">
                {config.customer}
              </span>
            </>
          ) : null}

          <div className="ml-auto flex items-center gap-2">
            {readonly && !portal && (
              <span className="flex items-center gap-1 rounded-md border border-warning/30 bg-warning/10 px-2 py-0.5 text-xs font-medium text-warning">
                <Lock className="size-3" />
                Read-only
              </span>
            )}
            {portal && (
              <span className="rounded-md border border-accent/35 bg-accent/10 px-2 py-0.5 text-xs font-medium text-accent">
                Customer portal
              </span>
            )}
            {showThemeToggle && <ThemeToggle />}
          </div>
        </div>

        {!portal && (
          <nav
            className="mx-auto flex max-w-6xl items-center gap-1 overflow-x-auto px-2 sm:px-4"
            aria-label="Main navigation"
          >
            {NAV_TABS.map(({ path, label, match }) => {
              const active = match(location);
              return (
                <button
                  key={path}
                  type="button"
                  aria-current={active ? "page" : undefined}
                  onClick={() => go(path)}
                  className={cn(
                    "whitespace-nowrap px-3 py-2.5 text-[13px] font-medium outline-none transition-colors focus-visible:text-foreground",
                    active
                      ? "relative text-foreground after:absolute after:inset-x-3 after:-bottom-px after:h-0.5 after:rounded-full after:bg-accent"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {label}
                </button>
              );
            })}
          </nav>
        )}
      </header>

      {/* ── Main content (routed) ────────────────────────────────────────── */}
      <main className="flex-1">
        {portal ? (
          <PortalView />
        ) : (
          <Switch>
            <Route path="/catalog">
              <CatalogView />
            </Route>
            <Route path="/customers/:id">
              {(params) => (
                <CustomerDetailView
                  id={decodeURIComponent(params.id)}
                  readonly={readonly}
                  onBack={() => go("/customers")}
                  onOpenPortal={(id) => go(`/portal?customer=${encodeURIComponent(id)}`)}
                />
              )}
            </Route>
            <Route path="/customers">
              <CustomersView onOpen={(id) => go(`/customers/${encodeURIComponent(id)}`)} />
            </Route>
            <Route path="/activity">
              <ActivityView onOpenCustomer={(id) => go(`/customers/${encodeURIComponent(id)}`)} />
            </Route>
            <Route path="/portal">
              {previewCustomer ? (
                <PortalView
                  previewCustomer={previewCustomer}
                  onExitPreview={() => go(`/customers/${encodeURIComponent(previewCustomer)}`)}
                />
              ) : (
                <OverviewView
                  onOpenCustomer={(id) => go(`/customers/${encodeURIComponent(id)}`)}
                  onOpenCustomers={() => go("/customers")}
                  onOpenActivity={() => go("/activity")}
                />
              )}
            </Route>
            <Route>
              <OverviewView
                onOpenCustomer={(id) => go(`/customers/${encodeURIComponent(id)}`)}
                onOpenCustomers={() => go("/customers")}
                onOpenActivity={() => go("/activity")}
              />
            </Route>
          </Switch>
        )}
      </main>
    </div>
  );
}

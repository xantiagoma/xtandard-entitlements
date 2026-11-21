/**
 * `@xtandard/entitlements/react` — hooks and small components for gating your
 * **product** UI on a customer's plan: hide a button, show a usage meter,
 * render the pricing table, prompt an upgrade.
 *
 * ```tsx
 * import { EntitlementsProvider, Gate, UsageMeter } from "@xtandard/entitlements/react";
 *
 * <EntitlementsProvider baseUrl="/billing" token={portalToken}>
 *   <Gate feature="export_pdf" fallback={<UpgradePrompt feature="export_pdf" />}>
 *     <ExportButton />
 *   </Gate>
 *   <UsageMeter feature="api_calls" />
 * </EntitlementsProvider>
 * ```
 *
 * Plain React — no TanStack Query, no Base UI, no stylesheet. Components are
 * unstyled: they take `className` and expose `data-*` attributes (`data-state`,
 * `data-level`, `data-current`, …) to style against; the optional
 * `@xtandard/entitlements/react/components.css` gives them a sensible default.
 *
 * **Client-side gates are UX, not security.** They read the customer's
 * entitlements to decide what to *show*. Anyone can flip a boolean in devtools;
 * enforce on the server with `ent.check()` / `ent.consume()` or the adapters'
 * `requireEntitlement` guards.
 *
 * @module react
 */

import React from "react";
import {
  pricingTable,
  type AnyCatalog,
  type FeatureKey,
  type FeatureKeyOfKind,
  type FeatureValue,
  type PlanKey,
  type PricingPlan,
  type PricingTable as PricingTableData,
} from "../catalog.ts";
import type { JsonValue } from "../schema.ts";
import {
  computeEntitlement,
  currentPlanOf,
  customerInfo,
  formatCount,
  meterState,
  monthlyPrice,
  type CustomerInfo,
  type EntitlementState,
  type EntitlementsData,
  type PortalData,
} from "./compute.ts";

export {
  computeEntitlement,
  covers,
  customerInfo,
  meterState,
  unlockersFromPricing,
} from "./compute.ts";
export type {
  CustomerInfo,
  EntitlementState,
  EntitlementsData,
  MeterLevel,
  PortalData,
} from "./compute.ts";

/* ─── Provider ──────────────────────────────────────────────────────────────── */

/** A portal token, or a function that returns a fresh one (re-mint on expiry). */
export type TokenSource = string | (() => string | Promise<string>);

/** Props for {@link EntitlementsProvider}. Give one source: `baseUrl`, `fetcher` or `initial`. */
export interface EntitlementsProviderProps {
  /**
   * Where the panel is mounted (e.g. `"/billing"`); the provider fetches
   * `{baseUrl}/api/portal/me` with the portal `token`.
   */
  baseUrl?: string;
  /** Portal token (`entpt_…`) minted by your server after its own auth. */
  token?: TokenSource;
  /** `credentials` for the `baseUrl` fetches. Default `"same-origin"`. */
  credentials?: RequestCredentials;
  /** Load the data yourself (your own API route, a server action, a test double). */
  fetcher?: () => Promise<EntitlementsData>;
  /**
   * Server-rendered data (SSR / RSC): rendered immediately, no fetch on mount.
   * Call `refresh()` to reload from `baseUrl` / `fetcher`.
   */
  initial?: EntitlementsData;
  /** Re-fetch every N ms (e.g. `60_000` to keep meters fresh). Off by default. */
  refreshInterval?: number;
  /** Called when a load fails (the last good data is kept). */
  onError?: (error: unknown) => void;
  children?: React.ReactNode;
}

/** What {@link useEntitlements} returns. */
export interface EntitlementsContextValue {
  /** The loaded data (`null` until the first load). */
  data: EntitlementsData | null;
  /** True until the first load settles. */
  loading: boolean;
  /** The last load error (data stays at its last good value). */
  error: unknown;
  /** Reload now. Resolves when the load settles. */
  refresh: () => Promise<void>;
  /**
   * Portal checkout link-out for a plan or add-on (`POST /api/portal/checkout`),
   * redirecting the browser. Only with `baseUrl` + `token`.
   */
  checkout?: (plan: string, options?: { successUrl?: string; cancelUrl?: string }) => Promise<void>;
}

const Ctx = React.createContext<EntitlementsContextValue | null>(null);

async function resolveToken(token: TokenSource | undefined): Promise<string | undefined> {
  return typeof token === "function" ? token() : token;
}

/** `fetch` JSON from the panel with the portal token; throws on non-2xx. */
async function panelFetch<T>(
  baseUrl: string,
  path: string,
  token: TokenSource | undefined,
  credentials: RequestCredentials,
  init?: RequestInit,
): Promise<T> {
  const bearer = await resolveToken(token);
  const res = await fetch(`${baseUrl.replace(/\/$/, "")}/${path}`, {
    credentials,
    ...init,
    headers: {
      "content-type": "application/json",
      ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
    },
  });
  if (!res.ok) {
    let message = `HTTP ${res.status}`;
    try {
      message = ((await res.json()) as { error?: string }).error ?? message;
    } catch {
      /* not JSON */
    }
    throw new Error(message);
  }
  return (await res.json()) as T;
}

/**
 * Loads a customer's entitlements once and shares them with every hook and
 * component below it. Re-renders only when the data changes.
 */
export function EntitlementsProvider({
  baseUrl,
  token,
  credentials = "same-origin",
  fetcher,
  initial,
  refreshInterval,
  onError,
  children,
}: EntitlementsProviderProps): React.ReactElement {
  const [data, setData] = React.useState<EntitlementsData | null>(initial ?? null);
  const [error, setError] = React.useState<unknown>(null);
  const [loading, setLoading] = React.useState(initial === undefined);

  // Keep the latest source in a ref so `refresh` stays stable across renders.
  const source = React.useRef({ baseUrl, token, credentials, fetcher, onError });
  source.current = { baseUrl, token, credentials, fetcher, onError };
  const hasRemote = baseUrl !== undefined || fetcher !== undefined;

  const refresh = React.useCallback(async () => {
    const s = source.current;
    const load =
      s.fetcher ??
      (s.baseUrl !== undefined
        ? () => panelFetch<PortalData>(s.baseUrl!, "api/portal/me", s.token, s.credentials)
        : undefined);
    if (!load) {
      setLoading(false);
      return;
    }
    try {
      const next = await load();
      setData(next);
      setError(null);
    } catch (e) {
      setError(e);
      s.onError?.(e);
    } finally {
      setLoading(false);
    }
  }, []);

  // Fetch on mount (and when the source identity changes) unless seeded.
  const tokenKey = typeof token === "string" ? token : "";
  React.useEffect(() => {
    if (initial === undefined && hasRemote) void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [baseUrl, tokenKey, fetcher, hasRemote, refresh]);

  React.useEffect(() => {
    if (!refreshInterval || !hasRemote) return undefined;
    const t = setInterval(() => void refresh(), refreshInterval);
    return () => clearInterval(t);
  }, [refreshInterval, hasRemote, refresh]);

  const checkout = React.useMemo(() => {
    if (baseUrl === undefined) return undefined;
    return async (plan: string, options: { successUrl?: string; cancelUrl?: string } = {}) => {
      const s = source.current;
      const here = typeof window === "undefined" ? undefined : window.location.href;
      const { url } = await panelFetch<{ url: string }>(
        s.baseUrl!,
        "api/portal/checkout",
        s.token,
        s.credentials,
        {
          method: "POST",
          body: JSON.stringify({
            plan,
            successUrl: options.successUrl ?? here,
            cancelUrl: options.cancelUrl ?? here,
          }),
        },
      );
      window.location.assign(url);
    };
  }, [baseUrl]);

  const value = React.useMemo<EntitlementsContextValue>(
    () => ({ data, loading, error, refresh, ...(checkout ? { checkout } : {}) }),
    [data, loading, error, refresh, checkout],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/* ─── Hooks ─────────────────────────────────────────────────────────────────── */

/** The provider's state: data, loading, error, `refresh()`, `checkout()`. */
export function useEntitlements(): EntitlementsContextValue {
  const ctx = React.useContext(Ctx);
  if (!ctx) throw new Error("useEntitlements must be used within <EntitlementsProvider>");
  return ctx;
}

/**
 * One feature, computed client-side: `{ allowed, enabled, limit, used,
 * remaining, value, resetsAt, loading, unlockedBy }`. `amount` is what the UI
 * is about to ask for (default 1). UX only — enforce on the server.
 */
export function useEntitlement<V = JsonValue | undefined>(
  feature: string,
  options: { amount?: number } = {},
): EntitlementState<V> {
  const { data } = useEntitlements();
  const amount = options.amount ?? 1;
  return React.useMemo(() => computeEntitlement<V>(data, feature, amount), [data, feature, amount]);
}

/** The customer: profile, current plan + status, trial / period end, link-out availability. */
export function useCustomer(): CustomerInfo {
  const { data } = useEntitlements();
  return React.useMemo(() => customerInfo(data), [data]);
}

/* ─── <Gate> ────────────────────────────────────────────────────────────────── */

/** Props for {@link Gate}. */
export interface GateProps<F extends string = string> {
  feature: F;
  /** Units about to be used (numeric features). Default 1. */
  amount?: number;
  /** Rendered when not allowed. Default nothing. */
  fallback?: React.ReactNode;
  /** Rendered while the data loads. Default nothing. */
  loading?: React.ReactNode;
  /** Content when allowed, or a render function receiving the state. */
  children?: React.ReactNode | ((state: EntitlementState) => React.ReactNode);
}

/**
 * Render `children` when the customer has `feature` (for `amount` units),
 * `fallback` otherwise. **UX only** — the server must still check.
 */
export function Gate<F extends string = string>({
  feature,
  amount,
  fallback = null,
  loading = null,
  children,
}: GateProps<F>): React.ReactElement {
  const state = useEntitlement(feature, amount === undefined ? {} : { amount });
  if (typeof children === "function") return <>{children(state)}</>;
  if (state.loading) return <>{loading}</>;
  return <>{state.allowed ? children : fallback}</>;
}

/* ─── <UsageMeter> ──────────────────────────────────────────────────────────── */

/** Props for {@link UsageMeter}. */
export interface UsageMeterProps<F extends string = string> {
  feature: F;
  /** Visible + accessible label. Default: the feature's name from the pricing table. */
  label?: string;
  /** Hide the text row (label, `used / limit`, resets). */
  hideText?: boolean;
  className?: string;
  /** Format numbers (default `1,000`). */
  format?: (n: number) => string;
}

/**
 * An accessible usage meter (`role="progressbar"`) for a numeric feature.
 * `data-level` = `ok | warn | critical | unlimited | disabled`; the fill's width
 * is the only inline style. Parts: `[data-part=label|value|track|fill|reset]`.
 */
export function UsageMeter<F extends string = string>({
  feature,
  label,
  hideText,
  className,
  format = formatCount,
}: UsageMeterProps<F>): React.ReactElement {
  const { data } = useEntitlements();
  const state = useEntitlement(feature);
  const { ratio, level } = meterState(state);
  const name =
    label ??
    (data && "pricing" in data
      ? data.pricing.features.find((f) => f.key === feature)?.name
      : undefined) ??
    feature;
  const used = state.used ?? 0;
  const limit = state.limit;
  const valueText =
    limit === null
      ? `${format(used)} used`
      : limit === undefined
        ? "—"
        : `${format(used)} / ${format(limit)}`;
  const pct = ratio === null ? 0 : Math.min(100, Math.max(0, ratio * 100));
  return (
    <div
      className={className}
      data-xe="meter"
      data-level={level}
      data-state={state.loading ? "loading" : state.allowed ? "allowed" : "blocked"}
    >
      {hideText ? null : (
        <div data-part="text">
          <span data-part="label">{name}</span>
          <span data-part="value">{valueText}</span>
        </div>
      )}
      <div
        data-part="track"
        role="progressbar"
        aria-label={name}
        aria-valuemin={0}
        aria-valuemax={typeof limit === "number" ? limit : undefined}
        aria-valuenow={state.loading ? undefined : used}
        aria-valuetext={
          state.loading ? "Loading" : limit === null ? `${format(used)} used, unlimited` : valueText
        }
      >
        <div data-part="fill" style={{ width: `${pct}%` }} />
      </div>
      {hideText || !state.resetsAt ? null : (
        <span data-part="reset">
          Resets{" "}
          <time dateTime={state.resetsAt}>{new Date(state.resetsAt).toLocaleDateString()}</time>
        </span>
      )}
    </div>
  );
}

/* ─── <PricingTable> ────────────────────────────────────────────────────────── */

/** Props for {@link PricingTable}. Pass `pricing` or `catalog`, or neither to use the provider's. */
export interface PricingTableProps<P extends string = string> {
  /** A `PricingTable` (e.g. from `GET /api/pricing` or `pricingTable(catalog)`). */
  pricing?: PricingTableData;
  /** Or the catalog itself (current, non-hidden plans). */
  catalog?: AnyCatalog;
  /** Marked `data-current`; its button is disabled. Default: the provider's customer plan. */
  currentPlan?: P;
  /** Show a button per plan; called with its key. */
  onSelect?: (plan: P) => void;
  /** Button text. Default `"Current plan"` / `"Upgrade"` / `"Downgrade"` / `"Choose"`. */
  actionLabel?: (
    plan: PricingPlan,
    relation: "current" | "upgrade" | "downgrade" | "choose",
  ) => React.ReactNode;
  /** Only plans of this group. */
  group?: string;
  className?: string;
}

/** Format a plan's first display price: `"$29 / month"`, `"Free"`. */
export function formatPlanPrice(plan: Pick<PricingPlan, "price">): string {
  const p = plan.price[0];
  if (!p) return "Free";
  if (p.label) return p.label;
  if (p.amount === 0) return "Free";
  const money = new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: p.currency.toUpperCase(),
    minimumFractionDigits: p.amount % 100 === 0 ? 0 : 2,
  }).format(p.amount / 100);
  return p.interval && p.interval !== "one_time" ? `${money} / ${p.interval}` : money;
}

/**
 * Render a pricing table: `[data-xe=pricing]` > `article[data-xe=plan]` per plan
 * (`data-current`, `data-highlight`), each with name, price, an optional button
 * and the feature list (`li[data-included]`). Unstyled.
 */
export function PricingTable<P extends string = string>({
  pricing,
  catalog,
  currentPlan,
  onSelect,
  actionLabel,
  group,
  className,
}: PricingTableProps<P>): React.ReactElement | null {
  const ctx = React.useContext(Ctx);
  const fromCtx = ctx?.data && "pricing" in ctx.data ? ctx.data.pricing : undefined;
  const table = React.useMemo(
    () => pricing ?? (catalog ? pricingTable(catalog) : fromCtx),
    [pricing, catalog, fromCtx],
  );
  if (!table) return null;
  const current = currentPlan ?? (currentPlanOf(ctx?.data ?? null)?.plan as P | undefined);
  const plans = group ? table.plans.filter((p) => p.group === group) : table.plans;
  const currentPrice = monthlyPrice(plans.find((p) => p.key === current)?.price);
  const currentIndex = plans.findIndex((p) => p.key === current);
  return (
    <div className={className} data-xe="pricing">
      {plans.map((plan, i) => {
        const relation =
          plan.key === current
            ? "current"
            : currentIndex === -1
              ? "choose"
              : monthlyPrice(plan.price) > currentPrice ||
                  (monthlyPrice(plan.price) === currentPrice && i > currentIndex)
                ? "upgrade"
                : "downgrade";
        const label =
          actionLabel?.(plan, relation) ??
          (relation === "current"
            ? "Current plan"
            : relation === "upgrade"
              ? "Upgrade"
              : relation === "downgrade"
                ? "Downgrade"
                : "Choose");
        return (
          <article
            key={plan.key}
            data-xe="plan"
            data-plan={plan.key}
            data-current={relation === "current" || undefined}
            data-highlight={plan.highlight || undefined}
            aria-label={`${plan.name} plan`}
          >
            <h3 data-part="name">{plan.name}</h3>
            {plan.description ? <p data-part="description">{plan.description}</p> : null}
            <p data-part="price">{formatPlanPrice(plan)}</p>
            {plan.trialDays ? <p data-part="trial">{plan.trialDays}-day free trial</p> : null}
            {onSelect ? (
              <button
                type="button"
                data-part="action"
                data-relation={relation}
                disabled={relation === "current"}
                onClick={() => onSelect(plan.key as P)}
              >
                {label}
              </button>
            ) : null}
            <ul data-part="features">
              {table.features.map((f) => {
                const cell = plan.features[f.key];
                if (!cell) return null;
                return (
                  <li key={f.key} data-feature={f.key} data-included={cell.included}>
                    {f.kind === "boolean" ? f.name : `${cell.label} · ${f.name}`}
                  </li>
                );
              })}
            </ul>
          </article>
        );
      })}
    </div>
  );
}

/* ─── <UpgradePrompt> ───────────────────────────────────────────────────────── */

/** Props for {@link UpgradePrompt}. */
export interface UpgradePromptProps<F extends string = string> {
  feature: F;
  amount?: number;
  /** Called with the cheapest unlocking plan. Default: the provider's `checkout` link-out. */
  onUpgrade?: (plan: string) => void;
  /** Custom content; receives the cheapest plan's key + name and the full state. */
  children?: (args: { plan: string; planName: string; state: EntitlementState }) => React.ReactNode;
  className?: string;
}

/**
 * When `feature` is blocked and some plan would unlock it: "Upgrade to Pro to
 * use PDF export" with a button. Renders nothing when allowed, loading, or no
 * plan would help (a hard `forbidden`).
 */
export function UpgradePrompt<F extends string = string>({
  feature,
  amount,
  onUpgrade,
  children,
  className,
}: UpgradePromptProps<F>): React.ReactElement | null {
  const { data, checkout } = useEntitlements();
  const state = useEntitlement(feature, amount === undefined ? {} : { amount });
  const [busy, setBusy] = React.useState(false);
  if (state.loading || state.allowed || state.unlockedBy.length === 0) return null;
  const plan = state.unlockedBy[0]!;
  const pricing = data && "pricing" in data ? data.pricing : undefined;
  const planName =
    pricing?.plans.find((p) => p.key === plan)?.name ??
    pricing?.addons.find((a) => a.key === plan)?.name ??
    plan;
  const featureName = pricing?.features.find((f) => f.key === feature)?.name ?? feature;
  if (children) return <>{children({ plan, planName, state })}</>;
  const act =
    onUpgrade ??
    (checkout ? (p: string) => void checkout(p).catch(() => setBusy(false)) : undefined);
  return (
    <div
      className={className}
      data-xe="upgrade"
      data-reason={state.enabled ? "limit" : "plan"}
      role="note"
    >
      <p data-part="message">
        {state.enabled
          ? `You've reached your ${featureName} limit. Upgrade to ${planName} for more.`
          : `Upgrade to ${planName} to use ${featureName}.`}
      </p>
      {act ? (
        <button
          type="button"
          data-part="action"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            act(plan);
          }}
        >
          Upgrade to {planName}
        </button>
      ) : null}
    </div>
  );
}

/* ─── Catalog-typed variants ────────────────────────────────────────────────── */

/** Numeric feature keys (metered, credits, capacity) of a catalog. */
type NumericKey<C> = FeatureKeyOfKind<C, "metered" | "credits" | "capacity">;

/** What {@link createEntitlementsReact} returns: the same API, typed by your catalog. */
export interface TypedEntitlementsReact<C extends AnyCatalog> {
  EntitlementsProvider: typeof EntitlementsProvider;
  useEntitlements: typeof useEntitlements;
  useEntitlement: <K extends FeatureKey<C>>(
    feature: K,
    options?: { amount?: number },
  ) => EntitlementState<FeatureValue<C, K>>;
  useCustomer: () => CustomerInfo<PlanKey<C>>;
  Gate: <K extends FeatureKey<C>>(props: GateProps<K>) => React.ReactElement;
  UsageMeter: <K extends NumericKey<C>>(props: UsageMeterProps<K>) => React.ReactElement;
  PricingTable: (props: PricingTableProps<PlanKey<C>>) => React.ReactElement | null;
  UpgradePrompt: <K extends FeatureKey<C>>(
    props: UpgradePromptProps<K>,
  ) => React.ReactElement | null;
}

/**
 * Catalog-typed hooks and components: feature keys autocomplete, value
 * features return their declared type, `UsageMeter` only takes numeric
 * features, plan keys are checked.
 *
 * ```ts
 * import type { catalog } from "./catalog";
 * export const { Gate, useEntitlement, UsageMeter } = createEntitlementsReact<typeof catalog>();
 * ```
 */
export function createEntitlementsReact<C extends AnyCatalog>(): TypedEntitlementsReact<C> {
  return {
    EntitlementsProvider,
    useEntitlements,
    useEntitlement: useEntitlement as TypedEntitlementsReact<C>["useEntitlement"],
    useCustomer: useCustomer as TypedEntitlementsReact<C>["useCustomer"],
    Gate,
    UsageMeter,
    PricingTable: PricingTable as TypedEntitlementsReact<C>["PricingTable"],
    UpgradePrompt,
  };
}

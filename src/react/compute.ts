/**
 * Pure, dependency-free computations behind `@xtandard/entitlements/react`:
 * a feature's client-side decision from the portal data, the plans that would
 * unlock it, meter state, and the customer's current plan. No React here — it
 * is unit-tested directly and shared by the hooks and components.
 *
 * **Client-side answers are UX only.** They mirror the engine closely enough to
 * hide a button or show a meter; the server's `check` / `consume` stay the
 * authority.
 *
 * @module
 */

import type { PriceDisplay, PricingTable } from "../catalog.ts";
import type {
  ActivePlan,
  CustomerEntitlements,
  FeatureKind,
  FeatureUsage,
  JsonValue,
  SubscriptionStatus,
} from "../schema.ts";

/**
 * What `GET /api/portal/me` returns, and what the provider holds: the
 * customer's entitlements with usage, profile, public pricing and link-out
 * availability.
 */
export interface PortalData extends CustomerEntitlements {
  profile: { id: string; name?: string; email?: string };
  pricing: PricingTable;
  canCheckout: boolean;
  canManage: boolean;
}

/** Data a provider can be seeded with: the full portal view, or entitlements alone. */
export type EntitlementsData = PortalData | CustomerEntitlements;

/** A feature's state, computed client-side by `useEntitlement`. */
export interface EntitlementState<V = JsonValue | undefined> {
  /** Would a request for `amount` be allowed right now (UX hint, not enforcement). */
  allowed: boolean;
  /** Included at all (boolean on, numeric in plan, value present). */
  enabled: boolean;
  /** `"unknown"` before data arrives or for features the data doesn't know. */
  kind: FeatureKind | "unknown";
  /** Numeric features: `null` = unlimited, `undefined` = not numeric. */
  limit: number | null | undefined;
  used: number | undefined;
  /** `null` = unlimited. */
  remaining: number | null | undefined;
  /** Usage beyond the limit this period (overage allowed). */
  overage: number | undefined;
  /** Value features: the resolved value. */
  value: V;
  /** When usage starts over (`null` = never). */
  resetsAt: string | null | undefined;
  /** No data yet. */
  loading: boolean;
  /** Plans / add-ons (from the public pricing) that would allow it, cheapest first. */
  unlockedBy: string[];
}

const NUMERIC = new Set<string>(["metered", "credits", "capacity"]);

/** Is a feature kind numeric (limit + usage)? */
export const isNumericKind = (kind: string): boolean => NUMERIC.has(kind);

/** The state of a feature while nothing has loaded. */
export function loadingState<V = JsonValue | undefined>(): EntitlementState<V> {
  return {
    allowed: false,
    enabled: false,
    kind: "unknown",
    limit: undefined,
    used: undefined,
    remaining: undefined,
    overage: undefined,
    value: undefined as V,
    resetsAt: undefined,
    loading: true,
    unlockedBy: [],
  };
}

/** Headroom beyond the allowance when overage is allowed (mirrors the ledger). */
function overageRoom(u: FeatureUsage): number {
  if (u.overagePolicy !== "allow") return 0;
  const allowance = u.allowance;
  if (allowance === null || allowance === undefined) return Infinity;
  if (u.overageLimit === null || u.overageLimit === undefined) return Infinity;
  const grantUsed = (u.grantBalances ?? []).reduce((s, g) => s + g.used, 0);
  const periodUsed = Math.max(0, (u.used ?? 0) - grantUsed);
  return Math.max(0, allowance + u.overageLimit - Math.max(periodUsed, allowance));
}

/** Would `amount` more units fit in this feature's current state? */
export function covers(u: FeatureUsage, amount: number): boolean {
  if (!u.enabled) return false;
  if (!isNumericKind(u.kind)) return true;
  if (u.limit === null || u.limit === undefined) return true;
  const remaining = u.remaining ?? Math.max(0, u.limit - (u.used ?? 0));
  if (remaining === null) return true;
  return remaining + overageRoom(u) + 1e-9 >= amount;
}

/** Monthly-normalized display price in minor units (sorting only). */
export function monthlyPrice(prices: readonly PriceDisplay[] | undefined): number {
  const p = prices?.[0];
  if (!p) return 0;
  if (p.interval === "year") return p.amount / 12;
  if (p.interval === "week") return (p.amount * 52) / 12;
  if (p.interval === "day") return p.amount * 30;
  return p.amount;
}

/**
 * Plans and add-ons in a pricing table that would allow `feature` for a total
 * of `needed` units, excluding the customer's `active` plans. Cheapest first,
 * then table order (the client-side twin of the engine's `unlockingPlans`).
 */
export function unlockersFromPricing(
  pricing: PricingTable | undefined,
  feature: string,
  needed: number,
  active: readonly string[] = [],
): string[] {
  if (!pricing) return [];
  const out: { key: string; price: number; order: number }[] = [];
  pricing.plans.forEach((p, order) => {
    if (active.includes(p.key)) return;
    const cell = p.features[feature];
    if (!cell?.included) return;
    const ok =
      cell.limit === undefined ||
      cell.limit === null ||
      cell.limit >= needed ||
      cell.overage === "allow";
    if (ok) out.push({ key: p.key, price: monthlyPrice(p.price), order });
  });
  pricing.addons.forEach((a, i) => {
    if (a.requires.length > 0 && !a.requires.some((r) => active.includes(r))) return;
    const cell = a.features[feature];
    if (!cell?.included) return;
    if (cell.limit === undefined || cell.limit === null || cell.limit > 0) {
      out.push({ key: a.key, price: monthlyPrice(a.price), order: pricing.plans.length + i });
    }
  });
  return out.sort((a, b) => a.price - b.price || a.order - b.order).map((x) => x.key);
}

const pricingOf = (data: EntitlementsData): PricingTable | undefined =>
  "pricing" in data ? data.pricing : undefined;

/**
 * A feature's client-side state from the provider's data (`null` = still
 * loading). `amount` is what the UI is about to ask for (default 1).
 */
export function computeEntitlement<V = JsonValue | undefined>(
  data: EntitlementsData | null,
  feature: string,
  amount = 1,
): EntitlementState<V> {
  if (!data) return loadingState<V>();
  const u = data.features[feature];
  if (!u) {
    return { ...loadingState<V>(), loading: false };
  }
  const numeric = isNumericKind(u.kind);
  const allowed = covers(u, amount);
  const needed = (numeric ? (u.used ?? 0) : 0) + amount;
  const disabledByOverride = u.override !== undefined && !u.enabled;
  return {
    allowed,
    enabled: u.enabled,
    kind: u.kind,
    limit: numeric ? (u.limit ?? null) : undefined,
    used: numeric ? (u.used ?? 0) : undefined,
    remaining: numeric ? (u.remaining ?? (u.limit === null ? null : undefined)) : undefined,
    overage: numeric ? (u.overage ?? 0) : undefined,
    value: (u.kind === "value" ? u.value : undefined) as V,
    resetsAt: numeric ? u.resetsAt : undefined,
    loading: false,
    unlockedBy:
      allowed || disabledByOverride
        ? []
        : unlockersFromPricing(
            pricingOf(data),
            feature,
            needed,
            data.plans.map((p) => p.plan),
          ),
  };
}

/** Threshold level of a meter: `ok` < 75% ≤ `warn` < 90% ≤ `critical`. */
export type MeterLevel = "ok" | "warn" | "critical" | "unlimited" | "disabled";

/** Used share (0–1, uncapped) and threshold level for a meter. */
export function meterState(state: Pick<EntitlementState, "enabled" | "limit" | "used">): {
  ratio: number | null;
  level: MeterLevel;
} {
  if (!state.enabled) return { ratio: null, level: "disabled" };
  if (state.limit === null || state.limit === undefined) return { ratio: null, level: "unlimited" };
  const used = state.used ?? 0;
  const ratio = state.limit <= 0 ? (used > 0 ? 1 : 0) : used / state.limit;
  return { ratio, level: ratio >= 0.9 ? "critical" : ratio >= 0.75 ? "warn" : "ok" };
}

/** The customer's plan for display: the entitled non-default plan, else the default one. */
export function currentPlanOf(data: EntitlementsData | null): ActivePlan | undefined {
  if (!data) return undefined;
  return data.plans.find((p) => !p.default) ?? data.plans[0];
}

/** What `useCustomer` returns. */
export interface CustomerInfo<P extends string = string> {
  id: string | undefined;
  name: string | undefined;
  email: string | undefined;
  /** Current plan key (default plan when not subscribed). */
  plan: P | undefined;
  /** Display name from the pricing table (falls back to the key). */
  planName: string | undefined;
  status: SubscriptionStatus | undefined;
  /** On the default plan (no entitled subscription in the base group). */
  isDefault: boolean;
  trialEndsAt: string | undefined;
  periodEnd: string | undefined;
  cancelAtPeriodEnd: boolean;
  canCheckout: boolean;
  canManage: boolean;
  loading: boolean;
}

/** Summarise the customer for `useCustomer`. */
export function customerInfo<P extends string = string>(
  data: EntitlementsData | null,
): CustomerInfo<P> {
  const plan = currentPlanOf(data);
  const portal = data && "profile" in data ? data : null;
  return {
    id: portal?.profile.id ?? data?.customer,
    name: portal?.profile.name,
    email: portal?.profile.email,
    plan: plan?.plan as P | undefined,
    planName: plan
      ? (portal?.pricing.plans.find((p) => p.key === plan.plan)?.name ?? plan.plan)
      : undefined,
    status: plan?.status,
    isDefault: plan?.default ?? false,
    trialEndsAt: plan?.trialEndsAt,
    periodEnd: plan?.periodEnd,
    cancelAtPeriodEnd: plan?.cancelAtPeriodEnd ?? false,
    canCheckout: portal?.canCheckout ?? false,
    canManage: portal?.canManage ?? false,
    loading: data === null,
  };
}

/** `"1,000"` — thousands-separated, up to 2 decimals. */
export const formatCount = (n: number): string =>
  n.toLocaleString("en-US", { maximumFractionDigits: 2 });

/**
 * Pure entitlement resolution: `(catalog, state, now) → EntitlementSet`. No I/O,
 * no clocks — the engine caches the result per customer (ADR 0003) and the
 * browser can run it too.
 *
 * Precedence (ADR 0012): one entitled plan per group (newest wins; the group's
 * default plan when none), add-ons stack (`add × quantity`), recurring grants add
 * to the period allowance, one-off grants become their own buckets, and an
 * active override replaces the merged result.
 *
 * @module
 */

import {
  getPlanVersion,
  type AnyCatalog,
  type JsonValue,
  type NormalizedFeature,
  type NormalizedPlan,
  type PriceDisplay,
} from "./catalog.ts";
import { currentPeriod } from "./periods.ts";
import {
  DEFAULT_ENTITLED_STATUSES,
  type ActivePlan,
  type CustomerState,
  type EntitlementSet,
  type EntitlementSource,
  type GrantBucket,
  type ResolvedFeature,
  type Subscription,
  type SubscriptionStatus,
} from "./schema.ts";

/** Options for {@link resolveEntitlements}. */
export interface ResolveOptions {
  /** Statuses that grant access. Default `active`, `trialing`, `past_due`. */
  entitledStatuses?: readonly SubscriptionStatus[];
}

const ts = (iso: string | undefined): number => (iso ? Date.parse(iso) : NaN);
const activeAt = (x: { startsAt?: string; expiresAt?: string }, now: number) =>
  !(ts(x.startsAt) > now) && !(ts(x.expiresAt) <= now);

/** Why a subscription is not entitled at `now`, or `null` when it is. */
export function subscriptionInactiveReason(
  sub: Subscription,
  now: number,
  entitled: readonly SubscriptionStatus[] = DEFAULT_ENTITLED_STATUSES,
): string | null {
  if (!entitled.includes(sub.status)) return `status:${sub.status}`;
  if (sub.status === "trialing" && ts(sub.trialEndsAt) <= now) return "trial_expired";
  if (sub.cancelAtPeriodEnd && ts(sub.periodEnd) <= now) return "period_ended";
  return null;
}

/** An empty state for a customer that has never been written (default plans only). */
export function emptyCustomerState(id: string, now: number): CustomerState {
  const at = new Date(now).toISOString();
  return {
    id,
    subscriptions: [],
    grants: [],
    overrides: [],
    providers: {},
    trials: {},
    metadata: {},
    createdAt: at,
    updatedAt: at,
    revision: 0,
  };
}

const sumLimit = (a: number | null, b: number | null): number | null =>
  a === null || b === null ? null : a + b;

/**
 * Resolve a customer's entitlements at `now`. `state` may be `null` (an unknown
 * customer — default plans only).
 */
export function resolveEntitlements(
  catalog: AnyCatalog,
  state: CustomerState | null,
  now: number,
  options: ResolveOptions = {},
): EntitlementSet {
  const n = catalog.normalized;
  const customer = state ?? emptyCustomerState("", now);
  const entitled = options.entitledStatuses ?? DEFAULT_ENTITLED_STATUSES;
  const boundaries: number[] = [];
  const bound = (iso: string | undefined | null) => {
    const t = iso ? Date.parse(iso) : NaN;
    if (t > now) boundaries.push(t);
  };

  const inactive: EntitlementSet["inactive"] = [];
  const planSubs = new Map<string, { sub: Subscription; plan: NormalizedPlan }[]>();
  const addonSubs: Subscription[] = [];
  for (const sub of customer.subscriptions) {
    const reason = subscriptionInactiveReason(sub, now, entitled);
    if (reason) {
      inactive.push({ subscriptionId: sub.id, plan: sub.plan, reason });
      continue;
    }
    if (sub.status === "trialing") bound(sub.trialEndsAt);
    if (sub.cancelAtPeriodEnd) bound(sub.periodEnd);
    if (sub.kind === "addon") {
      if (!n.addons.has(sub.plan))
        inactive.push({ subscriptionId: sub.id, plan: sub.plan, reason: "unknown_addon" });
      else addonSubs.push(sub);
      continue;
    }
    const plan = getPlanVersion(catalog, sub.plan, sub.version);
    if (!plan) {
      inactive.push({ subscriptionId: sub.id, plan: sub.plan, reason: "unknown_plan" });
      continue;
    }
    const list = planSubs.get(plan.group) ?? [];
    list.push({ sub, plan });
    planSubs.set(plan.group, list);
  }

  // One plan per group: newest subscription wins; the rest are superseded.
  const active: { plan: NormalizedPlan; info: ActivePlan }[] = [];
  const groups = new Set<string>([...planSubs.keys(), ...n.defaults.keys()]);
  for (const group of groups) {
    const list = (planSubs.get(group) ?? []).sort(
      (a, b) => ts(b.sub.createdAt) - ts(a.sub.createdAt) || (a.sub.id < b.sub.id ? 1 : -1),
    );
    const [winner, ...rest] = list;
    for (const r of rest) {
      inactive.push({ subscriptionId: r.sub.id, plan: r.sub.plan, reason: "superseded" });
    }
    if (winner) {
      const info: ActivePlan = {
        plan: winner.plan.key,
        version: winner.plan.version,
        group,
        default: false,
        status: winner.sub.status,
        subscriptionId: winner.sub.id,
      };
      if (winner.sub.trialEndsAt) info.trialEndsAt = winner.sub.trialEndsAt;
      if (winner.sub.periodEnd) info.periodEnd = winner.sub.periodEnd;
      if (winner.sub.cancelAtPeriodEnd) info.cancelAtPeriodEnd = true;
      active.push({ plan: winner.plan, info });
    } else {
      const key = n.defaults.get(group);
      const plan = key ? n.plans.get(key) : undefined;
      if (plan) {
        active.push({
          plan,
          info: { plan: plan.key, version: plan.version, group, default: true },
        });
      }
    }
  }
  active.sort(
    (a, b) =>
      (a.plan.group === "base" ? 0 : 1) - (b.plan.group === "base" ? 0 : 1) ||
      a.plan.order - b.plan.order,
  );
  const activeKeys = new Set(active.map((a) => a.plan.key));

  const addons: EntitlementSet["addons"] = [];
  const appliedAddons: { sub: Subscription; key: string }[] = [];
  for (const sub of addonSubs) {
    const addon = n.addons.get(sub.plan)!;
    const applied = addon.requires.length === 0 || addon.requires.some((r) => activeKeys.has(r));
    addons.push({ addon: addon.key, quantity: sub.quantity, subscriptionId: sub.id, applied });
    if (applied) appliedAddons.push({ sub, key: addon.key });
  }

  // Billing-period anchor: the entitled base-group subscription.
  const baseSub = active.find((a) => a.plan.group === "base" && !a.info.default)?.info
    .subscriptionId;
  const anchorSub = customer.subscriptions.find((s) => s.id === baseSub);
  // Without an entitled base subscription, billing periods are UTC calendar months: a
  // never-written customer has no stable createdAt (it would be "now" on every call), and
  // switching anchors on the first write would silently reset usage mid-month.
  const anchor = anchorSub
    ? {
        ...(anchorSub.periodStart ? { periodStart: anchorSub.periodStart } : {}),
        ...(anchorSub.periodEnd ? { periodEnd: anchorSub.periodEnd } : {}),
        anchor: anchorSub.createdAt,
      }
    : {};

  const features: Record<string, ResolvedFeature> = {};
  for (const key of n.featureOrder) {
    const f = n.features.get(key)!;
    features[key] = resolveFeature(f, customer, active, appliedAddons, catalog, now, anchor, bound);
  }

  return {
    customer: customer.id,
    plans: active.map((a) => a.info),
    addons,
    features,
    inactive,
    validUntil: boundaries.length ? new Date(Math.min(...boundaries)).toISOString() : null,
    resolvedAt: new Date(now).toISOString(),
  };
}

function resolveFeature(
  f: NormalizedFeature,
  state: CustomerState,
  active: { plan: NormalizedPlan; info: ActivePlan }[],
  addons: { sub: Subscription; key: string }[],
  catalog: AnyCatalog,
  now: number,
  anchor: { periodStart?: string; periodEnd?: string; anchor?: string },
  bound: (iso: string | undefined | null) => void,
): ResolvedFeature {
  const n = catalog.normalized;
  const sources: EntitlementSource[] = [];
  const out: ResolvedFeature = { key: f.key, kind: f.kind, enabled: false, sources };

  if (f.kind === "boolean") {
    for (const { plan, info } of active) {
      const e = plan.features[f.key];
      if (e?.kind === "boolean" && e.enabled) {
        out.enabled = true;
        sources.push(planSource(plan, info));
      }
    }
    for (const { sub, key } of addons) {
      const e = n.addons.get(key)!.features[f.key];
      if (e?.kind === "boolean") {
        out.enabled = true;
        sources.push({ type: "addon", id: key, subscriptionId: sub.id });
      }
    }
  } else if (f.kind === "value") {
    out.enabled = true;
    let value = f.default as JsonValue;
    let from: EntitlementSource = { type: "default", id: f.key };
    for (const { plan, info } of active) {
      const e = plan.features[f.key];
      if (e?.kind === "value") {
        value = e.value;
        from = planSource(plan, info);
      }
    }
    for (const { sub, key } of addons) {
      const e = n.addons.get(key)!.features[f.key];
      if (e?.kind === "value") {
        value = e.value;
        from = { type: "addon", id: key, subscriptionId: sub.id };
      }
    }
    out.value = value;
    sources.push(from);
  } else {
    let included = false;
    let allowance: number | null = 0;
    let overage: "block" | "allow" = "block";
    let overageLimit: number | null = 0;
    let reset = f.reset;
    for (const { plan, info } of active) {
      const e = plan.features[f.key];
      if (!e || e.kind === "boolean" || e.kind === "value" || !e.included) continue;
      if (!included && e.reset) reset = e.reset;
      included = true;
      allowance = sumLimit(allowance, e.limit);
      if (e.overage === "allow") {
        overage = "allow";
        overageLimit = sumLimit(overageLimit, e.overageLimit);
      }
      sources.push({ ...planSource(plan, info), amount: e.limit });
    }
    for (const { sub, key } of addons) {
      const e = n.addons.get(key)!.features[f.key];
      if (!e || e.kind === "boolean" || e.kind === "value") continue;
      const amount = e.add === null ? null : e.add * Math.max(1, sub.quantity);
      included = true;
      allowance = sumLimit(allowance, amount);
      sources.push({ type: "addon", id: key, subscriptionId: sub.id, amount });
    }
    const buckets: GrantBucket[] = [];
    for (const g of state.grants) {
      if (g.feature !== f.key) continue;
      bound(g.startsAt);
      bound(g.expiresAt);
      if (!activeAt(g, now)) continue;
      included = true;
      if (g.recurring || f.kind === "capacity") allowance = sumLimit(allowance, g.amount);
      else {
        const b: GrantBucket = { id: g.id, amount: g.amount, priority: g.priority ?? 0 };
        if (g.expiresAt) b.expiresAt = g.expiresAt;
        buckets.push(b);
      }
      sources.push({ type: "grant", id: g.id, amount: g.amount });
    }
    buckets.sort(
      (a, b) =>
        a.priority - b.priority ||
        (ts(a.expiresAt) || Infinity) - (ts(b.expiresAt) || Infinity) ||
        (a.id < b.id ? -1 : 1),
    );
    out.enabled = included;
    out.allowance = included ? allowance : 0;
    out.overagePolicy = overage;
    out.overageLimit = overage === "allow" ? overageLimit : 0;
    out.grants = buckets;
    if (f.kind !== "capacity" && reset) {
      out.reset = reset;
      out.period = currentPeriod(reset, now, anchor);
      bound(out.period.end);
    }
  }

  // Overrides: active ones apply in creation order; each set field replaces.
  const overrides = state.overrides
    .filter((o) => o.feature === f.key)
    .sort((a, b) => ts(a.createdAt) - ts(b.createdAt));
  for (const o of overrides) {
    bound(o.startsAt);
    bound(o.expiresAt);
    if (!activeAt(o, now)) continue;
    out.override = o.id;
    sources.push({ type: "override", id: o.id });
    if (o.enabled !== undefined) {
      out.enabled = o.enabled;
      if (
        o.enabled &&
        f.kind !== "boolean" &&
        f.kind !== "value" &&
        o.limit === undefined &&
        out.allowance === 0
      ) {
        out.allowance = null; // "comp it": enabled with no limit given = unlimited
      }
    }
    if (o.limit !== undefined && f.kind !== "boolean" && f.kind !== "value") {
      out.allowance = o.limit;
      out.enabled = o.enabled ?? true;
    }
    if (o.overage !== undefined && f.kind !== "boolean" && f.kind !== "value") {
      out.overagePolicy = o.overage;
      if (o.overage === "allow" && out.overageLimit === 0) out.overageLimit = null;
    }
    if (o.value !== undefined && f.kind === "value") out.value = o.value;
  }

  if (f.kind !== "boolean" && f.kind !== "value") {
    const oneOff = (out.grants ?? []).reduce((s, g) => s + g.amount, 0);
    out.limit =
      out.allowance === null || out.allowance === undefined ? null : out.allowance + oneOff;
    if (!out.enabled) out.limit = 0;
  }
  return out;
}

function planSource(plan: NormalizedPlan, info: ActivePlan): EntitlementSource {
  const s: EntitlementSource = { type: "plan", id: plan.key, version: plan.version };
  if (info.subscriptionId) s.subscriptionId = info.subscriptionId;
  return s;
}

const monthly = (price: PriceDisplay[]): number => {
  const p = price[0];
  if (!p) return 0;
  switch (p.interval) {
    case "year":
      return p.amount / 12;
    case "week":
      return (p.amount * 52) / 12;
    case "day":
      return p.amount * 30;
    default:
      return p.amount;
  }
};

/**
 * Plans and add-ons (current versions, not hidden, not already active; add-ons
 * only when their `requires` is met by `activePlans`) that would allow `feature` — for numeric features, a total of `needed` units.
 * Cheapest first (by monthly-normalized display price), then catalog order.
 */
export function unlockingPlans(
  catalog: AnyCatalog,
  feature: string,
  needed: number,
  activePlans: readonly string[] = [],
): string[] {
  const n = catalog.normalized;
  const f = n.features.get(feature);
  if (!f) return [];
  const out: { key: string; price: number; order: number }[] = [];
  for (const key of n.planOrder) {
    const p = n.plans.get(key)!;
    if (p.hidden || activePlans.includes(key)) continue;
    const e = p.features[feature];
    let ok = false;
    if (e?.kind === "boolean") ok = e.enabled;
    else if (e && e.kind !== "value" && e.included) {
      ok =
        e.limit === null || e.limit >= needed || (e.overage === "allow" && e.overageLimit === null);
    }
    if (ok) out.push({ key, price: monthly(p.price), order: p.order });
  }
  for (const key of n.addonOrder) {
    const a = n.addons.get(key)!;
    if (a.hidden) continue;
    if (a.requires.length > 0 && !a.requires.some((r) => activePlans.includes(r))) continue;
    const e = a.features[feature];
    if (!e || e.kind === "value") continue;
    if (e.kind === "boolean" || e.add === null || e.add > 0) {
      out.push({ key, price: monthly(a.price), order: a.order });
    }
  }
  return out.sort((a, b) => a.price - b.price || a.order - b.order).map((x) => x.key);
}

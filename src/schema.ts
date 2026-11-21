/**
 * The data model: per-customer state (subscriptions, grants, overrides),
 * resolved entitlements, and the decisions `check` / `consume` return.
 * Types only (plus a few constants).
 *
 * @module schema
 */

import type {
  FeatureKind,
  JsonObject,
  JsonValue,
  OveragePolicy,
  ResetInterval,
} from "./catalog.ts";

export type { FeatureKind, JsonObject, JsonValue, OveragePolicy, ResetInterval };

/** Who made a control-plane change. */
export interface Actor {
  id: string;
  name?: string;
  email?: string;
  /** `"user"`, `"system"`, `"billing:stripe"`, `"portal"`, … */
  type?: string;
}

/** Provider-agnostic subscription status (ADR 0007). */
export type SubscriptionStatus =
  | "active"
  | "trialing"
  | "past_due"
  | "paused"
  | "canceled"
  | "incomplete";

/** Statuses that grant access unless configured otherwise. */
export const DEFAULT_ENTITLED_STATUSES: readonly SubscriptionStatus[] = [
  "active",
  "trialing",
  "past_due",
];

/** A subscription to a plan or add-on, from any provider (or `"manual"`). */
export interface Subscription {
  id: string;
  /** Plan key, or add-on key when `kind` is `"addon"`. */
  plan: string;
  /** Pinned plan version (grandfathering — ADR 0012). Add-ons: always 1. */
  version: number;
  kind: "plan" | "addon";
  status: SubscriptionStatus;
  quantity: number;
  /** ISO-8601. Current billing period. */
  periodStart?: string;
  periodEnd?: string;
  trialEndsAt?: string;
  cancelAtPeriodEnd?: boolean;
  canceledAt?: string;
  /** `"manual"`, `"stripe"`, `"polar"`, … */
  provider: string;
  /** The provider's subscription (or item) id. */
  providerRef?: string;
  /** Provider-side last-update time, for out-of-order webhook safety. */
  providerUpdatedAt?: string;
  createdAt: string;
  updatedAt: string;
  metadata?: JsonObject;
}

/** A balance added to a metered / credits / capacity feature (ADR 0005). */
export interface Grant {
  id: string;
  feature: string;
  amount: number;
  /**
   * Recurring grants add `amount` to every period's allowance. One-off grants
   * (no `recurring`) are their own bucket, consumed after the allowance.
   */
  recurring?: boolean;
  /** Lower is consumed first (one-off grants). Default `0`. */
  priority: number;
  startsAt?: string;
  expiresAt?: string;
  reason?: string;
  actor?: Actor;
  createdAt: string;
  metadata?: JsonObject;
}

/** An operator exception for one feature (comp, raise a limit, disable). ADR 0009/0012. */
export interface Override {
  id: string;
  feature: string;
  /** Force on/off (any kind). */
  enabled?: boolean;
  /** Replace the numeric limit (`null` = unlimited). */
  limit?: number | null;
  /** Replace the overage policy. */
  overage?: OveragePolicy;
  /** Replace a value feature's value. */
  value?: JsonValue;
  startsAt?: string;
  expiresAt?: string;
  reason?: string;
  actor?: Actor;
  createdAt: string;
}

/** Everything stored for one customer (state storage, `customers/{id}`). */
export interface CustomerState {
  /** Your user / organization / workspace id. */
  id: string;
  name?: string;
  email?: string;
  subscriptions: Subscription[];
  grants: Grant[];
  overrides: Override[];
  /** provider → provider customer id. */
  providers: Record<string, string>;
  /** plan key → ISO time a trial was started (one trial per plan). */
  trials: Record<string, string>;
  metadata: JsonObject;
  createdAt: string;
  updatedAt: string;
  /** Incremented on every write (optimistic concurrency). */
  revision: number;
}

/** Where part of a feature's entitlement came from. */
export interface EntitlementSource {
  type: "plan" | "addon" | "grant" | "override" | "default";
  /** Plan / add-on key, grant id or override id. */
  id: string;
  version?: number;
  subscriptionId?: string;
  /** Contribution to the limit (numeric features). */
  amount?: number | null;
}

/** A one-off grant bucket, in consumption order. */
export interface GrantBucket {
  id: string;
  amount: number;
  priority: number;
  expiresAt?: string;
}

/** The current usage window of a metered / credits feature. */
export interface UsagePeriod {
  /** Counter key suffix, e.g. `"2026-11"`, `"bp-2026-11-14T08:00:00.000Z"`, `"all"`. */
  key: string;
  start: string | null;
  end: string | null;
}

/** One feature, resolved for one customer at one instant (no usage yet). */
export interface ResolvedFeature {
  key: string;
  kind: FeatureKind;
  /** Boolean: on/off. Numeric: included in a plan. Value: always true. */
  enabled: boolean;
  /** Numeric features: period allowance incl. add-ons + recurring grants; `null` = unlimited. */
  allowance?: number | null;
  /** `allowance` + one-off grants; `null` = unlimited. */
  limit?: number | null;
  overagePolicy?: OveragePolicy;
  overageLimit?: number | null;
  reset?: ResetInterval;
  period?: UsagePeriod;
  grants?: GrantBucket[];
  value?: JsonValue;
  sources: EntitlementSource[];
  /** Set when an override decided the result. */
  override?: string;
}

/** A plan currently applying to the customer. */
export interface ActivePlan {
  plan: string;
  version: number;
  group: string;
  /** True when it applies only because no subscription is entitled in its group. */
  default: boolean;
  status?: SubscriptionStatus;
  subscriptionId?: string;
  trialEndsAt?: string;
  periodEnd?: string;
  cancelAtPeriodEnd?: boolean;
}

/** A customer's resolved entitlements (ADR 0003: cached per customer). */
export interface EntitlementSet {
  customer: string;
  plans: ActivePlan[];
  addons: Array<{ addon: string; quantity: number; subscriptionId: string; applied: boolean }>;
  features: Record<string, ResolvedFeature>;
  /** Subscriptions that are not entitled right now (inactive, expired trial, conflicts). */
  inactive: Array<{ subscriptionId: string; plan: string; reason: string }>;
  /** ISO time at which this resolution may change (trial end, expiry, period end). */
  validUntil: string | null;
  resolvedAt: string;
}

/** Why a decision came out the way it did (ADR 0009). */
export type DecisionReason =
  | "included"
  | "within_limit"
  | "overage_allowed"
  | "limit_reached"
  | "not_in_plan"
  | "disabled_by_override"
  | "granted_by_override"
  | "subscription_inactive"
  | "unknown_feature"
  | "fallback";

/** `payment_required` = an upgrade would allow it (402). `forbidden` = no plan would (403). */
export type Denial = "payment_required" | "forbidden";

/** The answer to `check` / `consume` / `reserve`. */
export interface CheckResult {
  allowed: boolean;
  feature: string;
  kind: FeatureKind | "unknown";
  reason: DecisionReason;
  denial?: Denial;
  /** Numeric features: `null` = unlimited. */
  limit?: number | null;
  used?: number;
  /** `null` = unlimited. */
  remaining?: number | null;
  /** Usage beyond the limit this period (overage allowed). */
  overage?: number;
  resetsAt?: string | null;
  value?: JsonValue;
  /** Plans / add-ons (current versions) that would allow the request, cheapest first. */
  unlockedBy: string[];
  /** Served from a last-known-good snapshot or without counters (ADR 0003). */
  stale?: boolean;
  /** Decided by a write-behind counter (ADR 0006). */
  buffered?: boolean;
  /** `consume` with an idempotency key that was already applied. */
  duplicate?: boolean;
  /** The amount asked for. */
  requested?: number;
}

/** A reservation from `reserve` (ADR 0005). */
export interface Reservation {
  id: string;
  customer: string;
  feature: string;
  amount: number;
  /** Counter takes, in order: counter key, amount (in that feature's units) and feature. */
  takes: Array<{ key: string; amount: number; feature: string }>;
  /** Units of each consumed feature per unit of `feature` (1 for itself; credit rates). */
  rates: Record<string, number>;
  metadata?: JsonObject;
  createdAt: string;
  expiresAt: string;
}

/** A per-feature usage snapshot (UI, portal, `entitlements()`). */
export interface FeatureUsage extends ResolvedFeature {
  used?: number;
  remaining?: number | null;
  overage?: number;
  resetsAt?: string | null;
  /** Remaining balance per one-off grant. */
  grantBalances?: Array<{ id: string; amount: number; used: number; expiresAt?: string }>;
}

/** `entitlements(customer)`: resolved set + usage for every feature. */
export interface CustomerEntitlements extends Omit<EntitlementSet, "features"> {
  features: Record<string, FeatureUsage>;
  stale?: boolean;
}

/** A control-plane activity entry (per customer; also fed to hooks / audit). */
export interface ActivityEntry {
  id: string;
  customer: string;
  type: string;
  at: string;
  actor?: Actor;
  summary: string;
  data?: JsonObject;
}

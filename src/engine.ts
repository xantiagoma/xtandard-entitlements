/**
 * The engine: `createEntitlements({ catalog, storage, counters })`.
 *
 * - **Runtime plane** — `check`, `consume`, `reserve` / `settle`, `release`:
 *   memory-first per-customer snapshots (ADR 0003) and atomic counters where a
 *   refusal never counts (ADR 0005). Decisions carry reasons, 402-vs-403 denial
 *   and `unlockedBy` (ADR 0009). Never throws for a denial.
 * - **Control plane** — subscriptions, trials, grants, overrides, usage resets,
 *   provider links: revisioned writes to state storage, wrapped in `before` /
 *   `after` hooks and recorded as activity.
 *
 * @module
 */

import {
  getPlanVersion,
  pricingTable,
  type AnyCatalog,
  type FeatureKey,
  type FeatureValue,
  type JsonObject,
  type JsonValue,
  type NormalizedFeature,
  type PricingTable,
} from "./catalog.ts";
import type { CounterStore } from "./counters/contract.ts";
import { createBufferedCounterStore, isBufferedCounterStore } from "./counters/buffered.ts";
import { createMemoryCounterStore } from "./counters/memory.ts";
import { durationToMs, type Duration } from "./duration.ts";
import {
  defaultEventErrorReporter,
  emit,
  type EventErrorReporter,
  type ThresholdListener,
  type UsageEvent,
  type UsageListener,
} from "./events.ts";
import {
  defaultHookErrorReporter,
  normalizeHooks,
  runAfter,
  runBefore,
  type AfterEvent,
  type BeforeEvent,
  type EntitlementsHooksInput,
  type HookErrorReporter,
} from "./hooks/contract.ts";
import { newId } from "./id.ts";
import {
  activityKey,
  activityLogKey,
  customerKey,
  customersPrefix,
  dailyKey,
  idempotencyKey,
  lastSegment,
  linkKey,
  reservationKey,
  reservationsPrefix,
  thresholdKey,
  usageKey,
  capacityKey,
} from "./keys.ts";
import {
  buildLegs,
  legCovers,
  legKeys,
  legState,
  refundTakes,
  takeLegs,
  type Leg,
  type LegState,
  type Take,
} from "./ledger.ts";
import { addMonthsClamped } from "./periods.ts";
import { emptyCustomerState, resolveEntitlements, unlockingPlans } from "./resolve.ts";
import {
  DEFAULT_ENTITLED_STATUSES,
  type ActivityEntry,
  type Actor,
  type CheckResult,
  type CustomerEntitlements,
  type CustomerState,
  type DecisionReason,
  type EntitlementSet,
  type FeatureUsage,
  type Grant,
  type Override,
  type Reservation,
  type Subscription,
  type SubscriptionStatus,
} from "./schema.ts";
import { createMemoryStorage } from "./storage/memory.ts";
import { isCompareAndSwap, isWatchable, type EntitlementsStorage } from "./storage/contract.ts";

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** Thrown by `require` / `consumeOrThrow`; carries the decision. Adapters map it to 402 / 403. */
export class EntitlementDeniedError extends Error {
  readonly result: CheckResult;
  /** `402` (an upgrade would allow it) or `403`. */
  readonly status: 402 | 403;
  constructor(result: CheckResult) {
    super(`Not entitled to "${result.feature}" (${result.reason})`);
    this.name = "EntitlementDeniedError";
    this.result = result;
    this.status = result.denial === "payment_required" ? 402 : 403;
  }
}

/** Invalid input to an engine operation (maps to HTTP 400). */
export class EntitlementsValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EntitlementsValidationError";
  }
}

/** A referenced customer / subscription / grant / override / reservation does not exist (404). */
export class NotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotFoundError";
  }
}

/** Thrown by mutating operations when the engine is readonly. */
export class ReadonlyError extends Error {
  constructor(operation: string) {
    super(`Cannot ${operation}: @xtandard/entitlements is in readonly mode.`);
    this.name = "ReadonlyError";
  }
}

// ---------------------------------------------------------------------------
// Options & public types
// ---------------------------------------------------------------------------

/** Counter routing: one store, or a strict default plus a buffered store for `metering: "buffered"` features. */
export type CountersOption = CounterStore | { default: CounterStore; buffered?: CounterStore };

/** Options for {@link createEntitlements}. */
export interface EntitlementsOptions<C extends AnyCatalog = AnyCatalog> {
  catalog: C;
  /** State storage (customers, reservations, links, activity). Default: in-memory. */
  storage?: EntitlementsStorage;
  /** Counter store(s). Default: in-memory. */
  counters?: CountersOption;
  /** Customer snapshot cache (ADR 0003). `false` disables it (every call loads). */
  cache?: { ttl?: Duration; max?: number } | false;
  /** When a customer cannot be loaded and nothing is cached. Default `"default-plan"`. */
  fallback?: "default-plan" | "deny" | "allow";
  /** When the counter store fails. Default `"deny"` (fail closed). */
  counterFallback?: "deny" | "allow";
  /** Subscription statuses that grant access. Default `active`, `trialing`, `past_due`. */
  entitledStatuses?: readonly SubscriptionStatus[];
  /** Throw on unknown feature keys instead of denying with `unknown_feature`. */
  strict?: boolean;
  /** Control-plane hooks (`before` may deny, `after` observes). */
  hooks?: EntitlementsHooksInput;
  onHookError?: HookErrorReporter;
  /** Fire-and-forget tap for every usage change. */
  onUsage?: UsageListener;
  /** Fire-and-forget tap when usage crosses a threshold (once per period). */
  onThreshold?: ThresholdListener;
  onEventError?: EventErrorReporter;
  /** Default reservation TTL. Default `"15m"`. */
  reservationTtl?: Duration;
  /** How long idempotency keys are remembered. Default `"24h"`. */
  idempotencyTtl?: Duration;
  /** Activity kept per customer / globally. `false` disables. Default `{ perCustomer: 200, global: 500 }`. */
  activity?: { perCustomer?: number; global?: number } | false;
  /** Record a daily usage series (admin graphs) through a buffered counter. Default `true`. */
  usageSeries?: boolean;
  /** Block every control-plane mutation (runtime consumption still works). */
  readonly?: boolean;
  /** Injectable clock (unix ms). Default `Date.now`. */
  now?: () => number;
  /** Non-fatal problems (failed refreshes, activity writes). Default `console.warn`. */
  logger?: { warn(message: string, error?: unknown): void };
}

/** Per-call actor attribution for control-plane operations. */
export interface ActorOptions {
  actor?: Actor | null;
}

/** Options for {@link Entitlements.check}. */
export interface CheckOptions {
  /** Units the caller intends to use (numeric features). Default `1`. */
  amount?: number;
}

/** Options for {@link Entitlements.consume}. */
export interface ConsumeOptions {
  /** A key making the call idempotent for `idempotencyTtl`. */
  idempotencyKey?: string;
  /** Attached to the `onUsage` event. */
  metadata?: Record<string, unknown>;
}

/** Options for {@link Entitlements.reserve}. */
export interface ReserveOptions {
  ttl?: Duration;
  metadata?: JsonObject;
}

/** Result of {@link Entitlements.reserve}. */
export interface ReserveResult extends CheckResult {
  reservation?: Reservation;
}

/** Options for {@link Entitlements.settle}. */
export interface SettleOptions {
  /** When `actual` exceeds the reservation: `"record"` the extra even past limits (default) or `"cap"` it. */
  overage?: "record" | "cap";
}

/** Input to {@link Entitlements.upsertSubscription}. */
export interface SubscriptionInput {
  /** Existing subscription id to update. */
  id?: string;
  plan: string;
  /** Pinned version. Default: kept for the same plan, else the current version. */
  version?: number;
  /** Auto-detected from the catalog when omitted. */
  kind?: "plan" | "addon";
  status?: SubscriptionStatus;
  quantity?: number;
  periodStart?: string;
  periodEnd?: string;
  trialEndsAt?: string;
  cancelAtPeriodEnd?: boolean;
  canceledAt?: string;
  /** Default `"manual"`. */
  provider?: string;
  providerRef?: string;
  providerUpdatedAt?: string;
  metadata?: JsonObject;
}

/** Result of {@link Entitlements.upsertSubscription}. */
export interface UpsertSubscriptionResult {
  subscription: Subscription;
  /** `"created"`, `"updated"`, or `"stale"` (an older provider update — ignored). */
  outcome: "created" | "updated" | "stale";
}

/** Input to {@link Entitlements.subscribe} (manual plan changes). */
export interface SubscribeInput {
  plan: string;
  version?: number;
  quantity?: number;
  status?: SubscriptionStatus;
  trialEndsAt?: string;
  metadata?: JsonObject;
  /** Cancel the customer's other manual subscriptions in the same group. Default `true`. */
  replace?: boolean;
}

/** Input to {@link Entitlements.grant}. */
export interface GrantInput {
  feature: string;
  amount: number;
  recurring?: boolean;
  priority?: number;
  startsAt?: string;
  expiresAt?: string;
  reason?: string;
  metadata?: JsonObject;
}

/** Input to {@link Entitlements.override}. */
export interface OverrideInput {
  feature: string;
  enabled?: boolean;
  limit?: number | null;
  overage?: "block" | "allow";
  value?: JsonValue;
  startsAt?: string;
  expiresAt?: string;
  reason?: string;
}

/** One row of {@link Entitlements.listCustomers}. */
export interface CustomerSummary {
  id: string;
  name?: string;
  email?: string;
  plans: string[];
  statuses: SubscriptionStatus[];
  updatedAt: string;
}

/** A typed decision: `value` is typed for value features. */
export type TypedCheckResult<C, K extends string> = Omit<CheckResult, "value"> & {
  value?: FeatureValue<C, K>;
};

/** A client bound to one customer. */
export interface CustomerClient<C extends AnyCatalog> {
  readonly id: string;
  check<K extends FeatureKey<C>>(
    feature: K,
    options?: CheckOptions,
  ): Promise<TypedCheckResult<C, K>>;
  consume(feature: FeatureKey<C>, amount?: number, options?: ConsumeOptions): Promise<CheckResult>;
  release(feature: FeatureKey<C>, amount?: number): Promise<CheckResult>;
  reserve(feature: FeatureKey<C>, amount: number, options?: ReserveOptions): Promise<ReserveResult>;
  require(feature: FeatureKey<C>, options?: CheckOptions): Promise<CheckResult>;
  entitlements(): Promise<CustomerEntitlements>;
}

/** The engine. */
export interface Entitlements<C extends AnyCatalog = AnyCatalog> {
  readonly catalog: C;
  readonly storage: EntitlementsStorage;
  readonly counters: CounterStore;
  readonly readonly: boolean;

  // runtime plane
  check<K extends FeatureKey<C>>(
    customer: string,
    feature: K,
    options?: CheckOptions,
  ): Promise<TypedCheckResult<C, K>>;
  /** Check, and throw {@link EntitlementDeniedError} when denied. */
  require(customer: string, feature: FeatureKey<C>, options?: CheckOptions): Promise<CheckResult>;
  consume(
    customer: string,
    feature: FeatureKey<C>,
    amount?: number,
    options?: ConsumeOptions,
  ): Promise<CheckResult>;
  /** Consume, and throw {@link EntitlementDeniedError} when refused. */
  consumeOrThrow(
    customer: string,
    feature: FeatureKey<C>,
    amount?: number,
    options?: ConsumeOptions,
  ): Promise<CheckResult>;
  /** Give units back (capacity: a seat freed; metered: a refund). Clamped at 0. */
  release(customer: string, feature: FeatureKey<C>, amount?: number): Promise<CheckResult>;
  reserve(
    customer: string,
    feature: FeatureKey<C>,
    amount: number,
    options?: ReserveOptions,
  ): Promise<ReserveResult>;
  settle(reservationId: string, actual: number, options?: SettleOptions): Promise<CheckResult>;
  /** Release a reservation entirely (= `settle(id, 0)`). */
  cancelReservation(reservationId: string): Promise<CheckResult>;
  /** Release expired reservations. */
  sweep(): Promise<{ released: number }>;
  entitlements(customer: string): Promise<CustomerEntitlements>;
  customer(id: string): CustomerClient<C>;

  // control plane
  getCustomer(customer: string): Promise<CustomerState | null>;
  listCustomers(options?: {
    limit?: number;
    after?: string;
    search?: string;
  }): Promise<{ customers: CustomerSummary[]; next?: string }>;
  updateCustomer(
    customer: string,
    patch: { name?: string; email?: string; metadata?: JsonObject },
    options?: ActorOptions,
  ): Promise<CustomerState>;
  deleteCustomer(customer: string, options?: ActorOptions): Promise<void>;
  upsertSubscription(
    customer: string,
    input: SubscriptionInput,
    options?: ActorOptions,
  ): Promise<UpsertSubscriptionResult>;
  subscribe(customer: string, input: SubscribeInput, options?: ActorOptions): Promise<Subscription>;
  cancelSubscription(
    customer: string,
    subscriptionId: string,
    options?: ActorOptions & { atPeriodEnd?: boolean },
  ): Promise<Subscription>;
  removeSubscription(
    customer: string,
    subscriptionId: string,
    options?: ActorOptions,
  ): Promise<void>;
  startTrial(
    customer: string,
    plan: string,
    options?: ActorOptions & { days?: number; force?: boolean },
  ): Promise<Subscription>;
  migratePlan(
    customer: string,
    plan: string,
    toVersion?: number,
    options?: ActorOptions,
  ): Promise<{ migrated: number }>;
  grant(customer: string, input: GrantInput, options?: ActorOptions): Promise<Grant>;
  revokeGrant(customer: string, grantId: string, options?: ActorOptions): Promise<void>;
  override(customer: string, input: OverrideInput, options?: ActorOptions): Promise<Override>;
  removeOverride(customer: string, overrideId: string, options?: ActorOptions): Promise<void>;
  setUsage(
    customer: string,
    feature: FeatureKey<C>,
    value: number,
    options?: ActorOptions,
  ): Promise<void>;
  resetUsage(customer: string, feature: FeatureKey<C>, options?: ActorOptions): Promise<void>;
  /** Map a provider customer id to our customer (and record it on the customer). */
  link(customer: string, provider: string, providerCustomer: string): Promise<void>;
  /** Our customer id for a provider customer id, if linked. */
  resolveLink(provider: string, providerCustomer: string): Promise<string | null>;
  activity(customer?: string, options?: { limit?: number }): Promise<ActivityEntry[]>;
  /** Daily usage (UTC dates, inclusive) for graphs. */
  usageSeries(
    customer: string,
    feature: FeatureKey<C>,
    options?: { from?: string; to?: string; days?: number },
  ): Promise<Array<{ date: string; value: number }>>;
  pricing(options?: { includeHidden?: boolean }): PricingTable;
  /** Drop cached snapshots (one customer, or all). */
  invalidate(customer?: string): void;
  /** Flush buffered counters, stop watchers and timers. */
  close(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

interface CacheEntry {
  state: CustomerState | null;
  loadedAt: number;
  stale: boolean;
  resolved?: EntitlementSet;
  resolvedUntil?: number;
}

interface Snapshot {
  state: CustomerState | null;
  set: EntitlementSet;
  stale: boolean;
  /** Set when the customer could not be loaded and `fallback` is not "default-plan". */
  forced?: "deny" | "allow";
}

const DAY = 86_400_000;

/**
 * Create the engine.
 *
 * @example
 * ```ts
 * import { createEntitlements } from "@xtandard/entitlements";
 * import { catalog } from "./catalog";
 *
 * const ent = createEntitlements({ catalog });
 * const decision = await ent.consume("org_42", "api_calls");
 * if (!decision.allowed) return new Response(decision.reason, { status: 402 });
 * ```
 */
export function createEntitlements<const C extends AnyCatalog>(
  options: EntitlementsOptions<C>,
): Entitlements<C> {
  const { catalog } = options;
  const n = catalog.normalized;
  const storage = options.storage ?? createMemoryStorage();
  const now = options.now ?? Date.now;
  const nowIso = () => new Date(now()).toISOString();
  const strictCounters =
    options.counters === undefined
      ? createMemoryCounterStore({ now })
      : "add" in options.counters
        ? options.counters
        : options.counters.default;
  const bufferedCounters =
    options.counters && !("add" in options.counters) ? options.counters.buffered : undefined;
  const countersFor = (f: NormalizedFeature): CounterStore =>
    f.metering === "buffered" && bufferedCounters ? bufferedCounters : strictCounters;
  const seriesEnabled = options.usageSeries ?? true;
  const series = seriesEnabled
    ? createBufferedCounterStore(strictCounters, { flushInterval: "5s", now, closeInner: false })
    : undefined;
  const cacheEnabled = options.cache !== false;
  const cacheTtl = durationToMs((options.cache ? options.cache.ttl : undefined) ?? "30s");
  const cacheMax = (options.cache ? options.cache.max : undefined) ?? 10_000;
  const fallback = options.fallback ?? "default-plan";
  const counterFallback = options.counterFallback ?? "deny";
  const entitled = options.entitledStatuses ?? DEFAULT_ENTITLED_STATUSES;
  const hooks = normalizeHooks(options.hooks);
  const onHookError = options.onHookError ?? defaultHookErrorReporter;
  const onEventError = options.onEventError ?? defaultEventErrorReporter;
  const reservationTtl = durationToMs(options.reservationTtl ?? "15m");
  const idempotencyTtl = durationToMs(options.idempotencyTtl ?? "24h");
  const activityCfg =
    options.activity === false ? null : { perCustomer: 200, global: 500, ...options.activity };
  const readonly = options.readonly ?? false;
  const logger = options.logger ?? {
    warn: (message: string, error?: unknown) =>
      console.warn(`[@xtandard/entitlements] ${message}`, ...(error === undefined ? [] : [error])),
  };

  // --- snapshot cache --------------------------------------------------------

  const cache = new Map<string, CacheEntry>();
  const inflight = new Map<string, Promise<CacheEntry>>();
  let unwatch: (() => void) | null = null;
  let watching: Promise<void> | null = null;

  const remember = (customer: string, entry: CacheEntry) => {
    if (!cacheEnabled) return;
    cache.delete(customer);
    cache.set(customer, entry);
    while (cache.size > cacheMax) cache.delete(cache.keys().next().value as string);
  };

  const ensureWatch = () => {
    if (watching || !cacheEnabled || !isWatchable(storage)) return;
    watching = storage
      .watch(customersPrefix(), (event) => {
        cache.delete(lastSegment(event.key));
      })
      .then((off) => {
        unwatch = off;
      })
      .catch((error) => logger.warn("storage watch failed; relying on cache TTL", error));
  };

  const load = (customer: string): Promise<CacheEntry> => {
    const pending = inflight.get(customer);
    if (pending) return pending;
    const p = storage
      .getItem<CustomerState>(customerKey(customer))
      .then((state) => {
        const entry: CacheEntry = { state, loadedAt: now(), stale: false };
        remember(customer, entry);
        return entry;
      })
      .finally(() => inflight.delete(customer));
    inflight.set(customer, p);
    return p;
  };

  async function snapshot(customer: string): Promise<Snapshot> {
    ensureWatch();
    let entry = cacheEnabled ? cache.get(customer) : undefined;
    if (!entry) {
      try {
        entry = await load(customer);
      } catch (error) {
        logger.warn(`could not load customer "${customer}"`, error);
        const set = resolveEntitlements(catalog, emptyCustomerState(customer, now()), now(), {
          entitledStatuses: entitled,
        });
        return fallback === "default-plan"
          ? { state: null, set, stale: true }
          : { state: null, set, stale: true, forced: fallback };
      }
    } else if (now() - entry.loadedAt > cacheTtl) {
      const stale = entry;
      load(customer).catch((error) => {
        stale.stale = true;
        stale.loadedAt = now(); // back off: retry after another TTL
        logger.warn(`refresh of customer "${customer}" failed; serving last-known-good`, error);
      });
    }
    const t = now();
    if (
      !entry.resolved ||
      entry.resolvedUntil === undefined ||
      t >= entry.resolvedUntil ||
      !cacheEnabled
    ) {
      const state = entry.state ?? emptyCustomerState(customer, t);
      entry.resolved = resolveEntitlements(catalog, state, t, { entitledStatuses: entitled });
      entry.resolved.customer = customer;
      const vu = entry.resolved.validUntil ? Date.parse(entry.resolved.validUntil) : Infinity;
      // Re-resolve at least every minute so time-based state can't drift.
      entry.resolvedUntil = Math.min(vu, t + 60_000);
    }
    return { state: entry.state, set: entry.resolved, stale: entry.stale };
  }

  // --- mutations ---------------------------------------------------------------

  const locks = new Map<string, Promise<unknown>>();
  async function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = locks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const mine = new Promise<void>((r) => (release = r));
    const chained = prev.then(() => mine);
    locks.set(key, chained);
    await prev.catch(() => {});
    try {
      return await fn();
    } finally {
      release();
      if (locks.get(key) === chained) locks.delete(key);
    }
  }

  async function writeState(key: string, expected: unknown, next: unknown): Promise<boolean> {
    if (isCompareAndSwap(storage)) return storage.compareAndSwap({ key, expected, next });
    await storage.setItem(key, next);
    return true;
  }

  /** Read-modify-write a customer document (CAS when available, per-customer lock always). */
  async function mutate<T>(
    customer: string,
    operation: string,
    apply: (draft: CustomerState, current: CustomerState | null) => Promise<T> | T,
  ): Promise<{ state: CustomerState; result: T }> {
    if (readonly) throw new ReadonlyError(operation);
    if (!customer || typeof customer !== "string") {
      throw new EntitlementsValidationError("customer id must be a non-empty string");
    }
    return withLock(customer, async () => {
      for (let attempt = 0; attempt < 20; attempt++) {
        const current = await storage.getItem<CustomerState>(customerKey(customer));
        const draft: CustomerState = structuredClone(
          current ?? emptyCustomerState(customer, now()),
        );
        const result = await apply(draft, current);
        draft.revision = (current?.revision ?? 0) + 1;
        draft.updatedAt = nowIso();
        if (await writeState(customerKey(customer), current, draft)) {
          remember(customer, { state: draft, loadedAt: now(), stale: false });
          return { state: draft, result };
        }
      }
      throw new Error(`customer "${customer}" is too contended (CAS retries exhausted)`);
    });
  }

  async function appendList<T>(key: string, item: T, keep: number): Promise<void> {
    for (let attempt = 0; attempt < 10; attempt++) {
      const current = await storage.getItem<T[]>(key);
      const next = [item, ...(current ?? [])].slice(0, keep);
      if (await writeState(key, current, next)) return;
    }
  }

  async function record(
    customer: string,
    type: string,
    summary: string,
    actor: Actor | null | undefined,
    data?: JsonObject,
  ): Promise<void> {
    if (!activityCfg) return;
    const entry: ActivityEntry = { id: newId("act", now()), customer, type, at: nowIso(), summary };
    if (actor) entry.actor = actor;
    if (data) entry.data = data;
    try {
      await Promise.all([
        appendList(activityKey(customer), entry, activityCfg.perCustomer),
        appendList(activityLogKey(), entry, activityCfg.global),
      ]);
    } catch (error) {
      logger.warn("could not record activity", error);
    }
  }

  const after = (event: AfterEvent) => runAfter(hooks, event, onHookError);
  const before = (event: BeforeEvent) => runBefore(hooks, event);

  // --- decisions ---------------------------------------------------------------

  const featureOf = (key: string): NormalizedFeature | undefined => n.features.get(key);

  function unknownFeature(feature: string): CheckResult {
    if (options.strict) throw new EntitlementsValidationError(`Unknown feature "${feature}"`);
    return {
      allowed: false,
      feature,
      kind: "unknown",
      reason: "unknown_feature",
      denial: "forbidden",
      unlockedBy: [],
    };
  }

  /** Inactive subscriptions whose plan would include the feature. */
  function inactiveUnlocks(
    state: CustomerState | null,
    set: EntitlementSet,
    feature: string,
  ): boolean {
    if (!state) return false;
    return set.inactive.some((i) => {
      const sub = state.subscriptions.find((s) => s.id === i.subscriptionId);
      if (!sub || i.reason === "superseded") return false;
      if (sub.kind === "addon") return n.addons.get(sub.plan)?.features[feature] !== undefined;
      const e = getPlanVersion(catalog, sub.plan, sub.version)?.features[feature];
      return !!e && (e.kind === "boolean" ? e.enabled : e.kind === "value" ? false : e.included);
    });
  }

  function denied(
    base: Omit<CheckResult, "allowed" | "reason" | "unlockedBy">,
    snap: Snapshot,
    needed: number,
    /** The credit pool that ran out, when it was not the feature itself. */
    pool?: string,
  ): CheckResult {
    const target = pool ?? base.feature;
    const rf = snap.set.features[target];
    const active = snap.set.plans.map((p) => p.plan);
    if (rf?.override !== undefined && !rf.enabled) {
      return {
        ...base,
        allowed: false,
        reason: "disabled_by_override",
        denial: "forbidden",
        unlockedBy: [],
      };
    }
    const unlockedBy = unlockingPlans(catalog, target, needed, active);
    let reason: DecisionReason = rf?.enabled ? "limit_reached" : "not_in_plan";
    if (!rf?.enabled && inactiveUnlocks(snap.state, snap.set, target))
      reason = "subscription_inactive";
    return {
      ...base,
      allowed: false,
      reason,
      denial:
        unlockedBy.length > 0 || reason === "subscription_inactive"
          ? "payment_required"
          : "forbidden",
      unlockedBy,
    };
  }

  function forcedResult(feature: NormalizedFeature, snap: Snapshot): CheckResult {
    const allowed = snap.forced === "allow";
    return {
      allowed,
      feature: feature.key,
      kind: feature.kind,
      reason: "fallback",
      ...(allowed ? {} : { denial: "forbidden" as const }),
      unlockedBy: [],
      stale: true,
    };
  }

  /** Usage fields for the main (first) leg, expressed in requested units. */
  function usageFields(legs: Leg[], states: LegState[]): Partial<CheckResult> {
    const main = states[0]!;
    const out: Partial<CheckResult> = { used: main.used };
    let remaining: number | null = null;
    let limit: number | null = null;
    legs.forEach((leg, i) => {
      const s = states[i]!;
      if (s.remaining === null) return;
      const units = s.remaining / leg.rate;
      remaining = remaining === null ? units : Math.min(remaining, units);
      const l = (leg.resolved.limit ?? 0) / leg.rate;
      limit = limit === null ? l : Math.min(limit, l);
    });
    out.remaining = remaining;
    out.limit = legs[0]!.recordOnly ? limit : (legs[0]!.resolved.limit ?? null);
    if (main.overage > 0) out.overage = main.overage;
    const period = legs.find((l) => l.resolved.period)?.resolved.period;
    out.resetsAt = period?.end ?? null;
    return out;
  }

  async function readValues(legs: Leg[]): Promise<Map<string, number>> {
    const groups = new Map<CounterStore, string[]>();
    for (const leg of legs) {
      const store = countersFor(leg.feature);
      const keys = groups.get(store) ?? [];
      for (const k of legKeys([leg])) if (!keys.includes(k)) keys.push(k);
      groups.set(store, keys);
    }
    const values = new Map<string, number>();
    await Promise.all(
      [...groups].map(async ([store, keys]) => {
        const vs = await store.get(keys);
        keys.forEach((k, i) => values.set(k, vs[i] ?? 0));
      }),
    );
    return values;
  }

  const isBuffered = (legs: Leg[]) =>
    legs.some((l) => isBufferedCounterStore(countersFor(l.feature)));

  function nonNumeric(feature: NormalizedFeature, snap: Snapshot): CheckResult {
    const rf = snap.set.features[feature.key]!;
    const base = {
      feature: feature.key,
      kind: feature.kind,
      ...(snap.stale ? { stale: true } : {}),
    };
    if (feature.kind === "value") {
      return {
        ...base,
        allowed: true,
        reason: rf.override !== undefined ? "granted_by_override" : "included",
        value: rf.value as JsonValue,
        unlockedBy: [],
      };
    }
    if (rf.enabled) {
      return {
        ...base,
        allowed: true,
        reason: rf.override !== undefined ? "granted_by_override" : "included",
        unlockedBy: [],
      };
    }
    return denied(base, snap, 1);
  }

  function assertUnits(amount: number, what = "amount"): void {
    if (typeof amount !== "number" || !Number.isFinite(amount) || amount < 0) {
      throw new EntitlementsValidationError(`${what} must be a finite number >= 0`);
    }
  }

  async function check(
    customer: string,
    feature: string,
    opts: CheckOptions = {},
  ): Promise<CheckResult> {
    const amount = opts.amount ?? 1;
    assertUnits(amount);
    const f = featureOf(feature);
    if (!f) return unknownFeature(feature);
    const snap = await snapshot(customer);
    if (snap.forced) return forcedResult(f, snap);
    if (f.kind === "boolean" || f.kind === "value") return nonNumeric(f, snap);
    const rf = snap.set.features[f.key]!;
    const legs = buildLegs(catalog, customer, snap.set, f);
    const base = {
      feature: f.key,
      kind: f.kind,
      requested: amount,
      ...(snap.stale ? { stale: true } : {}),
      ...(isBuffered(legs) ? { buffered: true } : {}),
    };
    if (!rf.enabled && !legs[0]!.recordOnly) {
      return denied(
        { ...base, limit: 0, used: 0, remaining: 0, resetsAt: rf.period?.end ?? null },
        snap,
        amount,
      );
    }
    let values: Map<string, number>;
    try {
      values = await readValues(legs);
    } catch (error) {
      logger.warn(`counter read failed for "${f.key}"`, error);
      return {
        ...base,
        allowed: rf.enabled || legs[0]!.recordOnly,
        reason: "fallback",
        stale: true,
        limit: rf.limit ?? null,
        unlockedBy: [],
      };
    }
    const states = legs.map((l) => legState(l, values));
    const usage = usageFields(legs, states);
    const failed = legs.findIndex((leg, i) => !legCovers(leg, states[i]!, amount));
    if (failed >= 0) {
      const leg = legs[failed]!;
      const needed = states[failed]!.used + amount * leg.rate;
      return denied({ ...base, ...usage }, snap, needed, failed > 0 ? leg.feature.key : undefined);
    }
    const intoOverage = legs.some((leg, i) => {
      const s = states[i]!;
      return s.remaining !== null && s.remaining + 1e-9 < amount * leg.rate;
    });
    return {
      ...base,
      ...usage,
      allowed: true,
      reason:
        rf.override !== undefined
          ? "granted_by_override"
          : intoOverage
            ? "overage_allowed"
            : usage.remaining === null
              ? "included"
              : "within_limit",
      unlockedBy: [],
    };
  }

  async function thresholds(
    customer: string,
    legs: Leg[],
    before: LegState[],
    afterValues: Map<string, number>,
  ) {
    if (!options.onThreshold) return;
    for (const [i, leg] of legs.entries()) {
      const limit = leg.resolved.limit;
      if (leg.recordOnly || limit === null || limit === undefined || limit <= 0) continue;
      const prev = before[i]!.used;
      const next = legState(leg, afterValues).used;
      for (const t of leg.feature.thresholds) {
        const mark = t * limit;
        if (prev < mark && next >= mark) {
          const period = leg.resolved.period?.key ?? "all";
          const end = leg.resolved.period?.end;
          const ttl = end ? Math.max(DAY, Date.parse(end) - now() + DAY) : 365 * DAY;
          const claimed = await strictCounters
            .claim(thresholdKey(customer, leg.feature.key, period, t), ttl)
            .catch(() => false);
          if (!claimed) continue;
          emit(
            options.onThreshold,
            {
              customer,
              feature: leg.feature.key,
              threshold: t,
              used: next,
              limit,
              period,
              resetsAt: end ?? null,
              at: nowIso(),
            },
            onEventError,
          );
        }
      }
    }
  }

  const seriesWrites = new Set<Promise<unknown>>();
  function recordSeries(customer: string, feature: string, amount: number) {
    if (!series || amount === 0) return;
    const date = nowIso().slice(0, 10);
    const p = series
      .add(dailyKey(customer, feature, date), amount, { expiresAt: now() + 400 * DAY })
      .catch((error) => logger.warn("usage series write failed", error))
      .finally(() => seriesWrites.delete(p));
    seriesWrites.add(p);
  }

  function usageEvent(
    customer: string,
    feature: string,
    amount: number,
    source: UsageEvent["source"],
    result: CheckResult,
    extra: Partial<UsageEvent> = {},
  ) {
    emit(
      options.onUsage,
      { customer, feature, amount, source, result, at: nowIso(), ...extra },
      onEventError,
    );
  }

  /** Shared take path for consume / reserve. */
  async function take(
    customer: string,
    feature: string,
    amount: number,
    source: "consume" | "reserve",
    opts: ConsumeOptions = {},
  ): Promise<{ result: CheckResult; takes: Take[]; legs: Leg[] }> {
    assertUnits(amount);
    const f = featureOf(feature);
    if (!f) return { result: unknownFeature(feature), takes: [], legs: [] };
    const snap = await snapshot(customer);
    if (snap.forced) return { result: forcedResult(f, snap), takes: [], legs: [] };
    if (f.kind === "boolean" || f.kind === "value") {
      return { result: nonNumeric(f, snap), takes: [], legs: [] };
    }
    const rf = snap.set.features[f.key]!;
    const legs = buildLegs(catalog, customer, snap.set, f);
    if (!rf.enabled && !legs[0]!.recordOnly) {
      return { result: await check(customer, feature, { amount }), takes: [], legs };
    }
    const claimKey = opts.idempotencyKey
      ? idempotencyKey(customer, opts.idempotencyKey)
      : undefined;
    if (claimKey) {
      const claimed = await strictCounters.claim(claimKey, idempotencyTtl);
      if (!claimed) {
        const current = await check(customer, feature, { amount: 0 });
        return {
          result: { ...current, allowed: true, duplicate: true, requested: amount },
          takes: [],
          legs,
        };
      }
    }
    let values: Map<string, number>;
    let taken;
    try {
      values = await readValues(legs);
      taken = await takeLegsRouted(legs, amount);
    } catch (error) {
      if (claimKey) await strictCounters.release(claimKey).catch(() => {});
      logger.warn(`counter write failed for "${f.key}"`, error);
      const allowed = counterFallback === "allow";
      return {
        result: {
          allowed,
          feature: f.key,
          kind: f.kind,
          reason: "fallback",
          ...(allowed ? {} : { denial: "forbidden" as const }),
          unlockedBy: [],
          stale: true,
          requested: amount,
        },
        takes: [],
        legs,
      };
    }
    const beforeStates = legs.map((l) => legState(l, values));
    if (!taken.ok) {
      if (claimKey) await strictCounters.release(claimKey).catch(() => {});
      const base = {
        feature: f.key,
        kind: f.kind,
        requested: amount,
        ...usageFields(legs, beforeStates),
        ...(snap.stale ? { stale: true } : {}),
        ...(isBuffered(legs) ? { buffered: true } : {}),
      };
      const i = taken.failedLeg ? legs.indexOf(taken.failedLeg) : 0;
      const leg = legs[i]!;
      const needed = beforeStates[i]!.used + amount * leg.rate;
      return {
        result: denied(base, snap, needed, i > 0 ? leg.feature.key : undefined),
        takes: [],
        legs,
      };
    }
    const afterValues = new Map(values);
    for (const t of taken.takes) afterValues.set(t.key, (afterValues.get(t.key) ?? 0) + t.amount);
    const afterStates = legs.map((l) => legState(l, afterValues));
    const intoOverage = afterStates[0]!.overage > beforeStates[0]!.overage;
    const usage = usageFields(legs, afterStates);
    const result: CheckResult = {
      allowed: true,
      feature: f.key,
      kind: f.kind,
      reason:
        rf.override !== undefined
          ? "granted_by_override"
          : intoOverage
            ? "overage_allowed"
            : usage.remaining === null
              ? "included"
              : "within_limit",
      ...usage,
      unlockedBy: [],
      requested: amount,
      ...(snap.stale ? { stale: true } : {}),
      ...(isBuffered(legs) ? { buffered: true } : {}),
    };
    for (const leg of legs) {
      const amt = taken.takes
        .filter((t) => t.feature === leg.feature.key)
        .reduce((s, t) => s + t.amount, 0);
      recordSeries(customer, leg.feature.key, amt);
    }
    usageEvent(customer, f.key, amount, source, result, {
      ...(opts.idempotencyKey ? { idempotencyKey: opts.idempotencyKey } : {}),
      ...(opts.metadata ? { metadata: opts.metadata } : {}),
    });
    void thresholds(customer, legs, beforeStates, afterValues);
    return { result, takes: taken.takes, legs };
  }

  /** takeLegs, routing each leg to its counter store. */
  async function takeLegsRouted(
    legs: Leg[],
    amount: number,
    mode: { force?: boolean; bestEffort?: boolean } = {},
  ) {
    const all: Take[] = [];
    for (const leg of legs) {
      const store = countersFor(leg.feature);
      const r = await takeLegs(store, [leg], amount, mode);
      if (!r.ok) {
        for (const l of legs) {
          const mine = all.filter((t) => t.feature === l.feature.key);
          if (mine.length) await refundTakes(countersFor(l.feature), mine);
        }
        return { ok: false as const, takes: [] as Take[], failedLeg: leg };
      }
      all.push(...r.takes);
    }
    return { ok: true as const, takes: all };
  }

  async function settle(
    reservationId: string,
    actual: number,
    opts: SettleOptions = {},
  ): Promise<CheckResult> {
    assertUnits(actual, "actual");
    const key = reservationKey(reservationId);
    const reservation = await storage.getItem<Reservation>(key);
    if (!reservation)
      throw new NotFoundError(`Reservation "${reservationId}" not found (already settled?)`);
    await storage.removeItem(key);
    const { customer, feature } = reservation;
    const delta = actual - reservation.amount;
    if (delta < 0) {
      // Refund the unused part, newest takes first, per leg in its own units.
      for (const [leg, rate] of Object.entries(reservation.rates)) {
        let refund = -delta * rate;
        const store = countersFor(featureOf(leg)!);
        for (const t of [...reservation.takes].reverse()) {
          if (t.feature !== leg || refund <= 1e-9) continue;
          const r = Math.min(t.amount, refund);
          await store.add(t.key, -r, { min: 0, partial: true });
          refund -= r;
        }
        recordSeries(customer, leg, delta * rate);
      }
    } else if (delta > 0) {
      const f = featureOf(feature)!;
      const snap = await snapshot(customer);
      const legs = buildLegs(catalog, customer, snap.set, f);
      const r = await takeLegsRouted(
        legs,
        delta,
        opts.overage === "cap" ? { bestEffort: true } : { force: true },
      );
      for (const leg of legs) {
        const amt = r.takes
          .filter((t) => t.feature === leg.feature.key)
          .reduce((s, t) => s + t.amount, 0);
        recordSeries(customer, leg.feature.key, amt);
      }
    }
    const result = await check(customer, feature, { amount: 0 });
    usageEvent(customer, feature, delta, actual === 0 ? "release" : "settle", result, {
      reservationId,
    });
    return { ...result, allowed: true, requested: actual };
  }

  const client = (id: string): CustomerClient<C> => ({
    id,
    check: (feature, o) => engine.check(id, feature, o),
    consume: (feature, amount, o) => engine.consume(id, feature, amount, o),
    release: (feature, amount) => engine.release(id, feature, amount),
    reserve: (feature, amount, o) => engine.reserve(id, feature, amount, o),
    require: (feature, o) => engine.require(id, feature, o),
    entitlements: () => engine.entitlements(id),
  });

  const featureOrThrow = (feature: string): NormalizedFeature => {
    const f = featureOf(feature);
    if (!f) throw new EntitlementsValidationError(`Unknown feature "${feature}"`);
    return f;
  };

  const actorOf = (o?: ActorOptions): Actor | null => o?.actor ?? null;

  const periodFor = (start: number) => ({
    periodStart: new Date(start).toISOString(),
    periodEnd: new Date(addMonthsClamped(start, 1)).toISOString(),
  });

  const engine: Entitlements<C> = {
    catalog,
    storage,
    counters: strictCounters,
    readonly,

    check: (customer, feature, o) => check(customer, feature, o) as never,

    async require(customer, feature, o) {
      const r = await check(customer, feature, o);
      if (!r.allowed) throw new EntitlementDeniedError(r);
      return r;
    },

    async consume(customer, feature, amount = 1, o) {
      return (await take(customer, feature, amount, "consume", o)).result;
    },

    async consumeOrThrow(customer, feature, amount = 1, o) {
      const r = (await take(customer, feature, amount, "consume", o)).result;
      if (!r.allowed) throw new EntitlementDeniedError(r);
      return r;
    },

    async release(customer, feature, amount = 1) {
      assertUnits(amount);
      const f = featureOf(feature);
      if (!f) return unknownFeature(feature);
      if (f.kind === "boolean" || f.kind === "value") return check(customer, feature);
      const snap = await snapshot(customer);
      const key =
        f.kind === "capacity"
          ? capacityKey(customer, f.key)
          : usageKey(customer, f.key, snap.set.features[f.key]!.period?.key ?? "all");
      const released = await countersFor(f).add(key, -amount, { min: 0, partial: true });
      recordSeries(customer, f.key, released.applied);
      const result = await check(customer, feature, { amount: 0 });
      usageEvent(customer, f.key, -amount, "release", result);
      return result;
    },

    async reserve(customer, feature, amount, o = {}) {
      const { result, takes, legs } = await take(customer, feature, amount, "reserve");
      if (!result.allowed || legs.length === 0) return result;
      const createdAt = now();
      const reservation: Reservation = {
        id: newId("rsv", createdAt),
        customer,
        feature,
        amount,
        takes,
        rates: Object.fromEntries(legs.map((l) => [l.feature.key, l.rate])),
        createdAt: new Date(createdAt).toISOString(),
        expiresAt: new Date(
          createdAt + (o.ttl !== undefined ? durationToMs(o.ttl) : reservationTtl),
        ).toISOString(),
      };
      if (o.metadata) reservation.metadata = o.metadata;
      try {
        await storage.setItem(reservationKey(reservation.id), reservation);
      } catch (error) {
        for (const l of legs) {
          const mine = takes.filter((t) => t.feature === l.feature.key);
          await refundTakes(countersFor(l.feature), mine).catch(() => {});
        }
        throw error;
      }
      return { ...result, reservation };
    },

    settle,
    cancelReservation: (id) => settle(id, 0),

    async sweep() {
      const keys = await storage.getKeys(reservationsPrefix());
      let released = 0;
      for (const key of keys) {
        const r = await storage.getItem<Reservation>(key);
        if (r && Date.parse(r.expiresAt) <= now()) {
          try {
            await settle(r.id, 0);
            released++;
          } catch (error) {
            if (!(error instanceof NotFoundError)) throw error;
          }
        }
      }
      return { released };
    },

    async entitlements(customer) {
      const snap = await snapshot(customer);
      const features: Record<string, FeatureUsage> = {};
      const numeric: { f: NormalizedFeature; legs: Leg[] }[] = [];
      for (const key of n.featureOrder) {
        const f = n.features.get(key)!;
        features[key] = { ...snap.set.features[key]! };
        if (f.kind !== "boolean" && f.kind !== "value") {
          numeric.push({ f, legs: [buildLegs(catalog, customer, snap.set, f)[0]!] });
        }
      }
      let stale = snap.stale;
      try {
        const values = await readValues(numeric.flatMap((x) => x.legs));
        for (const { f, legs } of numeric) {
          const s = legState(legs[0]!, values);
          const fu = features[f.key]!;
          fu.used = s.used;
          fu.remaining = legs[0]!.recordOnly ? null : s.remaining;
          if (s.overage > 0) fu.overage = s.overage;
          fu.resetsAt = fu.period?.end ?? null;
          if (s.grantBalances.length) fu.grantBalances = s.grantBalances;
        }
      } catch (error) {
        logger.warn(`counter read failed for "${customer}"`, error);
        stale = true;
      }
      return { ...snap.set, features, ...(stale ? { stale: true } : {}) };
    },

    customer: client,

    // --- control plane ---------------------------------------------------------

    async getCustomer(customer) {
      return storage.getItem<CustomerState>(customerKey(customer));
    },

    async listCustomers(o = {}) {
      const limit = Math.min(Math.max(o.limit ?? 50, 1), 500);
      const ids = (await storage.getKeys(customersPrefix()))
        .map((k) => lastSegment(k))
        .sort()
        .filter((id) => (o.after ? id > o.after : true));
      const search = o.search?.toLowerCase();
      const out: CustomerSummary[] = [];
      let next: string | undefined;
      for (const id of ids) {
        const state = await storage.getItem<CustomerState>(customerKey(id));
        if (!state) continue;
        if (
          search &&
          !id.toLowerCase().includes(search) &&
          !state.name?.toLowerCase().includes(search) &&
          !state.email?.toLowerCase().includes(search)
        ) {
          continue;
        }
        if (out.length === limit) {
          next = out[out.length - 1]!.id;
          break;
        }
        const set = resolveEntitlements(catalog, state, now(), { entitledStatuses: entitled });
        const summary: CustomerSummary = {
          id,
          plans: set.plans.map((p) => p.plan),
          statuses: state.subscriptions.map((s) => s.status),
          updatedAt: state.updatedAt,
        };
        if (state.name) summary.name = state.name;
        if (state.email) summary.email = state.email;
        out.push(summary);
      }
      return next ? { customers: out, next } : { customers: out };
    },

    async updateCustomer(customer, patch, o) {
      const actor = actorOf(o);
      const { state } = await mutate(customer, "update customer", async (draft) => {
        await before({ type: "customer.update", customer, actor });
        if (patch.name !== undefined) draft.name = patch.name;
        if (patch.email !== undefined) draft.email = patch.email;
        if (patch.metadata !== undefined) draft.metadata = { ...draft.metadata, ...patch.metadata };
      });
      await record(customer, "customer.updated", "Customer details updated", actor);
      await after({ type: "customer.updated", customer, state, actor, at: nowIso() });
      return state;
    },

    async deleteCustomer(customer, o) {
      if (readonly) throw new ReadonlyError("delete customer");
      const actor = actorOf(o);
      const state = await storage.getItem<CustomerState>(customerKey(customer));
      if (!state) throw new NotFoundError(`Customer "${customer}" not found`);
      await before({ type: "customer.delete", customer, actor });
      await storage.removeItem(customerKey(customer));
      for (const [provider, id] of Object.entries(state.providers)) {
        await storage.removeItem(linkKey(provider, id)).catch(() => {});
      }
      cache.delete(customer);
      await record(customer, "customer.deleted", "Customer deleted", actor);
      await after({ type: "customer.deleted", customer, state, actor, at: nowIso() });
    },

    async upsertSubscription(customer, input, o) {
      const actor = actorOf(o);
      const kind = input.kind ?? (n.addons.has(input.plan) ? "addon" : "plan");
      if (kind === "plan" && !n.plans.has(input.plan)) {
        throw new EntitlementsValidationError(`Unknown plan "${input.plan}"`);
      }
      if (kind === "addon" && !n.addons.has(input.plan)) {
        throw new EntitlementsValidationError(`Unknown add-on "${input.plan}"`);
      }
      if (input.quantity !== undefined && !(input.quantity >= 0)) {
        throw new EntitlementsValidationError("quantity must be >= 0");
      }
      const provider = input.provider ?? "manual";
      let previous: Subscription | undefined;
      const { result } = await mutate(customer, "change subscription", async (draft) => {
        const existing = draft.subscriptions.find(
          (s) =>
            (input.id !== undefined && s.id === input.id) ||
            (input.providerRef !== undefined &&
              s.provider === provider &&
              s.providerRef === input.providerRef),
        );
        if (input.id !== undefined && !existing && provider === "manual") {
          throw new NotFoundError(`Subscription "${input.id}" not found`);
        }
        if (
          existing?.providerUpdatedAt &&
          input.providerUpdatedAt &&
          Date.parse(input.providerUpdatedAt) < Date.parse(existing.providerUpdatedAt)
        ) {
          return { subscription: existing, outcome: "stale" as const };
        }
        previous = existing ? structuredClone(existing) : undefined;
        const at = nowIso();
        const version =
          input.version ??
          (existing && existing.plan === input.plan
            ? existing.version
            : kind === "plan"
              ? n.plans.get(input.plan)!.version
              : 1);
        if (kind === "plan" && !n.planVersions.has(`${input.plan}@${version}`)) {
          throw new EntitlementsValidationError(`Plan "${input.plan}" has no version ${version}`);
        }
        const sub: Subscription = {
          ...existing,
          id: existing?.id ?? input.id ?? newId("sub", now()),
          plan: input.plan,
          version,
          kind,
          status: input.status ?? existing?.status ?? "active",
          quantity: input.quantity ?? existing?.quantity ?? 1,
          provider,
          createdAt: existing?.createdAt ?? at,
          updatedAt: at,
        };
        const optional = [
          "periodStart",
          "periodEnd",
          "trialEndsAt",
          "cancelAtPeriodEnd",
          "canceledAt",
          "providerRef",
          "providerUpdatedAt",
          "metadata",
        ] as const;
        for (const k of optional) {
          if (input[k] !== undefined) (sub as unknown as Record<string, unknown>)[k] = input[k];
        }
        if (!sub.periodStart && provider === "manual") Object.assign(sub, periodFor(now()));
        await before({
          type: "subscription.upsert",
          customer,
          subscription: sub,
          ...(previous ? { previous } : {}),
          actor,
        });
        if (existing) draft.subscriptions[draft.subscriptions.indexOf(existing)] = sub;
        else draft.subscriptions.push(sub);
        if (sub.status === "trialing" && kind === "plan" && !draft.trials[sub.plan])
          draft.trials[sub.plan] = at;
        return {
          subscription: sub,
          outcome: existing ? ("updated" as const) : ("created" as const),
        };
      });
      if (result.outcome !== "stale") {
        const s = result.subscription;
        await record(
          customer,
          "subscription.changed",
          previous
            ? `${s.kind === "addon" ? "Add-on" : "Plan"} ${s.plan} ${previous.status === s.status ? "updated" : `${previous.status} → ${s.status}`}`
            : `${s.kind === "addon" ? "Add-on" : "Plan"} ${s.plan} (${s.status})`,
          actor,
          { subscriptionId: s.id, plan: s.plan, status: s.status, provider: s.provider },
        );
        await after({
          type: "subscription.changed",
          customer,
          subscription: s,
          ...(previous ? { previous } : {}),
          actor,
          at: nowIso(),
        });
      }
      return result;
    },

    async subscribe(customer, input, o) {
      const plan = n.plans.get(input.plan);
      const addon = n.addons.get(input.plan);
      if (!plan && !addon) throw new EntitlementsValidationError(`Unknown plan "${input.plan}"`);
      if (plan && input.replace !== false) {
        const state = await engine.getCustomer(customer);
        for (const s of state?.subscriptions ?? []) {
          const sp = s.kind === "plan" ? getPlanVersion(catalog, s.plan, s.version) : undefined;
          if (sp && sp.group === plan.group && s.provider === "manual" && s.status !== "canceled") {
            await engine.upsertSubscription(
              customer,
              { id: s.id, plan: s.plan, status: "canceled", canceledAt: nowIso() },
              o,
            );
          }
        }
      }
      const { subscription } = await engine.upsertSubscription(
        customer,
        {
          plan: input.plan,
          ...(input.version !== undefined ? { version: input.version } : {}),
          ...(input.quantity !== undefined ? { quantity: input.quantity } : {}),
          status: input.status ?? "active",
          ...(input.trialEndsAt !== undefined ? { trialEndsAt: input.trialEndsAt } : {}),
          ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
          provider: "manual",
        },
        o,
      );
      return subscription;
    },

    async cancelSubscription(customer, subscriptionId, o = {}) {
      const state = await engine.getCustomer(customer);
      const sub = state?.subscriptions.find((s) => s.id === subscriptionId);
      if (!sub) throw new NotFoundError(`Subscription "${subscriptionId}" not found`);
      const { subscription } = await engine.upsertSubscription(
        customer,
        o.atPeriodEnd
          ? { id: sub.id, plan: sub.plan, provider: sub.provider, cancelAtPeriodEnd: true }
          : {
              id: sub.id,
              plan: sub.plan,
              provider: sub.provider,
              status: "canceled",
              canceledAt: nowIso(),
            },
        o,
      );
      return subscription;
    },

    async removeSubscription(customer, subscriptionId, o) {
      const actor = actorOf(o);
      let removed: Subscription | undefined;
      await mutate(customer, "remove subscription", async (draft) => {
        const i = draft.subscriptions.findIndex((s) => s.id === subscriptionId);
        if (i < 0) throw new NotFoundError(`Subscription "${subscriptionId}" not found`);
        await before({ type: "subscription.remove", customer, subscriptionId, actor });
        removed = draft.subscriptions.splice(i, 1)[0];
      });
      await record(
        customer,
        "subscription.removed",
        `Removed ${removed!.plan} subscription`,
        actor,
        {
          subscriptionId,
        },
      );
      await after({
        type: "subscription.removed",
        customer,
        subscription: removed!,
        actor,
        at: nowIso(),
      });
    },

    async startTrial(customer, planKey, o = {}) {
      const plan = n.plans.get(planKey);
      if (!plan) throw new EntitlementsValidationError(`Unknown plan "${planKey}"`);
      const days = o.days ?? plan.trialDays;
      if (!days || !(days > 0))
        throw new EntitlementsValidationError(`Plan "${planKey}" has no trial`);
      const state = await engine.getCustomer(customer);
      if (state?.trials[planKey] && !o.force) {
        throw new EntitlementsValidationError(
          `Customer "${customer}" already used the ${planKey} trial`,
        );
      }
      return engine.subscribe(
        customer,
        {
          plan: planKey,
          status: "trialing",
          trialEndsAt: new Date(now() + days * DAY).toISOString(),
        },
        o,
      );
    },

    async migratePlan(customer, planKey, toVersion, o) {
      const plan = n.plans.get(planKey);
      if (!plan) throw new EntitlementsValidationError(`Unknown plan "${planKey}"`);
      const version = toVersion ?? plan.version;
      if (!n.planVersions.has(`${planKey}@${version}`)) {
        throw new EntitlementsValidationError(`Plan "${planKey}" has no version ${version}`);
      }
      const ids =
        customer === "*"
          ? (await storage.getKeys(customersPrefix())).map((k) => lastSegment(k))
          : [customer];
      let migrated = 0;
      for (const id of ids) {
        const state = await engine.getCustomer(id);
        for (const s of state?.subscriptions ?? []) {
          if (s.kind === "plan" && s.plan === planKey && s.version !== version) {
            await engine.upsertSubscription(
              id,
              { id: s.id, plan: s.plan, provider: s.provider, version },
              o,
            );
            migrated++;
          }
        }
      }
      return { migrated };
    },

    async grant(customer, input, o) {
      const actor = actorOf(o);
      const f = featureOrThrow(input.feature);
      if (f.kind === "boolean" || f.kind === "value") {
        throw new EntitlementsValidationError(
          `Grants apply to numeric features; use an override for "${f.key}"`,
        );
      }
      if (!(input.amount > 0) || !Number.isFinite(input.amount)) {
        throw new EntitlementsValidationError("grant amount must be a finite number > 0");
      }
      const grant: Grant = {
        id: newId("grt", now()),
        feature: f.key,
        amount: input.amount,
        priority: input.priority ?? 0,
        createdAt: nowIso(),
      };
      if (input.recurring) grant.recurring = true;
      for (const k of ["startsAt", "expiresAt", "reason", "metadata"] as const) {
        if (input[k] !== undefined) (grant as unknown as Record<string, unknown>)[k] = input[k];
      }
      if (actor) grant.actor = actor;
      await mutate(customer, "grant", async (draft) => {
        await before({ type: "grant.create", customer, grant, actor });
        draft.grants.push(grant);
      });
      await record(
        customer,
        "grant.created",
        `Granted ${input.amount} ${f.name}${grant.recurring ? " per period" : ""}${input.reason ? ` — ${input.reason}` : ""}`,
        actor,
        { grantId: grant.id, feature: f.key, amount: input.amount },
      );
      await after({ type: "grant.created", customer, grant, actor, at: nowIso() });
      return grant;
    },

    async revokeGrant(customer, grantId, o) {
      const actor = actorOf(o);
      let removed: Grant | undefined;
      await mutate(customer, "revoke grant", async (draft) => {
        const i = draft.grants.findIndex((g) => g.id === grantId);
        if (i < 0) throw new NotFoundError(`Grant "${grantId}" not found`);
        await before({ type: "grant.revoke", customer, grantId, actor });
        removed = draft.grants.splice(i, 1)[0];
      });
      await record(
        customer,
        "grant.revoked",
        `Revoked grant of ${removed!.amount} ${removed!.feature}`,
        actor,
        {
          grantId,
        },
      );
      await after({ type: "grant.revoked", customer, grant: removed!, actor, at: nowIso() });
    },

    async override(customer, input, o) {
      const actor = actorOf(o);
      const f = featureOrThrow(input.feature);
      if (
        input.enabled === undefined &&
        input.limit === undefined &&
        input.value === undefined &&
        input.overage === undefined
      ) {
        throw new EntitlementsValidationError("an override needs enabled, limit, overage or value");
      }
      if (input.value !== undefined && f.kind !== "value") {
        throw new EntitlementsValidationError(`"${f.key}" is not a value feature`);
      }
      if (
        (input.limit !== undefined || input.overage !== undefined) &&
        (f.kind === "boolean" || f.kind === "value")
      ) {
        throw new EntitlementsValidationError(`"${f.key}" has no limit`);
      }
      if (input.limit !== undefined && input.limit !== null && !(input.limit >= 0)) {
        throw new EntitlementsValidationError("limit must be >= 0 or null (unlimited)");
      }
      const override: Override = { id: newId("ovr", now()), feature: f.key, createdAt: nowIso() };
      for (const k of [
        "enabled",
        "limit",
        "overage",
        "value",
        "startsAt",
        "expiresAt",
        "reason",
      ] as const) {
        if (input[k] !== undefined) (override as unknown as Record<string, unknown>)[k] = input[k];
      }
      if (actor) override.actor = actor;
      await mutate(customer, "override", async (draft) => {
        await before({ type: "override.create", customer, override, actor });
        draft.overrides.push(override);
      });
      const what =
        input.enabled === false
          ? "disabled"
          : input.limit !== undefined
            ? `limit ${input.limit === null ? "unlimited" : input.limit}`
            : input.value !== undefined
              ? `value ${JSON.stringify(input.value)}`
              : input.enabled
                ? "enabled"
                : `overage ${input.overage}`;
      await record(
        customer,
        "override.created",
        `Override ${f.name}: ${what}${input.reason ? ` — ${input.reason}` : ""}`,
        actor,
        {
          overrideId: override.id,
          feature: f.key,
        },
      );
      await after({ type: "override.created", customer, override, actor, at: nowIso() });
      return override;
    },

    async removeOverride(customer, overrideId, o) {
      const actor = actorOf(o);
      let removed: Override | undefined;
      await mutate(customer, "remove override", async (draft) => {
        const i = draft.overrides.findIndex((x) => x.id === overrideId);
        if (i < 0) throw new NotFoundError(`Override "${overrideId}" not found`);
        await before({ type: "override.remove", customer, overrideId, actor });
        removed = draft.overrides.splice(i, 1)[0];
      });
      await record(customer, "override.removed", `Removed override on ${removed!.feature}`, actor, {
        overrideId,
      });
      await after({ type: "override.removed", customer, override: removed!, actor, at: nowIso() });
    },

    async setUsage(customer, feature, value, o) {
      if (readonly) throw new ReadonlyError("set usage");
      const actor = actorOf(o);
      const f = featureOrThrow(feature);
      if (f.kind === "boolean" || f.kind === "value")
        throw new EntitlementsValidationError(`"${f.key}" has no usage`);
      assertUnits(value, "value");
      await before({ type: "usage.set", customer, feature: f.key, value, actor });
      const snap = await snapshot(customer);
      const key =
        f.kind === "capacity"
          ? capacityKey(customer, f.key)
          : usageKey(customer, f.key, snap.set.features[f.key]!.period?.key ?? "all");
      await countersFor(f).set(key, value);
      const result = await check(customer, feature, { amount: 0 });
      usageEvent(customer, f.key, value, "set", result);
      if (actor)
        await record(customer, "usage.set", `${f.name} usage set to ${value}`, actor, {
          feature: f.key,
          value,
        });
      await after({ type: "usage.set", customer, feature: f.key, value, actor, at: nowIso() });
    },

    async resetUsage(customer, feature, o) {
      if (readonly) throw new ReadonlyError("reset usage");
      const actor = actorOf(o);
      const f = featureOrThrow(feature);
      if (f.kind === "boolean" || f.kind === "value")
        throw new EntitlementsValidationError(`"${f.key}" has no usage`);
      await before({ type: "usage.reset", customer, feature: f.key, actor });
      const snap = await snapshot(customer);
      const key =
        f.kind === "capacity"
          ? capacityKey(customer, f.key)
          : usageKey(customer, f.key, snap.set.features[f.key]!.period?.key ?? "all");
      await countersFor(f).delete([key]);
      await record(customer, "usage.reset", `${f.name} usage reset`, actor, { feature: f.key });
      await after({ type: "usage.reset", customer, feature: f.key, actor, at: nowIso() });
    },

    async link(customer, provider, providerCustomer) {
      if (readonly) throw new ReadonlyError("link customer");
      await storage.setItem(linkKey(provider, providerCustomer), customer);
      const state = await engine.getCustomer(customer);
      if (state?.providers[provider] !== providerCustomer) {
        await mutate(customer, "link customer", (draft) => {
          draft.providers[provider] = providerCustomer;
        });
      }
    },

    async resolveLink(provider, providerCustomer) {
      return storage.getItem<string>(linkKey(provider, providerCustomer));
    },

    async activity(customer, o = {}) {
      const list = await storage.getItem<ActivityEntry[]>(
        customer ? activityKey(customer) : activityLogKey(),
      );
      return (list ?? []).slice(0, o.limit ?? 50);
    },

    async usageSeries(customer, feature, o = {}) {
      const f = featureOrThrow(feature);
      const to = o.to ? Date.parse(o.to) : now();
      const from = o.from ? Date.parse(o.from) : to - ((o.days ?? 30) - 1) * DAY;
      const dates: string[] = [];
      for (
        let t = Date.UTC(
          new Date(from).getUTCFullYear(),
          new Date(from).getUTCMonth(),
          new Date(from).getUTCDate(),
        );
        t <= to && dates.length < 400;
        t += DAY
      ) {
        dates.push(new Date(t).toISOString().slice(0, 10));
      }
      if (!series) return dates.map((date) => ({ date, value: 0 }));
      await Promise.all(seriesWrites);
      const values = await series.get(dates.map((d) => dailyKey(customer, f.key, d)));
      return dates.map((date, i) => ({ date, value: values[i] ?? 0 }));
    },

    pricing: (o) => pricingTable(catalog, o),

    invalidate(customer) {
      if (customer === undefined) cache.clear();
      else cache.delete(customer);
    },

    async close() {
      unwatch?.();
      await watching;
      unwatch?.();
      await series?.close();
      if (bufferedCounters && isBufferedCounterStore(bufferedCounters))
        await bufferedCounters.flush();
    },
  };
  return engine;
}

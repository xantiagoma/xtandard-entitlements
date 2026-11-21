/**
 * The consumption algorithm (ADR 0005). A request for `n` units of a feature
 * becomes one or more **legs** (the feature itself, plus one per credit pool it
 * draws from), each an ordered list of **buckets**: the period allowance, then
 * one-off grants (priority, soonest expiry), then overage. The single-bucket
 * case is one all-or-nothing atomic `add`; otherwise partial takes run in order
 * and are refunded if the request cannot be covered — a refusal never counts.
 *
 * @module
 */

import type { AnyCatalog, NormalizedFeature } from "./catalog.ts";
import type { CounterStore } from "./counters/contract.ts";
import { capacityKey, grantKey, usageKey } from "./keys.ts";
import type { EntitlementSet, ResolvedFeature } from "./schema.ts";

const EPSILON = 1e-9;
/** Retention added to a period's end before its counter may expire. */
export const COUNTER_RETENTION_MS = 400 * 86_400_000;

/** One counter a leg may draw from. */
export interface Bucket {
  key: string;
  /** Upper bound for this bucket's counter (undefined = unbounded). */
  max?: number;
  type: "allowance" | "grant" | "overage" | "record";
  grantId?: string;
  expiresAt?: number;
}

/** One feature's share of a request. */
export interface Leg {
  feature: NormalizedFeature;
  resolved: ResolvedFeature;
  /** Units of this leg per requested unit (1 for the feature itself). */
  rate: number;
  /** Track usage without enforcing (a credits-only feature's own counter). */
  recordOnly: boolean;
  /** The allowance / capacity counter. */
  usageKey: string;
  buckets: Bucket[];
}

/** A completed counter take. */
export interface Take {
  key: string;
  amount: number;
  feature: string;
}

/** Usage of one leg, from its counters. */
export interface LegState {
  /** Allowance counter + grant counters. */
  used: number;
  /** In leg units; `null` = unlimited. */
  remaining: number | null;
  /** Extra room from an overage policy (Infinity when unlimited overage). */
  overageRoom: number;
  overage: number;
  periodUsed: number;
  grantBalances: Array<{ id: string; amount: number; used: number; expiresAt?: string }>;
}

function bucketsFor(
  customer: string,
  rf: ResolvedFeature,
  key: string,
  periodExpiry: number | undefined,
): Bucket[] {
  const base: Bucket = { key, type: "allowance" };
  if (periodExpiry !== undefined) base.expiresAt = periodExpiry;
  if (rf.allowance === null || rf.allowance === undefined) return [base];
  const out: Bucket[] = [{ ...base, max: rf.allowance }];
  for (const g of rf.grants ?? []) {
    const b: Bucket = {
      key: grantKey(customer, g.id),
      max: g.amount,
      type: "grant",
      grantId: g.id,
    };
    if (g.expiresAt) b.expiresAt = Date.parse(g.expiresAt) + COUNTER_RETENTION_MS;
    out.push(b);
  }
  if (rf.overagePolicy === "allow") {
    const o: Bucket = { ...base, type: "overage" };
    if (rf.overageLimit !== null && rf.overageLimit !== undefined)
      o.max = rf.allowance + rf.overageLimit;
    else delete o.max;
    out.push(o);
  }
  return out;
}

function legFor(
  customer: string,
  feature: NormalizedFeature,
  rf: ResolvedFeature,
  rate: number,
  recordOnly: boolean,
): Leg {
  const key =
    feature.kind === "capacity"
      ? capacityKey(customer, feature.key)
      : usageKey(customer, feature.key, rf.period?.key ?? "all");
  const end = rf.period?.end ? Date.parse(rf.period.end) + COUNTER_RETENTION_MS : undefined;
  const buckets = recordOnly
    ? [{ key, type: "record" as const, ...(end !== undefined ? { expiresAt: end } : {}) }]
    : bucketsFor(customer, rf, key, end);
  return { feature, resolved: rf, rate, recordOnly, usageKey: key, buckets };
}

/**
 * The legs for `feature`. A metered feature with `creditCost` that no plan
 * includes is governed by its credit pools only (its own counter is record-only).
 */
export function buildLegs(
  catalog: AnyCatalog,
  customer: string,
  set: EntitlementSet,
  feature: NormalizedFeature,
): Leg[] {
  const rf = set.features[feature.key]!;
  const credits = Object.entries(feature.creditCost ?? {});
  const legs: Leg[] = [];
  const ownRecordOnly = credits.length > 0 && !rf.enabled && rf.override === undefined;
  legs.push(legFor(customer, feature, rf, 1, ownRecordOnly));
  for (const [pool, rate] of credits) {
    const pf = catalog.normalized.features.get(pool)!;
    legs.push(legFor(customer, pf, set.features[pool]!, rate, false));
  }
  return legs;
}

/** Every counter key the legs read. */
export function legKeys(legs: readonly Leg[]): string[] {
  const keys = new Set<string>();
  for (const leg of legs) for (const b of leg.buckets) keys.add(b.key);
  return [...keys];
}

/** Compute a leg's usage from counter values. */
export function legState(leg: Leg, values: ReadonlyMap<string, number>): LegState {
  const periodUsed = values.get(leg.usageKey) ?? 0;
  const grantBalances: LegState["grantBalances"] = [];
  let grantUsed = 0;
  let grantRemaining = 0;
  for (const b of leg.buckets) {
    if (b.type !== "grant") continue;
    const used = values.get(b.key) ?? 0;
    grantUsed += used;
    grantRemaining += Math.max(0, (b.max ?? 0) - used);
    const g = leg.resolved.grants?.find((x) => x.id === b.grantId);
    grantBalances.push({
      id: b.grantId!,
      amount: b.max ?? 0,
      used,
      ...(g?.expiresAt ? { expiresAt: g.expiresAt } : {}),
    });
  }
  const allowance = leg.resolved.allowance;
  const unlimited = leg.recordOnly || allowance === null || allowance === undefined;
  const remaining = unlimited ? null : Math.max(0, allowance - periodUsed) + grantRemaining;
  let overageRoom = 0;
  if (!unlimited && leg.resolved.overagePolicy === "allow") {
    const ol = leg.resolved.overageLimit;
    overageRoom =
      ol === null || ol === undefined
        ? Infinity
        : Math.max(0, allowance + ol - Math.max(periodUsed, allowance));
  }
  return {
    used: periodUsed + grantUsed,
    remaining,
    overageRoom,
    overage: unlimited ? 0 : Math.max(0, periodUsed - allowance),
    periodUsed,
    grantBalances,
  };
}

/** Can the leg cover `units` (in requested units)? */
export function legCovers(leg: Leg, state: LegState, units: number): boolean {
  if (state.remaining === null) return true;
  return state.remaining + state.overageRoom + EPSILON >= units * leg.rate;
}

/** Undo takes (newest first). Refunds clamp at 0. */
export async function refundTakes(counters: CounterStore, takes: readonly Take[]): Promise<void> {
  for (const t of [...takes].reverse()) {
    if (t.amount > 0) await counters.add(t.key, -t.amount, { min: 0, partial: true });
  }
}

/** Result of {@link takeLegs}. */
export interface TakeResult {
  ok: boolean;
  takes: Take[];
  /** The leg that could not be covered. */
  failedLeg?: Leg;
}

/**
 * Atomically take `units` across the legs. Modes for settling work that
 * already happened: `force` records any shortfall on the allowance counter past
 * its limit; `bestEffort` keeps whatever fit and reports success.
 */
export async function takeLegs(
  counters: CounterStore,
  legs: readonly Leg[],
  units: number,
  options: { force?: boolean; bestEffort?: boolean } = {},
): Promise<TakeResult> {
  const takes: Take[] = [];
  const opts = (b: Bucket) => (b.expiresAt !== undefined ? { expiresAt: b.expiresAt } : {});
  for (const leg of legs) {
    let need = units * leg.rate;
    if (need <= 0) continue;
    const feature = leg.feature.key;
    const [first] = leg.buckets;
    if (leg.buckets.length === 1 && first && !options.force && !options.bestEffort) {
      const r = await counters.add(first.key, need, {
        ...opts(first),
        ...(first.max !== undefined ? { max: first.max } : {}),
      });
      if (r.applied + EPSILON < need) {
        await refundTakes(counters, takes);
        return { ok: false, takes: [], failedLeg: leg };
      }
      takes.push({ key: first.key, amount: r.applied, feature });
      continue;
    }
    for (const b of leg.buckets) {
      if (need <= EPSILON) break;
      const r = await counters.add(b.key, need, {
        ...opts(b),
        ...(b.max !== undefined ? { max: b.max } : {}),
        partial: true,
      });
      if (r.applied > 0) {
        takes.push({ key: b.key, amount: r.applied, feature });
        need -= r.applied;
      }
    }
    if (need > EPSILON) {
      if (options.force) {
        const b = leg.buckets[0]!;
        await counters.add(leg.usageKey, need, opts(b));
        takes.push({ key: leg.usageKey, amount: need, feature });
      } else if (!options.bestEffort) {
        await refundTakes(counters, takes);
        return { ok: false, takes: [], failedLeg: leg };
      }
    }
  }
  return { ok: true, takes };
}

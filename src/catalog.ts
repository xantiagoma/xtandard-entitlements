/**
 * The catalog: features, plans, add-ons, trials and plan versions, declared once
 * in code and imported everywhere — server, browser, edge and marketing pages
 * (ADR 0002). **Zero dependencies.**
 *
 * @example
 * ```ts
 * import { defineCatalog, feature } from "@xtandard/entitlements/catalog";
 *
 * export const catalog = defineCatalog({
 *   features: {
 *     seats: feature.capacity({ name: "Seats", unit: "seat" }),
 *     api_calls: feature.metered({ name: "API calls", unit: "call", reset: "month" }),
 *     export_pdf: feature.boolean({ name: "PDF export" }),
 *     max_upload_mb: feature.value({ name: "Max upload (MB)", default: 10 }),
 *   },
 *   plans: {
 *     free: { name: "Free", default: true, features: { api_calls: 1_000, seats: 3 } },
 *     pro: {
 *       name: "Pro",
 *       trial: { days: 14 },
 *       price: { amount: 2900, currency: "usd", interval: "month" },
 *       providers: { stripe: ["price_pro_monthly"] },
 *       features: { api_calls: { limit: 100_000, overage: "allow" }, seats: 10, export_pdf: true },
 *     },
 *   },
 *   addons: {
 *     extra_seats: { name: "+5 seats", quantity: true, features: { seats: { add: 5 } } },
 *   },
 * });
 * ```
 *
 * @module catalog
 */

/** A JSON primitive. */
export type JsonPrimitive = string | number | boolean | null;
/** Any JSON-serializable value. */
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
/** A JSON object. */
export type JsonObject = { [key: string]: JsonValue };

/** When a metered or credits feature's usage starts over (ADR 0014). */
export type ResetInterval =
  | "day"
  | "week"
  | "month"
  | "quarter"
  | "year"
  | "billing_period"
  | "never";

/** The five feature kinds. */
export type FeatureKind = "boolean" | "metered" | "capacity" | "value" | "credits";

/** What happens when usage would exceed the limit. */
export type OveragePolicy = "block" | "allow";

/** How a metered feature's counter is written (ADR 0006). */
export type MeteringMode = "strict" | "buffered";

interface FeatureCommon {
  /** Display name (defaults to the key). */
  name?: string;
  description?: string;
  /** Singular unit label, e.g. `"seat"`, `"call"`. */
  unit?: string;
  /** Plural unit label. Default: `unit + "s"`. */
  units?: string;
  /** Hide from pricing tables and the customer portal. */
  hidden?: boolean;
  metadata?: JsonObject;
}

/** An on/off feature. */
export interface BooleanFeature extends FeatureCommon {
  kind: "boolean";
}

/** A consumption counter that resets (API calls, tokens, exports per month). */
export interface MeteredFeature extends FeatureCommon {
  kind: "metered";
  reset: ResetInterval;
  /**
   * Draw from credit pools instead of (or in addition to) a plan limit:
   * `{ ai_credits: 0.5 }` charges 0.5 credits per unit consumed.
   */
  creditCost?: Record<string, number>;
  /** `"buffered"` decides locally and writes behind (ADR 0006). Default `"strict"`. */
  metering?: MeteringMode;
  /** Usage ratios that fire `onThreshold` once per period. Default `[0.8, 1]`. */
  thresholds?: number[];
}

/** A prepaid balance other metered features can draw from (`creditCost`). */
export interface CreditsFeature extends FeatureCommon {
  kind: "credits";
  reset: ResetInterval;
  metering?: MeteringMode;
  thresholds?: number[];
}

/** A current count against a ceiling (seats, projects). Never resets. */
export interface CapacityFeature extends FeatureCommon {
  kind: "capacity";
  thresholds?: number[];
}

/** A configuration value per plan (max upload size, support tier). */
export interface ValueFeature<T extends JsonValue = JsonValue> extends FeatureCommon {
  kind: "value";
  /** Value when the customer's plans don't set one. */
  default: T;
}

/** Any feature definition. */
export type FeatureDefinition =
  | BooleanFeature
  | MeteredFeature
  | CreditsFeature
  | CapacityFeature
  // oxlint-disable-next-line typescript/no-explicit-any -- variance: any ValueFeature<T>
  | ValueFeature<any>;

/** Widen literal types (`10` → `number`) so `feature.value({ default: 10 })` is a `number` feature. */
export type Widen<T> = T extends string
  ? string
  : T extends number
    ? number
    : T extends boolean
      ? boolean
      : T extends readonly (infer U)[]
        ? Widen<U>[]
        : T extends object
          ? { -readonly [K in keyof T]: Widen<T[K]> }
          : T;

/** Feature builders. */
export const feature = {
  /** An on/off feature. */
  boolean: (options: Omit<BooleanFeature, "kind"> = {}): BooleanFeature => ({
    kind: "boolean",
    ...options,
  }),
  /** A consumption counter with a reset interval. */
  metered: (options: Omit<MeteredFeature, "kind">): MeteredFeature => ({
    kind: "metered",
    ...options,
  }),
  /** A prepaid credit pool with a reset interval. */
  credits: (options: Omit<CreditsFeature, "kind">): CreditsFeature => ({
    kind: "credits",
    ...options,
  }),
  /** A current count against a ceiling (seats). */
  capacity: (options: Omit<CapacityFeature, "kind"> = {}): CapacityFeature => ({
    kind: "capacity",
    ...options,
  }),
  /** A per-plan configuration value. */
  value: <const T extends JsonValue>(
    options: Omit<ValueFeature<T>, "kind">,
  ): ValueFeature<Widen<T>> => ({ kind: "value", ...options }) as ValueFeature<Widen<T>>,
};

/** The literal accepted for "no limit". */
export type Unlimited = "unlimited";

/** A limit with options, for metered / credits / capacity features on a plan. */
export interface LimitSpec {
  /** `"unlimited"` (or `null`) for no limit. */
  limit: number | Unlimited | null;
  /** `"allow"` lets usage continue past the limit and reports it as overage. Default `"block"`. */
  overage?: OveragePolicy;
  /** With `overage: "allow"`, the most overage permitted per period. Default unlimited. */
  overageLimit?: number;
  /** Override the feature's reset interval for this plan. */
  reset?: ResetInterval;
}

/** What a plan may say about one feature, by kind. `false` (or omission) = not included. */
export type PlanFeatureEntry<D> = D extends BooleanFeature
  ? boolean
  : D extends ValueFeature<infer T>
    ? T
    : D extends MeteredFeature | CreditsFeature
      ? number | Unlimited | LimitSpec | false
      : D extends CapacityFeature
        ? number | Unlimited | Omit<LimitSpec, "reset"> | false
        : never;

/** What an add-on may add for one feature, by kind. */
export type AddonFeatureEntry<D> = D extends BooleanFeature
  ? true
  : D extends ValueFeature<infer T>
    ? T
    : number | Unlimited | { add: number | Unlimited };

/** A plan's feature map, typed by the catalog's features. */
export type PlanFeatures<F> = { [K in keyof F]?: PlanFeatureEntry<F[K]> };
/** An add-on's feature map. */
export type AddonFeatures<F> = { [K in keyof F]?: AddonFeatureEntry<F[K]> };

/** Display price (money stays with the provider — ADR 0015). Amount in minor units. */
export interface PriceDisplay {
  amount: number;
  currency: string;
  interval?: "day" | "week" | "month" | "year" | "one_time";
  /** Free-form label, e.g. `"per seat"`. */
  label?: string;
}

/**
 * Provider item ids that map to a plan or add-on: Stripe price ids, Polar
 * product ids, Paddle price ids, Lemon Squeezy variant ids, …
 */
export type ProviderMapping = Record<string, readonly string[]>;

/** One historical version of a plan (grandfathering — ADR 0012). */
export interface PlanVersionDefinition<F> {
  features: PlanFeatures<F>;
  providers?: ProviderMapping;
  price?: PriceDisplay | readonly PriceDisplay[];
  trial?: { days: number };
}

/** A plan. */
export interface PlanDefinition<F> {
  name?: string;
  description?: string;
  /** Mutually exclusive group (one entitled plan per group). Default `"base"`. */
  group?: string;
  /** Applies when the group has no entitled subscription. At most one per group. */
  default?: boolean;
  hidden?: boolean;
  /** Emphasize in pricing tables. */
  highlight?: boolean;
  /** Current version. Default `1`. */
  version?: number;
  trial?: { days: number };
  price?: PriceDisplay | readonly PriceDisplay[];
  providers?: ProviderMapping;
  features: PlanFeatures<F>;
  /** Older versions still held by grandfathered subscriptions. */
  previous?: Record<number, PlanVersionDefinition<F>>;
  metadata?: JsonObject;
}

/** An add-on: stacks on top of base plans. */
export interface AddonDefinition<F> {
  name?: string;
  description?: string;
  /** Can be bought in quantity (numeric additions multiply). */
  quantity?: boolean | { max?: number };
  /** Only applies while one of these plans is entitled. */
  requires?: readonly string[];
  hidden?: boolean;
  price?: PriceDisplay | readonly PriceDisplay[];
  providers?: ProviderMapping;
  features: AddonFeatures<F>;
  metadata?: JsonObject;
}

/** Input to {@link defineCatalog}. */
export interface CatalogDefinition<F, P, A> {
  features: F;
  plans: P;
  addons?: A;
}

// ---------------------------------------------------------------------------
// Normalized form (what the engine, resolver and UI consume)
// ---------------------------------------------------------------------------

/** A feature with every default applied. */
export interface NormalizedFeature {
  key: string;
  kind: FeatureKind;
  name: string;
  description?: string;
  unit?: string;
  units?: string;
  reset?: ResetInterval;
  creditCost?: Record<string, number>;
  metering: MeteringMode;
  thresholds: number[];
  default?: JsonValue;
  hidden: boolean;
  metadata?: JsonObject;
}

/** A normalized numeric entitlement on a plan. */
export interface NormalizedLimit {
  kind: "metered" | "credits" | "capacity";
  included: boolean;
  /** `null` = unlimited. */
  limit: number | null;
  overage: OveragePolicy;
  /** `null` = unlimited overage (when `overage: "allow"`). */
  overageLimit: number | null;
  reset?: ResetInterval;
}

/** A normalized plan entry for one feature. */
export type NormalizedEntry =
  | { kind: "boolean"; enabled: boolean }
  | NormalizedLimit
  | { kind: "value"; value: JsonValue };

/** A normalized add-on entry for one feature. */
export type NormalizedAddonEntry =
  | { kind: "boolean"; enabled: true }
  | { kind: "metered" | "credits" | "capacity"; add: number | null }
  | { kind: "value"; value: JsonValue };

/** One concrete version of a plan. */
export interface NormalizedPlan {
  key: string;
  version: number;
  /** True for the plan's current version. */
  current: boolean;
  name: string;
  description?: string;
  group: string;
  default: boolean;
  hidden: boolean;
  highlight: boolean;
  trialDays?: number;
  price: PriceDisplay[];
  providers: ProviderMapping;
  features: Record<string, NormalizedEntry>;
  order: number;
  metadata?: JsonObject;
}

/** A normalized add-on. */
export interface NormalizedAddon {
  key: string;
  name: string;
  description?: string;
  quantity: boolean;
  maxQuantity?: number;
  requires: string[];
  hidden: boolean;
  price: PriceDisplay[];
  providers: ProviderMapping;
  features: Record<string, NormalizedAddonEntry>;
  order: number;
  metadata?: JsonObject;
}

/** Where a provider item id points. */
export interface ProviderItemTarget {
  type: "plan" | "addon";
  key: string;
  /** Plan version (plans only). */
  version?: number;
}

/** The normalized catalog. */
export interface NormalizedCatalog {
  features: Map<string, NormalizedFeature>;
  featureOrder: string[];
  /** Current version of each plan. */
  plans: Map<string, NormalizedPlan>;
  /** Every version, keyed `"<plan>@<version>"`. */
  planVersions: Map<string, NormalizedPlan>;
  planOrder: string[];
  addons: Map<string, NormalizedAddon>;
  addonOrder: string[];
  /** Default plan per group. */
  defaults: Map<string, string>;
  /** `"<provider>:<itemId>"` → target. */
  providerIndex: Map<string, ProviderItemTarget>;
}

/** A defined catalog. The type parameters carry your keys and value types. */
export interface Catalog<
  F extends Record<string, FeatureDefinition> = Record<string, FeatureDefinition>,
  P = Record<string, unknown>,
  A = Record<string, unknown>,
> {
  readonly features: F;
  readonly plans: P;
  readonly addons: A;
  readonly featureKeys: readonly (keyof F & string)[];
  readonly planKeys: readonly (keyof P & string)[];
  readonly addonKeys: readonly (keyof A & string)[];
  /** The normalized form (used by the engine, resolver and UI). */
  readonly normalized: NormalizedCatalog;
}

/** Any catalog (what the engine, resolver and UI accept). */
export interface AnyCatalog {
  readonly features: Record<string, FeatureDefinition>;
  readonly plans: unknown;
  readonly addons: unknown;
  readonly featureKeys: readonly string[];
  readonly planKeys: readonly string[];
  readonly addonKeys: readonly string[];
  readonly normalized: NormalizedCatalog;
}

/** The feature keys of a catalog. */
export type FeatureKey<C> = C extends { readonly features: infer F } ? keyof F & string : string;
/** The plan keys of a catalog. */
export type PlanKey<C> = C extends { readonly plans: infer P } ? keyof P & string : string;
/** The add-on keys of a catalog. */
export type AddonKey<C> = C extends { readonly addons: infer A } ? keyof A & string : string;
/** The feature definition for a key. */
export type FeatureOf<C, K extends string> = C extends { readonly features: infer F }
  ? K extends keyof F
    ? F[K]
    : never
  : never;
/** The `value` type for a value feature (`JsonValue | undefined` for other kinds). */
export type FeatureValue<C, K extends string> =
  FeatureOf<C, K> extends ValueFeature<infer T> ? T : JsonValue | undefined;
/** Feature keys of a given kind. */
export type FeatureKeyOfKind<C, Kind extends FeatureKind> = C extends {
  readonly features: infer F;
}
  ? {
      [K in keyof F & string]: F[K] extends { kind: infer FK }
        ? FK extends Kind
          ? K
          : never
        : never;
    }[keyof F & string]
  : string;

/** Thrown by {@link defineCatalog} with every problem found. */
export class CatalogError extends Error {
  readonly problems: string[];
  constructor(problems: string[]) {
    super(`Invalid catalog:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
    this.name = "CatalogError";
    this.problems = problems;
  }
}

const RESETS: ReadonlySet<string> = new Set([
  "day",
  "week",
  "month",
  "quarter",
  "year",
  "billing_period",
  "never",
]);
const KINDS: ReadonlySet<string> = new Set(["boolean", "metered", "capacity", "value", "credits"]);
const DEFAULT_THRESHOLDS = [0.8, 1];

const toArray = <T>(value: T | readonly T[] | undefined): T[] =>
  value === undefined ? [] : Array.isArray(value) ? [...(value as readonly T[])] : [value as T];

const isJson = (value: unknown): boolean => {
  if (value === null) return true;
  switch (typeof value) {
    case "string":
    case "boolean":
      return true;
    case "number":
      return Number.isFinite(value);
    case "object":
      return Array.isArray(value)
        ? value.every(isJson)
        : Object.getPrototypeOf(value) === Object.prototype && Object.values(value).every(isJson);
    default:
      return false;
  }
};

function normalizeFeature(key: string, def: FeatureDefinition, problems: string[]) {
  if (!KINDS.has(def?.kind)) {
    problems.push(`feature "${key}": unknown kind "${String(def?.kind)}"`);
  }
  const out: NormalizedFeature = {
    key,
    kind: def.kind,
    name: def.name ?? key,
    metering: "strict",
    thresholds: DEFAULT_THRESHOLDS,
    hidden: def.hidden ?? false,
  };
  if (def.description !== undefined) out.description = def.description;
  if (def.unit !== undefined) {
    out.unit = def.unit;
    out.units = def.units ?? `${def.unit}s`;
  } else if (def.units !== undefined) out.units = def.units;
  if (def.metadata !== undefined) out.metadata = def.metadata;
  if (def.kind === "metered" || def.kind === "credits") {
    if (!RESETS.has(def.reset)) {
      problems.push(`feature "${key}": reset must be one of ${[...RESETS].join(", ")}`);
    }
    out.reset = def.reset;
    out.metering = def.metering ?? "strict";
  }
  if (def.kind === "metered" && def.creditCost) out.creditCost = { ...def.creditCost };
  if (def.kind !== "boolean" && def.kind !== "value" && def.thresholds) {
    for (const t of def.thresholds) {
      if (!(t > 0 && t <= 10)) problems.push(`feature "${key}": threshold ${t} must be in (0, 10]`);
    }
    out.thresholds = [...def.thresholds].sort((a, b) => a - b);
  }
  if (def.kind === "value") {
    if (!isJson(def.default)) problems.push(`feature "${key}": default must be JSON`);
    out.default = def.default as JsonValue;
  }
  return out;
}

function normalizeLimit(
  where: string,
  feature: NormalizedFeature,
  entry: unknown,
  problems: string[],
): NormalizedLimit {
  const kind = feature.kind as NormalizedLimit["kind"];
  const base: NormalizedLimit = {
    kind,
    included: true,
    limit: 0,
    overage: "block",
    overageLimit: null,
  };
  if (feature.reset !== undefined) base.reset = feature.reset;
  if (entry === false) return { ...base, included: false };
  if (entry === "unlimited" || entry === null) return { ...base, limit: null };
  if (typeof entry === "number") {
    if (!(entry >= 0) || !Number.isFinite(entry)) {
      problems.push(`${where}: limit must be a finite number >= 0`);
    }
    return { ...base, limit: entry };
  }
  if (typeof entry === "object" && entry !== null && "limit" in entry) {
    const spec = entry as LimitSpec;
    const limit = spec.limit === "unlimited" || spec.limit === null ? null : spec.limit;
    if (limit !== null && (!(limit >= 0) || !Number.isFinite(limit))) {
      problems.push(`${where}: limit must be a finite number >= 0`);
    }
    if (spec.overage !== undefined && spec.overage !== "block" && spec.overage !== "allow") {
      problems.push(`${where}: overage must be "block" or "allow"`);
    }
    if (spec.reset !== undefined) {
      if (kind === "capacity") problems.push(`${where}: capacity features don't reset`);
      else if (!RESETS.has(spec.reset)) problems.push(`${where}: unknown reset "${spec.reset}"`);
    }
    if (spec.overageLimit !== undefined && !(spec.overageLimit >= 0)) {
      problems.push(`${where}: overageLimit must be >= 0`);
    }
    return {
      ...base,
      limit,
      overage: spec.overage ?? "block",
      overageLimit: spec.overageLimit ?? null,
      ...(spec.reset !== undefined && kind !== "capacity" ? { reset: spec.reset } : {}),
    };
  }
  problems.push(`${where}: expected a number, "unlimited", false or { limit }`);
  return base;
}

function normalizePlanFeatures(
  where: string,
  entries: Record<string, unknown>,
  features: Map<string, NormalizedFeature>,
  problems: string[],
): Record<string, NormalizedEntry> {
  const out: Record<string, NormalizedEntry> = {};
  for (const [key, entry] of Object.entries(entries ?? {})) {
    const feature = features.get(key);
    if (!feature) {
      problems.push(`${where}: unknown feature "${key}"`);
      continue;
    }
    if (entry === undefined) continue;
    const at = `${where} feature "${key}"`;
    if (feature.kind === "boolean") {
      if (typeof entry !== "boolean") problems.push(`${at}: expected true or false`);
      out[key] = { kind: "boolean", enabled: entry === true };
    } else if (feature.kind === "value") {
      if (!isJson(entry)) problems.push(`${at}: value must be JSON`);
      out[key] = { kind: "value", value: entry as JsonValue };
    } else {
      out[key] = normalizeLimit(at, feature, entry, problems);
    }
  }
  return out;
}

function normalizeAddonFeatures(
  where: string,
  entries: Record<string, unknown>,
  features: Map<string, NormalizedFeature>,
  problems: string[],
): Record<string, NormalizedAddonEntry> {
  const out: Record<string, NormalizedAddonEntry> = {};
  for (const [key, entry] of Object.entries(entries ?? {})) {
    const feature = features.get(key);
    if (!feature) {
      problems.push(`${where}: unknown feature "${key}"`);
      continue;
    }
    if (entry === undefined) continue;
    const at = `${where} feature "${key}"`;
    if (feature.kind === "boolean") {
      if (entry !== true) problems.push(`${at}: add-ons can only enable boolean features (true)`);
      out[key] = { kind: "boolean", enabled: true };
    } else if (feature.kind === "value") {
      if (!isJson(entry)) problems.push(`${at}: value must be JSON`);
      out[key] = { kind: "value", value: entry as JsonValue };
    } else {
      const raw =
        typeof entry === "object" && entry !== null && "add" in entry
          ? (entry as { add: unknown }).add
          : entry;
      if (raw === "unlimited" || raw === null) out[key] = { kind: feature.kind, add: null };
      else if (typeof raw === "number" && raw >= 0 && Number.isFinite(raw)) {
        out[key] = { kind: feature.kind, add: raw };
      } else {
        problems.push(`${at}: expected a number >= 0, "unlimited" or { add }`);
        out[key] = { kind: feature.kind, add: 0 };
      }
    }
  }
  return out;
}

function indexProviders(
  where: string,
  providers: ProviderMapping | undefined,
  target: ProviderItemTarget,
  index: Map<string, ProviderItemTarget>,
  problems: string[],
): ProviderMapping {
  const out: Record<string, string[]> = {};
  for (const [provider, ids] of Object.entries(providers ?? {})) {
    if (!Array.isArray(ids)) {
      problems.push(`${where}: providers.${provider} must be an array of ids`);
      continue;
    }
    out[provider] = [...ids];
    for (const id of ids) {
      const k = `${provider}:${id}`;
      const existing = index.get(k);
      if (existing) {
        const name = (t: ProviderItemTarget) =>
          `${t.type} "${t.key}"${t.version !== undefined ? ` v${t.version}` : ""}`;
        problems.push(`${where}: ${provider} id "${id}" is already mapped to ${name(existing)}`);
      } else index.set(k, target);
    }
  }
  return out;
}

/**
 * Define and validate a catalog. Throws {@link CatalogError} listing every
 * problem (unknown features, invalid limits, duplicate defaults or provider
 * ids, broken credit references, …).
 */
export function defineCatalog<
  const F extends Record<string, FeatureDefinition>,
  const P extends Record<string, PlanDefinition<F>>,
  const A extends Record<string, AddonDefinition<F>> = Record<never, AddonDefinition<F>>,
>(definition: CatalogDefinition<F, P, A>): Catalog<F, P, A> {
  const problems: string[] = [];
  const features = new Map<string, NormalizedFeature>();
  for (const [key, def] of Object.entries(definition.features ?? {})) {
    if (!/^[A-Za-z0-9_.:-]+$/.test(key)) {
      problems.push(`feature "${key}": keys may contain letters, digits, _ . : - only`);
    }
    features.set(key, normalizeFeature(key, def, problems));
  }
  for (const f of features.values()) {
    for (const [pool, rate] of Object.entries(f.creditCost ?? {})) {
      const target = features.get(pool);
      if (!target) problems.push(`feature "${f.key}": creditCost references unknown "${pool}"`);
      else if (target.kind !== "credits") {
        problems.push(`feature "${f.key}": creditCost target "${pool}" is not a credits feature`);
      }
      if (!(rate > 0) || !Number.isFinite(rate)) {
        problems.push(`feature "${f.key}": creditCost rate for "${pool}" must be > 0`);
      }
    }
  }

  const providerIndex = new Map<string, ProviderItemTarget>();
  const plans = new Map<string, NormalizedPlan>();
  const planVersions = new Map<string, NormalizedPlan>();
  const defaults = new Map<string, string>();
  const planOrder: string[] = [];
  let order = 0;
  for (const [key, def] of Object.entries(definition.plans ?? {}) as [
    string,
    PlanDefinition<F>,
  ][]) {
    planOrder.push(key);
    const group = def.group ?? "base";
    const version = def.version ?? 1;
    if (!Number.isInteger(version) || version < 1) {
      problems.push(`plan "${key}": version must be an integer >= 1`);
    }
    if (def.trial && !(def.trial.days > 0)) problems.push(`plan "${key}": trial.days must be > 0`);
    if (def.default) {
      const prev = defaults.get(group);
      if (prev) problems.push(`plan "${key}": group "${group}" already has default plan "${prev}"`);
      else defaults.set(group, key);
    }
    const make = (
      v: number,
      current: boolean,
      src: PlanVersionDefinition<F>,
      where: string,
    ): NormalizedPlan => {
      const plan: NormalizedPlan = {
        key,
        version: v,
        current,
        name: def.name ?? key,
        group,
        default: def.default ?? false,
        hidden: def.hidden ?? false,
        highlight: def.highlight ?? false,
        price: toArray(src.price),
        providers: indexProviders(
          where,
          src.providers,
          { type: "plan", key, version: v },
          providerIndex,
          problems,
        ),
        features: normalizePlanFeatures(
          where,
          src.features as Record<string, unknown>,
          features,
          problems,
        ),
        order,
      };
      if (def.description !== undefined) plan.description = def.description;
      const trial = src.trial ?? (current ? def.trial : undefined);
      if (trial) plan.trialDays = trial.days;
      if (def.metadata !== undefined) plan.metadata = def.metadata;
      return plan;
    };
    const current = make(version, true, def, `plan "${key}"`);
    plans.set(key, current);
    planVersions.set(`${key}@${version}`, current);
    for (const [vRaw, prev] of Object.entries(def.previous ?? {})) {
      const v = Number(vRaw);
      if (!Number.isInteger(v) || v < 1 || v >= version) {
        problems.push(
          `plan "${key}": previous version ${vRaw} must be an integer in [1, ${version})`,
        );
        continue;
      }
      planVersions.set(`${key}@${v}`, make(v, false, prev, `plan "${key}" v${v}`));
    }
    order++;
  }
  if (plans.size === 0) problems.push("catalog: define at least one plan");

  const addons = new Map<string, NormalizedAddon>();
  const addonOrder: string[] = [];
  for (const [key, def] of Object.entries(definition.addons ?? {}) as [
    string,
    AddonDefinition<F>,
  ][]) {
    if (plans.has(key)) problems.push(`addon "${key}": a plan has the same key`);
    addonOrder.push(key);
    const quantity = def.quantity === true || typeof def.quantity === "object";
    const addon: NormalizedAddon = {
      key,
      name: def.name ?? key,
      quantity,
      requires: [...(def.requires ?? [])],
      hidden: def.hidden ?? false,
      price: toArray(def.price),
      providers: indexProviders(
        `addon "${key}"`,
        def.providers,
        { type: "addon", key },
        providerIndex,
        problems,
      ),
      features: normalizeAddonFeatures(
        `addon "${key}"`,
        def.features as Record<string, unknown>,
        features,
        problems,
      ),
      order: order++,
    };
    if (typeof def.quantity === "object" && def.quantity.max !== undefined) {
      addon.maxQuantity = def.quantity.max;
    }
    if (def.description !== undefined) addon.description = def.description;
    if (def.metadata !== undefined) addon.metadata = def.metadata;
    for (const req of addon.requires) {
      if (!plans.has(req)) problems.push(`addon "${key}": requires unknown plan "${req}"`);
    }
    addons.set(key, addon);
  }

  if (problems.length > 0) throw new CatalogError(problems);

  return {
    features: definition.features,
    plans: definition.plans,
    addons: (definition.addons ?? {}) as A,
    featureKeys: [...features.keys()] as (keyof F & string)[],
    planKeys: planOrder as (keyof P & string)[],
    addonKeys: addonOrder as (keyof A & string)[],
    normalized: {
      features,
      featureOrder: [...features.keys()],
      plans,
      planVersions,
      planOrder,
      addons,
      addonOrder,
      defaults,
      providerIndex,
    },
  };
}

/** Identity helper for declaring a plan outside `defineCatalog` (types are checked there). */
export const plan = <const T>(definition: T): T => definition;
/** Identity helper for declaring an add-on outside `defineCatalog`. */
export const addon = <const T>(definition: T): T => definition;

/** A plan version by key and version, falling back to the current version. */
export function getPlanVersion(
  catalog: AnyCatalog,
  key: string,
  version?: number,
): NormalizedPlan | undefined {
  const n = catalog.normalized;
  if (version !== undefined) {
    const exact = n.planVersions.get(`${key}@${version}`);
    if (exact) return exact;
  }
  return n.plans.get(key);
}

// ---------------------------------------------------------------------------
// Pricing table
// ---------------------------------------------------------------------------

/** One cell of a pricing table. */
export interface PricingCell {
  included: boolean;
  /** Numeric features: `null` = unlimited. */
  limit?: number | null;
  value?: JsonValue;
  reset?: ResetInterval;
  overage?: OveragePolicy;
  /** Human label, e.g. `"1,000 calls / month"`, `"Unlimited"`, `"✓"`, `"—"`. */
  label: string;
}

/** A plan column in a pricing table. */
export interface PricingPlan {
  key: string;
  name: string;
  description?: string;
  group: string;
  default: boolean;
  highlight: boolean;
  version: number;
  price: PriceDisplay[];
  trialDays?: number;
  features: Record<string, PricingCell>;
  metadata?: JsonObject;
}

/** An add-on row in a pricing table. */
export interface PricingAddon {
  key: string;
  name: string;
  description?: string;
  price: PriceDisplay[];
  quantity: boolean;
  requires: string[];
  features: Record<string, PricingCell>;
}

/** JSON-safe, display-ready catalog for pricing pages (`GET /api/pricing`, `<PricingTable>`). */
export interface PricingTable {
  features: Array<{
    key: string;
    name: string;
    kind: FeatureKind;
    description?: string;
    unit?: string;
    units?: string;
  }>;
  plans: PricingPlan[];
  addons: PricingAddon[];
}

const RESET_LABEL: Record<ResetInterval, string> = {
  day: " / day",
  week: " / week",
  month: " / month",
  quarter: " / quarter",
  year: " / year",
  billing_period: " / billing period",
  never: "",
};

const fmt = (n: number): string => n.toLocaleString("en-US");

const formatValue = (value: JsonValue): string =>
  typeof value === "string"
    ? value
    : typeof value === "number"
      ? fmt(value)
      : typeof value === "boolean"
        ? value
          ? "✓"
          : "—"
        : JSON.stringify(value);

/** Format a numeric amount with the feature's unit, e.g. `"1,000 calls"`. */
export function formatQuantity(feature: NormalizedFeature, amount: number): string {
  const unit = amount === 1 ? feature.unit : (feature.units ?? feature.unit);
  return unit ? `${fmt(amount)} ${unit}` : fmt(amount);
}

function planCell(feature: NormalizedFeature, entry: NormalizedEntry | undefined): PricingCell {
  if (feature.kind === "boolean") {
    const included = entry?.kind === "boolean" && entry.enabled;
    return { included, label: included ? "✓" : "—" };
  }
  if (feature.kind === "value") {
    const value = entry?.kind === "value" ? entry.value : (feature.default as JsonValue);
    return { included: true, value, label: formatValue(value) };
  }
  if (!entry || entry.kind === "boolean" || entry.kind === "value" || !entry.included) {
    return { included: false, label: "—" };
  }
  const reset = entry.reset ?? feature.reset;
  const suffix = reset ? RESET_LABEL[reset] : "";
  const cell: PricingCell = {
    included: true,
    limit: entry.limit,
    overage: entry.overage,
    label: entry.limit === null ? "Unlimited" : `${formatQuantity(feature, entry.limit)}${suffix}`,
  };
  if (reset) cell.reset = reset;
  return cell;
}

function addonCell(feature: NormalizedFeature, entry: NormalizedAddonEntry): PricingCell {
  if (entry.kind === "boolean") return { included: true, label: "✓" };
  if (entry.kind === "value") {
    return { included: true, value: entry.value, label: formatValue(entry.value) };
  }
  return {
    included: true,
    limit: entry.add,
    label: entry.add === null ? "Unlimited" : `+${formatQuantity(feature, entry.add)}`,
  };
}

/**
 * Build a JSON-safe pricing table from the catalog (current plan versions, in
 * declaration order). Hidden plans, add-ons and features are left out unless
 * `includeHidden` is set.
 */
export function pricingTable(
  catalog: AnyCatalog,
  options: { includeHidden?: boolean; group?: string } = {},
): PricingTable {
  const n = catalog.normalized;
  const show = (x: { hidden: boolean }) => options.includeHidden || !x.hidden;
  const features = n.featureOrder.map((k) => n.features.get(k)!).filter(show);
  return {
    features: features.map((f) => {
      const out: PricingTable["features"][number] = { key: f.key, name: f.name, kind: f.kind };
      if (f.description !== undefined) out.description = f.description;
      if (f.unit !== undefined) out.unit = f.unit;
      if (f.units !== undefined) out.units = f.units;
      return out;
    }),
    plans: n.planOrder
      .map((k) => n.plans.get(k)!)
      .filter(show)
      .filter((p) => options.group === undefined || p.group === options.group)
      .map((p) => {
        const out: PricingPlan = {
          key: p.key,
          name: p.name,
          group: p.group,
          default: p.default,
          highlight: p.highlight,
          version: p.version,
          price: p.price,
          features: Object.fromEntries(
            features.map((f) => [f.key, planCell(f, p.features[f.key])]),
          ),
        };
        if (p.description !== undefined) out.description = p.description;
        if (p.trialDays !== undefined) out.trialDays = p.trialDays;
        if (p.metadata !== undefined) out.metadata = p.metadata;
        return out;
      }),
    addons: n.addonOrder
      .map((k) => n.addons.get(k)!)
      .filter(show)
      .map((a) => {
        const out: PricingAddon = {
          key: a.key,
          name: a.name,
          price: a.price,
          quantity: a.quantity,
          requires: a.requires,
          features: Object.fromEntries(
            Object.entries(a.features)
              .filter(([k]) => show(n.features.get(k)!))
              .map(([k, e]) => [k, addonCell(n.features.get(k)!, e)]),
          ),
        };
        if (a.description !== undefined) out.description = a.description;
        return out;
      }),
  };
}

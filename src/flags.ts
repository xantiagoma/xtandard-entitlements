/**
 * The flags bridge (ADR 0008): one gate for "is the rollout on?" and "does
 * their plan include it?".
 *
 * - {@link entitlementsContext} — flat evaluation-context attributes for a
 *   customer (`plan`, `plans`, `addons`, `subscription.status`,
 *   `entitlement.<feature>` (allowed), `entitlement.<feature>.remaining |
 *   .limit | .used | .value`) to merge into any flags evaluation, so rules
 *   can target `entitlement.export_pdf == true` or `plan in ["pro"]`.
 * - {@link createEntitlementsHook} — an OpenFeature `Hook` whose `before`
 *   returns that context, so every evaluation through **any** provider
 *   (including `@xtandard/flags/openfeature`) sees entitlement attributes.
 * - {@link createEntitlementsProvider} — an OpenFeature `Provider` where the
 *   flag key is a feature key and the targeting key is the customer.
 *
 * Reads are memory-first (ADR 0003): the resolved set comes from the engine's
 * snapshot (`ent.resolve`); usage attributes cost one batched counter read
 * (`ent.entitlements`) and can be turned off with `usage: false`.
 *
 * **Zero runtime dependency** on `@openfeature/server-sdk` or
 * `@xtandard/flags`: SDK types are imported with `import type` and the
 * reason / error-code strings are replicated as literals (the flags pattern).
 *
 * @module flags
 */

import type {
  BeforeHookContext as OFBeforeHookContext,
  ErrorCode as OFErrorCode,
  EvaluationContext as OFEvaluationContext,
  FlagMetadata as OFFlagMetadata,
  Hook as OFHook,
  JsonValue as OFJsonValue,
  Provider as OFProvider,
  ProviderMetadata as OFProviderMetadata,
  ResolutionDetails as OFResolutionDetails,
} from "@openfeature/server-sdk";
import type { AnyCatalog, JsonValue } from "./catalog.ts";
import type { Entitlements } from "./engine.ts";
import type { ActivePlan, CheckResult } from "./schema.ts";

/** OpenFeature standard resolution reasons, replicated as literals (no runtime import). */
const OF_REASON = {
  TARGETING_MATCH: "TARGETING_MATCH",
  DEFAULT: "DEFAULT",
  STALE: "STALE",
  ERROR: "ERROR",
} as const;

/**
 * OpenFeature `ErrorCode` values, replicated as literals and cast to the
 * enum's type (erased at compile time — the enum is never imported at runtime).
 */
const OF_ERROR = {
  FLAG_NOT_FOUND: "FLAG_NOT_FOUND",
  TYPE_MISMATCH: "TYPE_MISMATCH",
  TARGETING_KEY_MISSING: "TARGETING_KEY_MISSING",
  GENERAL: "GENERAL",
} as const satisfies Record<string, string> as Record<
  "FLAG_NOT_FOUND" | "TYPE_MISMATCH" | "TARGETING_KEY_MISSING" | "GENERAL",
  OFErrorCode
>;

/** Flat evaluation-context attributes produced by {@link entitlementsContext}. */
export type EntitlementsContextAttributes = Record<string, JsonValue>;

/** Options for {@link entitlementsContext}. */
export interface EntitlementsContextOptions {
  /** Prefix of per-feature attributes. Default `"entitlement."`. */
  prefix?: string;
  /** Include `.remaining`, `.used` and usage-aware `allowed` (one counter read). Default `true`. */
  usage?: boolean;
  /** Only these features (default: every feature in the catalog). */
  features?: readonly string[];
}

/** Builds the attributes for one customer. */
export type EntitlementsContextFn = (customer: string) => Promise<EntitlementsContextAttributes>;

const mainPlan = (plans: ActivePlan[]): ActivePlan | undefined =>
  plans.find((p) => p.group === "base") ?? plans[0];

/**
 * Build flat entitlement attributes for a customer, ready to merge into a
 * flags evaluation context.
 *
 * | attribute                         | value                                                |
 * | --------------------------------- | ---------------------------------------------------- |
 * | `plan`                            | the base-group plan key (`"free"`, `"pro"`, …)       |
 * | `plans` / `addons`                | every active plan / applied add-on key               |
 * | `subscription.status`             | status of `plan` (`"default"` when it's the default) |
 * | `entitlement.<f>`                 | allowed (boolean; numeric: something left)           |
 * | `entitlement.<f>.limit`           | numeric limit (`null` = unlimited)                   |
 * | `entitlement.<f>.remaining/.used` | current usage (`usage: true`)                        |
 * | `entitlement.<f>.value`           | value features                                       |
 *
 * @example
 * ```ts
 * const context = entitlementsContext(ent);
 * const attrs = await context("org_42");
 * // { plan: "pro", "entitlement.export_pdf": true, "entitlement.api_calls.remaining": 99_000, … }
 * ```
 */
export function entitlementsContext<C extends AnyCatalog>(
  engine: Entitlements<C>,
  options: EntitlementsContextOptions = {},
): EntitlementsContextFn {
  const prefix = options.prefix ?? "entitlement.";
  const usage = options.usage ?? true;
  const only = options.features ? new Set(options.features) : undefined;
  return async (customer) => {
    const set = usage ? await engine.entitlements(customer) : await engine.resolve(customer);
    const out: EntitlementsContextAttributes = {};
    const main = mainPlan(set.plans);
    if (main) {
      out.plan = main.plan;
      out["subscription.status"] = main.default ? "default" : (main.status ?? "active");
    }
    out.plans = set.plans.map((p) => p.plan);
    out.addons = set.addons.filter((a) => a.applied).map((a) => a.addon);
    for (const [key, f] of Object.entries(set.features)) {
      if (only && !only.has(key)) continue;
      const k = `${prefix}${key}`;
      if (f.kind === "boolean") {
        out[k] = f.enabled;
      } else if (f.kind === "value") {
        out[k] = f.enabled;
        out[`${k}.value`] = f.value ?? null;
      } else {
        out[`${k}.limit`] = f.limit ?? null;
        const u = f as typeof f & { used?: number; remaining?: number | null };
        if (usage && u.used !== undefined) {
          out[`${k}.used`] = u.used;
          out[`${k}.remaining`] = u.remaining ?? null;
          const room = u.remaining === null || u.remaining === undefined || u.remaining > 0;
          out[k] = f.enabled && (room || f.overagePolicy === "allow");
        } else {
          out[k] = f.enabled;
        }
      }
    }
    if (set.stale) out["entitlements.stale"] = true;
    return out;
  };
}

/** Options for {@link createEntitlementsHook}. */
export interface EntitlementsHookOptions extends EntitlementsContextOptions {
  /**
   * Where the customer id comes from: a context attribute name, or a
   * function. Default: the OpenFeature `targetingKey`.
   */
  customerKey?: string | ((context: OFEvaluationContext) => string | undefined);
  /** Problems loading entitlements (the evaluation proceeds without them). Default `console.warn`. */
  onError?: (error: unknown, customer: string) => void;
}

/**
 * An OpenFeature hook that enriches every evaluation context with the
 * customer's entitlement attributes (attributes already in the context win).
 *
 * @example
 * ```ts
 * import { OpenFeature } from "@openfeature/server-sdk";
 * import { createEntitlementsHook } from "@xtandard/entitlements/flags";
 *
 * OpenFeature.addHooks(createEntitlementsHook(ent, { customerKey: "orgId" }));
 * // a flags rule can now target `entitlement.export_pdf == true` or `plan in ["pro"]`
 * ```
 */
export function createEntitlementsHook<C extends AnyCatalog>(
  engine: Entitlements<C>,
  options: EntitlementsHookOptions = {},
): OFHook {
  const context = entitlementsContext(engine, options);
  const key = options.customerKey;
  const customerOf =
    typeof key === "function"
      ? key
      : (ctx: OFEvaluationContext) => {
          const v = key ? ctx[key] : ctx.targetingKey;
          return typeof v === "string" && v.length > 0 ? v : undefined;
        };
  const onError =
    options.onError ??
    ((error: unknown, customer: string) =>
      console.warn(
        `[@xtandard/entitlements] could not load entitlements for "${customer}"; evaluating without them:`,
        error,
      ));
  return {
    async before(hookContext: OFBeforeHookContext): Promise<OFEvaluationContext | void> {
      const ctx = hookContext.context;
      const customer = customerOf(ctx);
      if (!customer) return;
      try {
        const attrs = await context(customer);
        const merged: OFEvaluationContext = {};
        for (const [k, v] of Object.entries(attrs)) {
          if (!(k in ctx)) merged[k] = v as OFEvaluationContext[string];
        }
        return merged;
      } catch (error) {
        onError(error, customer);
        return;
      }
    },
  };
}

/** Options for {@link createEntitlementsProvider}. */
export interface EntitlementsProviderOptions {
  /** Provider name in OpenFeature metadata. Default `"xtandard-entitlements"`. */
  name?: string;
}

/** The provider returned by {@link createEntitlementsProvider} (structurally an OpenFeature `Provider`). */
export interface EntitlementsOpenFeatureProvider extends OFProvider {
  readonly metadata: OFProviderMetadata;
  resolveBooleanEvaluation(
    flagKey: string,
    defaultValue: boolean,
    context: OFEvaluationContext,
  ): Promise<OFResolutionDetails<boolean>>;
  resolveStringEvaluation(
    flagKey: string,
    defaultValue: string,
    context: OFEvaluationContext,
  ): Promise<OFResolutionDetails<string>>;
  resolveNumberEvaluation(
    flagKey: string,
    defaultValue: number,
    context: OFEvaluationContext,
  ): Promise<OFResolutionDetails<number>>;
  resolveObjectEvaluation<T extends OFJsonValue>(
    flagKey: string,
    defaultValue: T,
    context: OFEvaluationContext,
  ): Promise<OFResolutionDetails<T>>;
}

/** Map a decision to an OpenFeature reason: `STALE` when served stale, `DEFAULT` for fallbacks. */
export function toOpenFeatureReason(result: CheckResult): string {
  if (result.reason === "unknown_feature") return OF_REASON.ERROR;
  if (result.stale) return OF_REASON.STALE;
  if (result.reason === "fallback") return OF_REASON.DEFAULT;
  return OF_REASON.TARGETING_MATCH;
}

function metadataOf(result: CheckResult): OFFlagMetadata {
  const m: Record<string, string | number | boolean> = {
    allowed: result.allowed,
    reason: result.reason,
    kind: result.kind,
  };
  if (result.denial) m.denial = result.denial;
  if (typeof result.limit === "number") m.limit = result.limit;
  if (typeof result.used === "number") m.used = result.used;
  if (typeof result.remaining === "number") m.remaining = result.remaining;
  if (result.resetsAt) m.resetsAt = result.resetsAt;
  if (result.unlockedBy.length) m.unlockedBy = result.unlockedBy.join(",");
  if (result.stale) m.stale = true;
  return m;
}

type Kind = "boolean" | "string" | "number" | "object";

/**
 * An OpenFeature provider backed by entitlements: flag key = feature key,
 * targeting key = customer.
 *
 * - **boolean** → `allowed`
 * - **number** → `remaining` for metered / credits / capacity features
 *   (`Infinity` when unlimited), or a numeric value feature's value
 * - **string** → a string value feature's value
 * - **object** → a value feature's value (any JSON), or the whole decision
 *   (`{ allowed, reason, remaining, … }`) for other kinds
 *
 * `variant` is the decision reason (`"within_limit"`, `"not_in_plan"`, …);
 * `flagMetadata` carries `allowed`, `reason`, `denial`, `limit`, `used`,
 * `remaining`, `resetsAt`, `unlockedBy`. Unknown features resolve the default
 * with `ERROR` + `FLAG_NOT_FOUND`; a missing targeting key with
 * `TARGETING_KEY_MISSING`.
 *
 * @example
 * ```ts
 * await OpenFeature.setProviderAndWait("entitlements", createEntitlementsProvider(ent));
 * const client = OpenFeature.getClient("entitlements");
 * await client.getBooleanValue("export_pdf", false, { targetingKey: "org_42" });
 * ```
 */
export function createEntitlementsProvider<C extends AnyCatalog>(
  engine: Entitlements<C>,
  options: EntitlementsProviderOptions = {},
): EntitlementsOpenFeatureProvider {
  const features = engine.catalog.normalized.features;

  async function resolve<T>(
    kind: Kind,
    flagKey: string,
    defaultValue: T,
    context: OFEvaluationContext,
  ): Promise<OFResolutionDetails<T>> {
    const fail = (
      errorCode: OFErrorCode,
      errorMessage: string,
      reason: string = OF_REASON.ERROR,
    ): OFResolutionDetails<T> => ({ value: defaultValue, reason, errorCode, errorMessage });
    const customer = context?.targetingKey;
    if (!customer) {
      return fail(OF_ERROR.TARGETING_KEY_MISSING, "targetingKey (the customer id) is required");
    }
    const feature = features.get(flagKey);
    if (!feature) return fail(OF_ERROR.FLAG_NOT_FOUND, `feature "${flagKey}" not found`);
    let result: CheckResult;
    try {
      result = (await engine.check(customer, flagKey as never)) as CheckResult;
    } catch (error) {
      return fail(OF_ERROR.GENERAL, error instanceof Error ? error.message : String(error));
    }
    const value = pick(kind, feature.kind, result);
    if (value === undefined) {
      return fail(
        OF_ERROR.TYPE_MISMATCH,
        `feature "${flagKey}" (${feature.kind}${feature.kind === "value" ? ` = ${typeof result.value}` : ""}) cannot resolve as ${kind}`,
      );
    }
    return {
      value: value as T,
      reason: toOpenFeatureReason(result),
      variant: result.reason,
      flagMetadata: metadataOf(result),
    };
  }

  return {
    metadata: { name: options.name ?? "xtandard-entitlements" } as OFProviderMetadata,
    runsOn: "server",
    resolveBooleanEvaluation: (key, def, ctx) => resolve("boolean", key, def, ctx),
    resolveStringEvaluation: (key, def, ctx) => resolve("string", key, def, ctx),
    resolveNumberEvaluation: (key, def, ctx) => resolve("number", key, def, ctx),
    resolveObjectEvaluation: <T extends OFJsonValue>(
      key: string,
      def: T,
      ctx: OFEvaluationContext,
    ) => resolve<T>("object", key, def, ctx),
  };
}

/** The value a resolve method returns for a decision, or `undefined` on a type mismatch. */
function pick(kind: Kind, featureKind: string, r: CheckResult): unknown {
  switch (kind) {
    case "boolean":
      return r.allowed;
    case "number":
      if (featureKind === "value") return typeof r.value === "number" ? r.value : undefined;
      if (featureKind === "boolean") return undefined;
      return r.remaining === null ? Number.POSITIVE_INFINITY : (r.remaining ?? 0);
    case "string":
      return featureKind === "value" && typeof r.value === "string" ? r.value : undefined;
    case "object": {
      if (featureKind === "value") return r.value;
      return JSON.parse(JSON.stringify(r)) as JsonValue;
    }
  }
}

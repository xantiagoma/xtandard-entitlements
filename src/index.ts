/**
 * The root entry point: the engine (`createEntitlements`), the pure resolver,
 * periods, the data model, and the storage / counter / hook contracts.
 * Drivers, billing providers, adapters and UI live behind their own subpaths
 * (e.g. `@xtandard/entitlements/counters/redis`); the catalog DSL is also
 * importable alone from `@xtandard/entitlements/catalog` (zero dependencies).
 *
 * @example
 * ```ts
 * import { createEntitlements } from "@xtandard/entitlements";
 * import { defineCatalog, feature } from "@xtandard/entitlements/catalog";
 *
 * const catalog = defineCatalog({
 *   features: { api_calls: feature.metered({ reset: "month" }), export_pdf: feature.boolean() },
 *   plans: {
 *     free: { default: true, features: { api_calls: 1_000 } },
 *     pro: { features: { api_calls: 100_000, export_pdf: true } },
 *   },
 * });
 *
 * const ent = createEntitlements({ catalog });
 * const decision = await ent.consume("org_42", "api_calls");
 * // { allowed: true, reason: "within_limit", remaining: 999, resetsAt: "2026-12-01T00:00:00.000Z", … }
 * ```
 *
 * @module entitlements
 */

// Catalog (also at /catalog)
export {
  addon,
  CatalogError,
  defineCatalog,
  feature,
  formatQuantity,
  getPlanVersion,
  plan,
  pricingTable,
} from "./catalog.ts";
export type {
  AddonDefinition,
  AddonKey,
  AnyCatalog,
  Catalog,
  CatalogDefinition,
  FeatureDefinition,
  FeatureKey,
  FeatureKeyOfKind,
  FeatureKind,
  FeatureValue,
  JsonObject,
  JsonValue,
  LimitSpec,
  MeteringMode,
  NormalizedCatalog,
  NormalizedFeature,
  NormalizedPlan,
  OveragePolicy,
  PlanDefinition,
  PlanKey,
  PriceDisplay,
  PricingCell,
  PricingPlan,
  PricingTable,
  ProviderMapping,
  ResetInterval,
} from "./catalog.ts";

// Data model
export { DEFAULT_ENTITLED_STATUSES } from "./schema.ts";
export type {
  ActivePlan,
  ActivityEntry,
  Actor,
  CheckResult,
  CustomerEntitlements,
  CustomerState,
  DecisionReason,
  Denial,
  EntitlementSet,
  EntitlementSource,
  FeatureUsage,
  Grant,
  GrantBucket,
  Override,
  Reservation,
  ResolvedFeature,
  Subscription,
  SubscriptionStatus,
  UsagePeriod,
} from "./schema.ts";

// Pure resolution + periods (request-path safe, no I/O)
export {
  emptyCustomerState,
  resolveEntitlements,
  subscriptionInactiveReason,
  unlockingPlans,
} from "./resolve.ts";
export type { ResolveOptions } from "./resolve.ts";
export { addMonthsClamped, anchoredMonth, currentPeriod } from "./periods.ts";
export type { PeriodAnchor } from "./periods.ts";
export { durationToMs } from "./duration.ts";
export type { Duration } from "./duration.ts";

// Engine
export {
  createEntitlements,
  EntitlementDeniedError,
  EntitlementsValidationError,
  NotFoundError,
  ReadonlyError,
} from "./engine.ts";
export type {
  ActorOptions,
  CheckOptions,
  ConsumeOptions,
  CountersOption,
  CustomerClient,
  CustomerSummary,
  Entitlements,
  EntitlementsOptions,
  GrantInput,
  OverrideInput,
  ReserveOptions,
  ReserveResult,
  SettleOptions,
  SubscribeInput,
  SubscriptionInput,
  TypedCheckResult,
  UpsertSubscriptionResult,
} from "./engine.ts";

// Runtime taps
export { emit } from "./events.ts";
export type {
  EventErrorReporter,
  ThresholdEvent,
  ThresholdListener,
  UsageEvent,
  UsageListener,
} from "./events.ts";

// Control-plane hooks
export {
  defaultHookErrorReporter,
  HookDeniedError,
  normalizeHooks,
  runAfter,
  runBefore,
} from "./hooks/contract.ts";
export type {
  AfterEvent,
  AfterEventType,
  BeforeEvent,
  BeforeEventType,
  EntitlementsHooks,
  EntitlementsHooksInput,
  HookErrorReporter,
} from "./hooks/contract.ts";

// State storage contract (+ composable watch)
export { isCompareAndSwap, isTransactional, isWatchable, requirePeer } from "./storage/contract.ts";
export type {
  CompareAndSwapEntitlementsStorage,
  EntitlementsStorage,
  StorageChangeEvent,
  TransactionalEntitlementsStorage,
  WatchableEntitlementsStorage,
} from "./storage/contract.ts";
export { pgListenNotify, withWatch } from "./storage/watch.ts";
export type { PgNotificationClient, WatchSubscribe } from "./storage/watch.ts";

// Counter contract
export { assertAmount, computeApplied } from "./counters/contract.ts";
export type { CounterAddOptions, CounterAddResult, CounterStore } from "./counters/contract.ts";
export { isBufferedCounterStore } from "./counters/buffered.ts";
export type { BufferedCounterStore } from "./counters/buffered.ts";

// Ledger internals (custom drivers / advanced use)
export { buildLegs, legState, takeLegs } from "./ledger.ts";
export type { Bucket, Leg, LegState, Take } from "./ledger.ts";

// Key layout (custom adapters)
export * as keys from "./keys.ts";
export { newId } from "./id.ts";

/**
 * UI-facing types. Entity shapes are re-exported from the package schema and
 * catalog (types only — safe to bundle); the UI adds the wire shapes the panel's
 * JSON API serves (docs/HTTP_API.md) and its error type.
 *
 * @module
 */

export type {
  ActivePlan,
  ActivityEntry,
  Actor,
  CheckResult,
  CustomerEntitlements,
  CustomerState,
  EntitlementSource,
  FeatureUsage,
  Grant,
  Override,
  Subscription,
  SubscriptionStatus,
} from "../schema.ts";
export type {
  FeatureKind,
  JsonObject,
  JsonValue,
  NormalizedAddon,
  NormalizedEntry,
  NormalizedFeature,
  NormalizedPlan,
  PriceDisplay,
  PricingCell,
  PricingPlan,
  PricingTable,
  ResetInterval,
} from "../catalog.ts";
export type { CustomerSummary, GrantInput, OverrideInput, SubscribeInput } from "../engine.ts";

import { ApiError } from "@xtandard/kit/ui";
import type {
  NormalizedAddon,
  NormalizedFeature,
  NormalizedPlan,
  PricingTable,
} from "../catalog.ts";
import type {
  ActivityEntry,
  CustomerEntitlements,
  CustomerState,
  SubscriptionStatus,
} from "../schema.ts";
import type { CustomerSummary } from "../engine.ts";

/** Bootstrap config injected as `window.__ENTITLEMENTS_CONFIG__` and served at `/config`. */
export interface PanelConfig {
  title: string;
  logoUrl?: string;
  basePath: string;
  readonly: boolean;
  /** `"portal"` when the request carries a portal token: render the reduced customer chrome. */
  mode?: "admin" | "portal";
  authenticated?: boolean;
  principal?: { id: string; name?: string; email?: string; roles?: string[] } | null;
  /** Portal mode: the token's customer. */
  customer?: string;
  /** Portal mode: the token's granted portal actions. */
  scope?: string[];
  /** Configured billing provider ids. */
  billingProviders?: string[];
}

/** `GET /api/catalog`. */
export interface CatalogView {
  features: NormalizedFeature[];
  /** Every version, current first per plan, in plan order. */
  plans: NormalizedPlan[];
  addons: NormalizedAddon[];
  /** Including hidden plans (admin view). */
  pricing: PricingTable;
}

/** `GET /api/overview`. */
export interface Overview {
  customers: number;
  byPlan: Record<string, number>;
  statuses: Partial<Record<SubscriptionStatus, number>>;
  trialsEndingSoon: Array<{ customer: string; plan: string; trialEndsAt: string }>;
  recentActivity: ActivityEntry[];
}

/** `GET /api/customers`. */
export interface CustomerPage {
  customers: CustomerSummary[];
  next?: string;
}

/** `GET /api/customers/:id`. */
export interface CustomerDetail {
  state: CustomerState | null;
  entitlements: CustomerEntitlements;
}

/** `GET /api/portal/me`. */
export interface PortalView extends CustomerEntitlements {
  profile: { id: string; name?: string; email?: string };
  pricing: PricingTable;
  canCheckout: boolean;
  canManage: boolean;
}

/** One point of `GET /api/customers/:id/usage/:feature/series`. */
export interface SeriesPoint {
  date: string;
  value: number;
}

/** The JSON error body every non-2xx response carries. */
export type { ApiErrorBody } from "@xtandard/kit/ui";

/** A non-2xx API response. */
export class EntitlementsApiError extends ApiError {
  override name = "EntitlementsApiError";
}

/** A human message for any thrown value (API errors carry the server's message). */
export function errorMessage(error: unknown, fallback = "Something went wrong"): string {
  if (error instanceof EntitlementsApiError) return error.body.error || fallback;
  if (error instanceof Error && error.message) return error.message;
  return fallback;
}

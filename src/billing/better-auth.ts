/**
 * better-auth's Stripe plugin (`@better-auth/stripe`) as a billing source
 * (ADR 0007). The plugin owns the Stripe webhook endpoint and its own
 * `subscription` table; this module hands it callbacks that feed the same
 * subscription changes into entitlements, plus `plans` generated from the
 * catalog — so there is no webhook route of ours to mount.
 *
 * - `betterAuthStripe(ent | billing)` → `{ plans, onSubscriptionComplete,
 *   onSubscriptionCreated, onSubscriptionUpdate, onSubscriptionCancel,
 *   onSubscriptionDeleted }` — spread it into the plugin's `subscription`
 *   option (names checked against `@better-auth/stripe` 1.7 types).
 * - The plugin's `referenceId` (user id, or organization id with the
 *   organization plugin) is the entitlements customer (override with
 *   `customerId`). Items map through the catalog's `stripe` price ids, so
 *   upgrades, add-ons and legacy prices behave exactly as with
 *   `createStripeProvider`; Stripe event ids make deliveries idempotent.
 * - No runtime import of better-auth or Stripe: the callback types are
 *   structural.
 *
 * Source: https://www.better-auth.com/docs/plugins/stripe
 *
 * @example
 * ```ts
 * import { stripe } from "@better-auth/stripe";
 * import { betterAuthStripe } from "@xtandard/entitlements/billing/better-auth";
 *
 * betterAuth({
 *   plugins: [
 *     stripe({
 *       stripeClient,
 *       stripeWebhookSecret: process.env.STRIPE_WEBHOOK_SECRET!,
 *       subscription: { enabled: true, ...betterAuthStripe(ent) },
 *     }),
 *   ],
 * });
 * ```
 *
 * @module billing/better-auth
 */

import type { AnyCatalog, NormalizedPlan } from "../catalog.ts";
import type { Entitlements } from "../engine.ts";
import type { BillingEvent, EntitlementsBilling, ProviderSubscription } from "./contract.ts";
import { createBilling } from "./intake.ts";
import {
  normalizeStripeSubscription,
  stripeStatus,
  type StripeSubscriptionObject,
} from "./stripe.ts";

/** The plugin's `Subscription` row (structural subset of `@better-auth/stripe`'s type). */
export interface BetterAuthStripeSubscription {
  id: string;
  plan: string;
  referenceId: string;
  stripeCustomerId?: string | undefined;
  stripeSubscriptionId?: string | undefined;
  priceId?: string | undefined;
  status: string;
  periodStart?: Date | undefined;
  periodEnd?: Date | undefined;
  trialEnd?: Date | undefined;
  cancelAtPeriodEnd?: boolean | undefined;
  canceledAt?: Date | undefined;
  seats?: number | undefined;
}

/** A plugin plan (structural subset of `@better-auth/stripe`'s `StripePlan`). */
export interface BetterAuthStripePlan {
  name: string;
  priceId?: string;
  group?: string;
  limits?: Record<string, unknown>;
  freeTrial?: { days: number };
}

/** What the plugin passes to its subscription callbacks. */
export interface BetterAuthStripeCallbackData {
  event?: { id: string; created?: number };
  stripeSubscription?: StripeSubscriptionObject;
  subscription: BetterAuthStripeSubscription;
}

/** Options for {@link toBetterAuthPlans}. */
export interface BetterAuthPlansOptions {
  /** Catalog provider key holding the Stripe price ids. Default `"stripe"`. */
  provider?: string;
  /** Include hidden plans. Default `true` (they can still be subscribed to). */
  includeHidden?: boolean;
}

/** Options for {@link betterAuthStripe}. */
export interface BetterAuthStripeOptions extends BetterAuthPlansOptions {
  /** Required to generate `plans` when passing an `EntitlementsBilling` instead of the engine. */
  catalog?: AnyCatalog;
  /** Entitlements customer for a plugin subscription. Default `subscription.referenceId`. */
  customerId?: (subscription: BetterAuthStripeSubscription) => string;
}

/** The plugin `subscription` option fragment returned by {@link betterAuthStripe}. */
export interface BetterAuthStripeSubscriptionOptions {
  plans: BetterAuthStripePlan[];
  onSubscriptionComplete: (data: BetterAuthStripeCallbackData) => Promise<void>;
  onSubscriptionCreated: (data: BetterAuthStripeCallbackData) => Promise<void>;
  onSubscriptionUpdate: (data: BetterAuthStripeCallbackData) => Promise<void>;
  onSubscriptionCancel: (data: BetterAuthStripeCallbackData) => Promise<void>;
  onSubscriptionDeleted: (data: BetterAuthStripeCallbackData) => Promise<void>;
}

/** A plan's features as plugin `limits`: numbers (`null` = unlimited), booleans and values. */
function limitsOf(plan: NormalizedPlan): Record<string, unknown> {
  const limits: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(plan.features)) {
    if (entry.kind === "boolean") limits[key] = entry.enabled;
    else if (entry.kind === "value") limits[key] = entry.value;
    else limits[key] = entry.included ? entry.limit : 0;
  }
  return limits;
}

/**
 * Generate the plugin's `plans` from the catalog: one per plan (current
 * version) that has a Stripe price id — `name` is the plan key, `priceId`
 * the first mapped price, `limits` the plan's features, `freeTrial` the
 * plan's trial and `group` its group (omitted for `"base"`).
 */
export function toBetterAuthPlans(
  catalog: AnyCatalog,
  options: BetterAuthPlansOptions = {},
): BetterAuthStripePlan[] {
  const provider = options.provider ?? "stripe";
  const n = catalog.normalized;
  const out: BetterAuthStripePlan[] = [];
  for (const key of n.planOrder) {
    const plan = n.plans.get(key)!;
    const priceId = plan.providers[provider]?.[0];
    if (!priceId || (plan.hidden && options.includeHidden === false)) continue;
    const p: BetterAuthStripePlan = { name: key, priceId, limits: limitsOf(plan) };
    if (plan.group !== "base") p.group = plan.group;
    if (plan.trialDays) p.freeTrial = { days: plan.trialDays };
    out.push(p);
  }
  return out;
}

/** Normalize a plugin row when the Stripe object is not available. */
function fromRow(sub: BetterAuthStripeSubscription): ProviderSubscription {
  const out: ProviderSubscription = {
    ref: sub.stripeSubscriptionId ?? sub.id,
    providerCustomer: sub.stripeCustomerId ?? "",
    items: sub.priceId ? [{ id: sub.priceId, quantity: sub.seats ?? 1 }] : [],
    status: stripeStatus(sub.status),
  };
  if (sub.periodStart) out.periodStart = sub.periodStart.toISOString();
  if (sub.periodEnd) out.periodEnd = sub.periodEnd.toISOString();
  if (sub.trialEnd) out.trialEndsAt = sub.trialEnd.toISOString();
  if (sub.cancelAtPeriodEnd !== undefined) out.cancelAtPeriodEnd = sub.cancelAtPeriodEnd;
  if (sub.canceledAt) out.canceledAt = sub.canceledAt.toISOString();
  return out;
}

const isBilling = (x: Entitlements | EntitlementsBilling): x is EntitlementsBilling =>
  typeof (x as EntitlementsBilling).apply === "function" &&
  typeof (x as EntitlementsBilling).handleWebhook === "function";

/**
 * Callbacks + plans for `@better-auth/stripe`'s `subscription` option. Pass
 * the engine (a billing intake with a webhook-less `stripe` provider is
 * created for you) or an existing {@link EntitlementsBilling} (then pass
 * `catalog` to get `plans`).
 */
export function betterAuthStripe(
  target: Entitlements | EntitlementsBilling,
  options: BetterAuthStripeOptions = {},
): BetterAuthStripeSubscriptionOptions {
  const provider = options.provider ?? "stripe";
  const billing = isBilling(target)
    ? target
    : createBilling(target, { providers: [{ id: provider }] });
  const catalog = options.catalog ?? (isBilling(target) ? undefined : target.catalog);
  const customerOf = options.customerId ?? ((s: BetterAuthStripeSubscription) => s.referenceId);

  const handle = (deleted: boolean) => async (data: BetterAuthStripeCallbackData) => {
    const subscription: ProviderSubscription = {
      ...(data.stripeSubscription
        ? normalizeStripeSubscription(data.stripeSubscription)
        : fromRow(data.subscription)),
      customer: customerOf(data.subscription),
    };
    if (!subscription.providerCustomer && data.subscription.stripeCustomerId) {
      subscription.providerCustomer = data.subscription.stripeCustomerId;
    }
    if (typeof data.event?.created === "number") {
      subscription.updatedAt = new Date(data.event.created * 1000).toISOString();
    }
    const event: BillingEvent = deleted
      ? { type: "subscription.deleted", subscription }
      : { type: "subscription.updated", subscription };
    await billing.apply(provider, [event], data.event?.id ? { eventId: data.event.id } : {});
  };

  return {
    plans: catalog ? toBetterAuthPlans(catalog, options) : [],
    onSubscriptionComplete: handle(false),
    onSubscriptionCreated: handle(false),
    onSubscriptionUpdate: handle(false),
    onSubscriptionCancel: handle(false),
    onSubscriptionDeleted: handle(true),
  };
}

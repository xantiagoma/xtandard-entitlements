/**
 * The billing port (ADR 0007). Providers (Stripe, Polar, Paddle, Lemon
 * Squeezy, better-auth Stripe, manual) normalize their subscription state into
 * {@link ProviderSubscription}s; the intake ({@link EntitlementsBilling}, built
 * by `createBilling` in `@xtandard/entitlements/billing`) maps them onto catalog
 * plans and writes provider-agnostic subscriptions through the engine.
 *
 * Money stays with the provider (ADR 0015): nothing here prices, invoices or
 * charges.
 *
 * @module
 */

import type { JsonObject, SubscriptionStatus } from "../schema.ts";

/** One line item of a provider subscription (a price / product / variant id). */
export interface ProviderItem {
  /** The id the catalog's `providers` mapping uses (Stripe price, Polar product, …). */
  id: string;
  quantity: number;
  /** Provider's id for the item itself (e.g. Stripe `si_…`), when distinct. */
  itemRef?: string;
}

/** A provider subscription, normalized. */
export interface ProviderSubscription {
  /** Provider subscription id. */
  ref: string;
  /** Provider customer id. */
  providerCustomer: string;
  /** Our customer id, when the provider carries it (metadata / client reference). */
  customer?: string;
  items: ProviderItem[];
  status: SubscriptionStatus;
  periodStart?: string;
  periodEnd?: string;
  trialEndsAt?: string;
  cancelAtPeriodEnd?: boolean;
  canceledAt?: string;
  /** Provider-side last update (ISO), for out-of-order safety. */
  updatedAt?: string;
  metadata?: JsonObject;
}

/** What a verified webhook means. */
export type BillingEvent =
  | { type: "subscription.updated"; subscription: ProviderSubscription }
  | { type: "subscription.deleted"; subscription: ProviderSubscription }
  | {
      type: "customer.updated";
      providerCustomer: string;
      customer?: string;
      email?: string;
      name?: string;
    }
  | { type: "ignored"; reason: string };

/** A verified, parsed webhook. */
export interface BillingWebhook {
  /** Provider event id (idempotency). */
  id: string;
  /** Provider event type, e.g. `customer.subscription.updated`. */
  type: string;
  /** ISO time the provider created the event. */
  createdAt?: string;
  events: BillingEvent[];
}

/** Input to {@link BillingProvider.createCheckout}. */
export interface CheckoutInput {
  customer: string;
  providerCustomer?: string;
  email?: string;
  /** The provider item id to buy (from the catalog mapping). */
  item: string;
  quantity?: number;
  successUrl?: string;
  cancelUrl?: string;
  trialDays?: number;
}

/** Input to {@link BillingProvider.createPortalSession}. */
export interface PortalSessionInput {
  customer: string;
  providerCustomer: string;
  returnUrl?: string;
}

/** A usage record to push to a provider meter (optional usage export). */
export interface UsageRecord {
  customer: string;
  providerCustomer?: string;
  feature: string;
  /** Provider meter / event name. */
  meter: string;
  amount: number;
  at: string;
  idempotencyKey?: string;
}

/** Thrown by {@link BillingProvider.parseWebhook} for bad signatures / payloads (HTTP 400). */
export class BillingVerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BillingVerificationError";
  }
}

/** A billing provider adapter. */
export interface BillingProvider {
  /** `"stripe"`, `"polar"`, `"paddle"`, `"lemonsqueezy"`, `"manual"`, … (matches catalog `providers` keys). */
  readonly id: string;
  /** Verify the signature and normalize the payload. Throws {@link BillingVerificationError}. */
  parseWebhook?(request: Request): Promise<BillingWebhook>;
  /** Current subscriptions of a provider customer (reconcile / backfill). */
  fetchSubscriptions?(providerCustomer: string): Promise<ProviderSubscription[]>;
  /** Hosted checkout link-out. */
  createCheckout?(input: CheckoutInput): Promise<{ url: string }>;
  /** Hosted billing-portal link-out. */
  createPortalSession?(input: PortalSessionInput): Promise<{ url: string }>;
  /** Push usage to provider meters. */
  reportUsage?(records: UsageRecord[]): Promise<void>;
}

/** Outcome of one webhook delivery. */
export type IntakeOutcome = "applied" | "duplicate" | "ignored" | "stale";

/** Result of {@link EntitlementsBilling.reconcile}. */
export interface ReconcileResult {
  customer: string;
  provider: string;
  upserted: number;
  canceled: number;
}

/**
 * The billing intake bound to an engine — what the panel's
 * `POST /webhooks/:provider`, `/api/portal/checkout|manage` and
 * `/api/customers/:id/reconcile` routes call.
 */
export interface EntitlementsBilling {
  /** Configured provider ids. */
  readonly providers: readonly string[];
  /** Verify + apply a webhook. Throws `BillingVerificationError` (400) or `NotFoundError` (404 unknown provider). */
  handleWebhook(
    provider: string,
    request: Request,
  ): Promise<{ outcome: IntakeOutcome; events: number }>;
  /** Apply normalized events directly (tests, better-auth callbacks, custom intakes). */
  apply(
    provider: string,
    events: BillingEvent[],
    options?: { eventId?: string },
  ): Promise<IntakeOutcome>;
  /** Pull the provider's current state for a customer and converge on it. */
  reconcile(customer: string, provider?: string): Promise<ReconcileResult[]>;
  /** Checkout link-out for a plan or add-on key from the catalog. */
  createCheckout(
    customer: string,
    input: {
      plan: string;
      quantity?: number;
      successUrl?: string;
      cancelUrl?: string;
      provider?: string;
    },
  ): Promise<{ url: string }>;
  /** Billing-portal link-out. */
  createPortalSession(
    customer: string,
    input?: { returnUrl?: string; provider?: string },
  ): Promise<{ url: string }>;
  readonly canCheckout: boolean;
  readonly canManage: boolean;
}

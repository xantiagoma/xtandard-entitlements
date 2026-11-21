/**
 * Billing test fixtures: a catalog mapped for every provider, and one
 * "driver" per provider that turns a provider-neutral subscription state into
 * a realistic, signed webhook `Request` in that provider's wire format
 * (shapes follow each provider's documented payloads).
 */
import { defineCatalog, feature } from "../src/catalog.ts";
import type { BillingProvider } from "../src/billing/contract.ts";
import {
  createLemonSqueezyProvider,
  signLemonSqueezyPayload,
} from "../src/billing/lemonsqueezy.ts";
import { createPaddleProvider, signPaddlePayload } from "../src/billing/paddle.ts";
import { createPolarProvider, signPolarPayload } from "../src/billing/polar.ts";
import { createStripeProvider, signStripePayload } from "../src/billing/stripe.ts";

/** Item ids per provider: pro (current), pro v1 (legacy), business, seats add-on. */
export const IDS = {
  stripe: {
    pro: "price_pro_m",
    legacy: "price_pro_legacy",
    business: "price_biz_m",
    seats: "price_seats",
  },
  polar: { pro: "prod_pro", legacy: "prod_pro_legacy", business: "prod_biz", seats: "prod_seats" },
  paddle: { pro: "pri_pro", legacy: "pri_pro_legacy", business: "pri_biz", seats: "pri_seats" },
  lemonsqueezy: { pro: "101", legacy: "100", business: "201", seats: "301" },
} as const;

export type ProviderName = keyof typeof IDS;

const providersFor = (k: "pro" | "legacy" | "business" | "seats") => ({
  stripe: [IDS.stripe[k]],
  polar: [IDS.polar[k]],
  paddle: [IDS.paddle[k]],
  lemonsqueezy: [IDS.lemonsqueezy[k]],
});

export const billingCatalog = defineCatalog({
  features: {
    seats: feature.capacity({ name: "Seats", unit: "seat" }),
    api_calls: feature.metered({ name: "API calls", unit: "call", reset: "month" }),
    export_pdf: feature.boolean({ name: "PDF export" }),
    sso: feature.boolean({ name: "SSO" }),
    max_upload_mb: feature.value({ name: "Max upload (MB)", default: 10 }),
    support: feature.value({ name: "Support", default: "community" }),
  },
  plans: {
    free: { name: "Free", default: true, features: { seats: 3, api_calls: 1_000 } },
    pro: {
      name: "Pro",
      version: 2,
      trial: { days: 14 },
      providers: providersFor("pro"),
      features: {
        seats: 10,
        api_calls: { limit: 100_000, overage: "allow" },
        export_pdf: true,
        max_upload_mb: 500,
        support: "email",
      },
      previous: {
        1: {
          providers: providersFor("legacy"),
          features: { seats: 5, api_calls: 50_000, export_pdf: true },
        },
      },
    },
    business: {
      name: "Business",
      providers: providersFor("business"),
      features: {
        seats: 50,
        api_calls: "unlimited",
        export_pdf: true,
        sso: true,
        support: "priority",
      },
    },
    team: { name: "Team", group: "workspace", features: { seats: 20 } },
  },
  addons: {
    extra_seats: {
      name: "+5 seats",
      quantity: true,
      providers: providersFor("seats"),
      features: { seats: { add: 5 } },
    },
  },
});

/** Provider-neutral subscription state the drivers render. */
export interface SubState {
  ref: string;
  providerCustomer: string;
  /** Our customer id, carried in metadata / external id / custom data. */
  customer?: string;
  status: "trialing" | "active" | "past_due" | "canceled";
  items: Array<{ id: string; quantity: number; itemRef?: string }>;
  periodStart: string;
  periodEnd: string;
  trialEnd?: string;
  cancelAtPeriodEnd?: boolean;
  canceledAt?: string;
  /** Provider-side update time (ISO). */
  updatedAt: string;
}

export interface Driver {
  name: ProviderName;
  ids: (typeof IDS)[ProviderName];
  /** Whether one provider subscription can hold several items (plan + add-on). */
  multiItem: boolean;
  /** Whether the provider signs a timestamp (expired-timestamp test). */
  signsTimestamp: boolean;
  provider: BillingProvider;
  /** A signed webhook for `state`. */
  webhook(state: SubState, o: { eventId: string; deleted?: boolean }): Promise<Request>;
  /** A request whose signature does not verify. */
  badSignature(state: SubState): Promise<Request>;
  /** A correctly signed request whose timestamp is outside the tolerance. */
  expired?(state: SubState): Promise<Request>;
}

export const SECRETS = {
  stripe: "whsec_stripe_test_secret",
  // A Standard Webhooks secret (24 random bytes, base64) — Polar's current format.
  polar: "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw",
  paddle: "pdl_ntfset_test_secret_key",
  lemonsqueezy: "ls_signing_secret",
};

const sec = (iso: string) => Math.floor(Date.parse(iso) / 1000);
const req = (provider: string, body: string, headers: Record<string, string>) =>
  new Request(`https://app.test/webhooks/${provider}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body,
  });

// --- Stripe -------------------------------------------------------------------

export function stripeSubscription(s: SubState) {
  return {
    id: s.ref,
    object: "subscription",
    customer: s.providerCustomer,
    status: s.status,
    collection_method: "charge_automatically",
    currency: "usd",
    items: {
      object: "list",
      data: s.items.map((i) => ({
        id: i.itemRef ?? `si_${i.id}`,
        object: "subscription_item",
        quantity: i.quantity,
        price: { id: i.id, object: "price", currency: "usd", recurring: { interval: "month" } },
        current_period_start: sec(s.periodStart),
        current_period_end: sec(s.periodEnd),
      })),
    },
    trial_end: s.trialEnd ? sec(s.trialEnd) : null,
    cancel_at_period_end: s.cancelAtPeriodEnd ?? false,
    cancel_at: s.cancelAtPeriodEnd ? sec(s.periodEnd) : null,
    canceled_at: s.canceledAt ? sec(s.canceledAt) : null,
    ended_at: s.status === "canceled" && s.canceledAt ? sec(s.canceledAt) : null,
    metadata: (s.customer ? { customerId: s.customer } : {}) as Record<string, string>,
    livemode: false,
  };
}

export function stripeDriver(now: () => number): Driver {
  const provider = createStripeProvider({
    secretKey: "sk_test_123",
    webhookSecret: SECRETS.stripe,
    now,
  });
  const body = (s: SubState, o: { eventId: string; deleted?: boolean }) =>
    JSON.stringify({
      id: o.eventId,
      object: "event",
      api_version: "2025-03-31.basil",
      created: sec(s.updatedAt),
      type: o.deleted ? "customer.subscription.deleted" : "customer.subscription.updated",
      data: { object: stripeSubscription(s) },
      livemode: false,
    });
  const nowSec = () => Math.floor(now() / 1000);
  return {
    name: "stripe",
    ids: IDS.stripe,
    multiItem: true,
    signsTimestamp: true,
    provider,
    async webhook(s, o) {
      const b = body(s, o);
      return req("stripe", b, {
        "stripe-signature": await signStripePayload(SECRETS.stripe, b, nowSec()),
      });
    },
    async badSignature(s) {
      const b = body(s, { eventId: "evt_bad" });
      return req("stripe", b, {
        "stripe-signature": await signStripePayload("whsec_wrong", b, nowSec()),
      });
    },
    async expired(s) {
      const b = body(s, { eventId: "evt_old" });
      return req("stripe", b, {
        "stripe-signature": await signStripePayload(SECRETS.stripe, b, nowSec() - 3600),
      });
    },
  };
}

// --- Polar --------------------------------------------------------------------

export function polarSubscription(s: SubState) {
  const item = s.items[0]!;
  return {
    id: s.ref,
    created_at: s.periodStart,
    modified_at: s.updatedAt,
    amount: 2900,
    currency: "usd",
    recurring_interval: "month",
    recurring_interval_count: 1,
    status: s.status,
    current_period_start: s.periodStart,
    current_period_end: s.periodEnd,
    trial_start: s.trialEnd ? s.periodStart : null,
    trial_end: s.trialEnd ?? null,
    cancel_at_period_end: s.cancelAtPeriodEnd ?? false,
    canceled_at: s.canceledAt ?? null,
    started_at: s.periodStart,
    ends_at: s.cancelAtPeriodEnd ? s.periodEnd : null,
    ended_at: s.status === "canceled" ? (s.canceledAt ?? null) : null,
    customer_id: s.providerCustomer,
    product_id: item.id,
    seats: item.quantity > 1 ? item.quantity : null,
    metadata: {},
    customer: {
      id: s.providerCustomer,
      external_id: s.customer ?? null,
      email: "billing@acme.test",
      metadata: {},
    },
    prices: [],
  };
}

export function polarDriver(now: () => number): Driver {
  const provider = createPolarProvider({
    accessToken: "polar_oat_test",
    webhookSecret: SECRETS.polar,
    now,
  });
  const body = (s: SubState, o: { deleted?: boolean }) =>
    JSON.stringify({
      type: o.deleted ? "subscription.revoked" : "subscription.updated",
      timestamp: s.updatedAt,
      api_version: "2026-10",
      data: polarSubscription(s),
    });
  const nowSec = () => Math.floor(now() / 1000);
  return {
    name: "polar",
    ids: IDS.polar,
    multiItem: false,
    signsTimestamp: true,
    provider,
    async webhook(s, o) {
      const b = body(s, o);
      return req(
        "polar",
        b,
        await signPolarPayload(SECRETS.polar, b, { id: o.eventId, timestamp: nowSec() }),
      );
    },
    async badSignature(s) {
      const b = body(s, {});
      const h = await signPolarPayload(SECRETS.polar, b, { id: "msg_bad", timestamp: nowSec() });
      return req("polar", b.replace("subscription.updated", "subscription.active"), h);
    },
    async expired(s) {
      const b = body(s, {});
      return req(
        "polar",
        b,
        await signPolarPayload(SECRETS.polar, b, { id: "msg_old", timestamp: nowSec() - 3600 }),
      );
    },
  };
}

// --- Paddle -------------------------------------------------------------------

export function paddleSubscription(s: SubState) {
  return {
    id: s.ref,
    status: s.status,
    customer_id: s.providerCustomer,
    address_id: "add_01h7hswbfjqez51ezfhk7s6400",
    business_id: null,
    currency_code: "USD",
    created_at: s.periodStart,
    updated_at: s.updatedAt,
    started_at: s.periodStart,
    first_billed_at: s.periodStart,
    next_billed_at: s.status === "canceled" ? null : s.periodEnd,
    paused_at: null,
    canceled_at: s.canceledAt ?? null,
    collection_mode: "automatic",
    billing_details: null,
    current_billing_period:
      s.status === "canceled" ? null : { starts_at: s.periodStart, ends_at: s.periodEnd },
    billing_cycle: { interval: "month", frequency: 1 },
    scheduled_change: s.cancelAtPeriodEnd
      ? { action: "cancel", effective_at: s.periodEnd, resume_at: null }
      : null,
    items: s.items.map((i) => ({
      status: s.status === "trialing" ? "trialing" : "active",
      quantity: i.quantity,
      recurring: true,
      created_at: s.periodStart,
      updated_at: s.updatedAt,
      previously_billed_at: s.periodStart,
      next_billed_at: s.periodEnd,
      trial_dates: s.trialEnd ? { starts_at: s.periodStart, ends_at: s.trialEnd } : null,
      price: {
        id: i.id,
        product_id: `pro_${i.id}`,
        description: "Monthly",
        billing_cycle: { interval: "month", frequency: 1 },
        unit_price: { amount: "2900", currency_code: "USD" },
      },
    })),
    custom_data: s.customer ? { customerId: s.customer } : null,
    management_urls: { update_payment_method: null, cancel: "https://buyer-portal.paddle.com/x" },
    discount: null,
  };
}

export function paddleDriver(now: () => number): Driver {
  const provider = createPaddleProvider({
    apiKey: "pdl_test_apikey",
    webhookSecret: SECRETS.paddle,
    now,
  });
  const body = (s: SubState, o: { eventId: string; deleted?: boolean }) =>
    JSON.stringify({
      event_id: o.eventId,
      event_type: o.deleted ? "subscription.canceled" : "subscription.updated",
      occurred_at: s.updatedAt,
      notification_id: `ntf_${o.eventId}`,
      data: paddleSubscription(s),
    });
  const nowSec = () => Math.floor(now() / 1000);
  return {
    name: "paddle",
    ids: IDS.paddle,
    multiItem: true,
    signsTimestamp: true,
    provider,
    async webhook(s, o) {
      const b = body(s, o);
      return req("paddle", b, {
        "paddle-signature": await signPaddlePayload(SECRETS.paddle, b, nowSec()),
      });
    },
    async badSignature(s) {
      const b = body(s, { eventId: "evt_bad" });
      return req("paddle", b, {
        "paddle-signature": await signPaddlePayload("other", b, nowSec()),
      });
    },
    async expired(s) {
      const b = body(s, { eventId: "evt_old" });
      return req("paddle", b, {
        "paddle-signature": await signPaddlePayload(SECRETS.paddle, b, nowSec() - 60),
      });
    },
  };
}

// --- Lemon Squeezy --------------------------------------------------------------

export function lemonSqueezySubscription(s: SubState) {
  const item = s.items[0]!;
  const status =
    s.status === "trialing"
      ? "on_trial"
      : s.status === "canceled"
        ? "expired"
        : s.cancelAtPeriodEnd
          ? "cancelled"
          : s.status;
  return {
    type: "subscriptions",
    id: s.ref,
    attributes: {
      store_id: 1,
      customer_id: Number(s.providerCustomer),
      order_id: 1,
      order_item_id: 1,
      product_id: 1,
      variant_id: Number(item.id),
      product_name: "Pro",
      variant_name: "Monthly",
      user_name: "Acme",
      user_email: "billing@acme.test",
      status,
      status_formatted: status,
      cancelled: !!s.cancelAtPeriodEnd || s.status === "canceled",
      trial_ends_at: s.trialEnd ?? null,
      billing_anchor: 20,
      first_subscription_item: {
        id: 9000 + Number(item.id),
        subscription_id: Number(s.ref),
        price_id: 1,
        quantity: item.quantity,
        is_usage_based: false,
      },
      urls: { customer_portal: "https://acme.lemonsqueezy.com/billing" },
      renews_at: s.periodEnd,
      ends_at:
        s.cancelAtPeriodEnd || s.status === "canceled" ? (s.canceledAt ?? s.periodEnd) : null,
      created_at: s.periodStart,
      updated_at: s.updatedAt,
      test_mode: true,
    },
  };
}

export function lemonSqueezyDriver(): Driver {
  const provider = createLemonSqueezyProvider({
    apiKey: "ls_test_key",
    webhookSecret: SECRETS.lemonsqueezy,
    storeId: 1,
  });
  const body = (s: SubState, o: { eventId: string; deleted?: boolean }) =>
    JSON.stringify({
      meta: {
        event_name: o.deleted
          ? "subscription_expired"
          : s.cancelAtPeriodEnd
            ? "subscription_cancelled"
            : "subscription_updated",
        custom_data: s.customer ? { customerId: s.customer } : undefined,
        webhook_id: o.eventId,
      },
      data: lemonSqueezySubscription(s),
    });
  return {
    name: "lemonsqueezy",
    ids: IDS.lemonsqueezy,
    multiItem: false,
    signsTimestamp: false,
    provider,
    async webhook(s, o) {
      const b = body(s, o);
      return req("lemonsqueezy", b, {
        "x-event-name": "subscription_updated",
        "x-signature": await signLemonSqueezyPayload(SECRETS.lemonsqueezy, b),
      });
    },
    async badSignature(s) {
      const b = body(s, { eventId: "bad" });
      return req("lemonsqueezy", b, { "x-signature": await signLemonSqueezyPayload("nope", b) });
    },
  };
}

/** A recording fake `fetch`: answers from `routes` (method + path prefix), records every call. */
export function fakeFetch(
  routes: Array<{ method: string; path: string; status?: number; body: unknown }>,
) {
  const calls: Array<{
    method: string;
    url: string;
    headers: Record<string, string>;
    body?: string;
  }> = [];
  const fetch = async (input: string, init: RequestInit = {}) => {
    const method = init.method ?? "GET";
    const headers: Record<string, string> = {};
    new Headers(init.headers).forEach((v, k) => (headers[k] = v));
    calls.push({
      method,
      url: input,
      headers,
      ...(typeof init.body === "string" ? { body: init.body } : {}),
    });
    const u = new URL(input);
    const route = routes.find(
      (r) => r.method === method && `${u.pathname}${u.search}`.startsWith(r.path),
    );
    if (!route) return new Response(JSON.stringify({ error: "no route" }), { status: 404 });
    return new Response(route.body === undefined ? "" : JSON.stringify(route.body), {
      status: route.status ?? 200,
    });
  };
  return { fetch, calls };
}

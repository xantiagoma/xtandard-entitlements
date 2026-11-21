/**
 * Stripe billing provider — no SDK, `fetch` + Web Crypto only (ADR 0007).
 *
 * - **Webhooks.** `Stripe-Signature: t=…,v1=…[,v1=…]`: HMAC-SHA256 (hex) of
 *   `` `${t}.${rawBody}` `` keyed with the endpoint secret (`whsec_…`, used as
 *   UTF-8 bytes); any `v1` may match (secret rolling), other schemes (`v0`,
 *   debug entries) are ignored; `t` must be within the tolerance (default
 *   300 s, Stripe's library default).
 *   Source: https://docs.stripe.com/webhooks#verify-manually
 * - **Events.** `customer.subscription.created | updated | paused | resumed |
 *   pending_update_applied | pending_update_expired | trial_will_end` →
 *   `subscription.updated`; `customer.subscription.deleted` →
 *   `subscription.deleted`; `checkout.session.completed` (subscription mode)
 *   and `customer.created | updated` → `customer.updated` (links
 *   `client_reference_id` / `metadata[metadataKey]` to the Stripe customer).
 *   Everything else is `ignored`.
 * - **Subscription shape.** Billing periods are read from the subscription
 *   items (`items.data[].current_period_start|end`, API ≥ 2025-03-31) with a
 *   fallback to the legacy top-level fields.
 *   Source: https://docs.stripe.com/api/subscriptions/object
 * - **Status mapping.** `active`, `trialing`, `past_due`, `paused`,
 *   `canceled`, `incomplete` map 1:1; `unpaid` (retries exhausted, Stripe
 *   advises revoking access) → `paused`; `incomplete_expired` (terminal) →
 *   `canceled`.
 * - **REST.** `GET /v1/subscriptions?customer=…&status=all` (reconcile),
 *   `POST /v1/checkout/sessions` (mode `subscription`), `POST
 *   /v1/billing_portal/sessions`, `POST /v1/billing/meter_events` (usage
 *   export) — form-encoded, `Authorization: Bearer <secret key>`.
 *   Sources: https://docs.stripe.com/api/checkout/sessions/create,
 *   https://docs.stripe.com/api/customer_portal/sessions/create,
 *   https://docs.stripe.com/api/billing/meter-event/create
 *
 * @example
 * ```ts
 * import { createStripeProvider } from "@xtandard/entitlements/billing/stripe";
 *
 * const stripe = createStripeProvider({
 *   secretKey: process.env.STRIPE_SECRET_KEY!,
 *   webhookSecret: process.env.STRIPE_WEBHOOK_SECRET!,
 * });
 * ```
 *
 * @module billing/stripe
 */

import type { JsonObject, SubscriptionStatus } from "../schema.ts";
import {
  BillingVerificationError,
  type BillingEvent,
  type BillingProvider,
  type BillingWebhook,
  type CheckoutInput,
  type PortalSessionInput,
  type ProviderSubscription,
  type UsageRecord,
} from "./contract.ts";
import {
  anyMatch,
  assertTimestamp,
  defaultFetch,
  fromUnix,
  hmacSha256,
  opt,
  parseJson,
  requestJson,
  requireHeader,
  secretList,
  toHex,
  type ProviderHttpOptions,
} from "./verify.ts";

/** Options for {@link createStripeProvider}. */
export interface StripeProviderOptions extends ProviderHttpOptions {
  /** Secret API key (`sk_…` / restricted `rk_…`). Required for REST calls (reconcile, checkout, portal, usage). */
  secretKey?: string;
  /** Endpoint signing secret(s) (`whsec_…`). Several during secret rolling. Required for webhooks. */
  webhookSecret?: string | readonly string[];
  /** Signature timestamp tolerance in seconds. Default `300`. */
  tolerance?: number;
  /** Metadata key carrying our customer id (checkout + customer objects). Default `"customerId"`. */
  metadataKey?: string;
  /** Pin a Stripe API version (`Stripe-Version` header) for REST calls. */
  apiVersion?: string;
  /** Clock (unix ms) for the tolerance check. Default `Date.now`. */
  now?: () => number;
}

/** The subset of a Stripe Subscription object the provider reads. */
export interface StripeSubscriptionObject {
  id: string;
  object?: string;
  customer: string | { id: string };
  status: string;
  items: {
    data: Array<{
      id: string;
      quantity?: number | null;
      price: { id: string } | string;
      current_period_start?: number | null;
      current_period_end?: number | null;
    }>;
  };
  current_period_start?: number | null;
  current_period_end?: number | null;
  trial_end?: number | null;
  cancel_at_period_end?: boolean | null;
  cancel_at?: number | null;
  canceled_at?: number | null;
  ended_at?: number | null;
  metadata?: Record<string, string> | null;
}

const STATUS: Record<string, SubscriptionStatus> = {
  active: "active",
  trialing: "trialing",
  past_due: "past_due",
  paused: "paused",
  canceled: "canceled",
  incomplete: "incomplete",
  unpaid: "paused",
  incomplete_expired: "canceled",
};

/** Map a Stripe subscription status to ours (unknown → `incomplete`). */
export const stripeStatus = (status: string): SubscriptionStatus => STATUS[status] ?? "incomplete";

const idOf = (v: string | { id: string } | null | undefined): string | undefined =>
  typeof v === "string" ? v : v?.id;

/**
 * Normalize a Stripe Subscription object. `updatedAt` is left unset (Stripe
 * subscriptions carry no update time); the intake orders by event time.
 */
export function normalizeStripeSubscription(sub: StripeSubscriptionObject): ProviderSubscription {
  const items = sub.items?.data ?? [];
  const first = items[0];
  const out: ProviderSubscription = {
    ref: sub.id,
    providerCustomer: idOf(sub.customer) ?? "",
    items: items.map((i) => ({
      id: idOf(i.price) ?? "",
      quantity: i.quantity ?? 1,
      itemRef: i.id,
    })),
    status: stripeStatus(sub.status),
  };
  const start = fromUnix(first?.current_period_start ?? sub.current_period_start);
  const end = fromUnix(first?.current_period_end ?? sub.current_period_end);
  if (start) out.periodStart = start;
  if (end) out.periodEnd = end;
  const trial = fromUnix(sub.trial_end);
  if (trial) out.trialEndsAt = trial;
  out.cancelAtPeriodEnd = !!sub.cancel_at_period_end || typeof sub.cancel_at === "number";
  if (typeof sub.cancel_at === "number" && !sub.cancel_at_period_end && !end) {
    out.periodEnd = fromUnix(sub.cancel_at)!;
  }
  const canceled = fromUnix(sub.canceled_at ?? sub.ended_at);
  if (canceled) out.canceledAt = canceled;
  if (sub.metadata && Object.keys(sub.metadata).length > 0) {
    out.metadata = { ...sub.metadata } as JsonObject;
  }
  return out;
}

interface StripeEvent {
  id: string;
  type: string;
  created?: number;
  data: { object: Record<string, unknown> };
}

/** Parse a `Stripe-Signature` header into its timestamp and `v1` signatures. */
export function parseStripeSignature(header: string): { timestamp: number; signatures: string[] } {
  let timestamp = Number.NaN;
  const signatures: string[] = [];
  for (const part of header.split(",")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    const key = part.slice(0, i).trim();
    const value = part.slice(i + 1).trim();
    if (key === "t" && /^\d+$/.test(value)) timestamp = Number(value);
    else if (key === "v1") signatures.push(value);
  }
  if (!Number.isFinite(timestamp) || signatures.length === 0) {
    throw new BillingVerificationError("Malformed Stripe-Signature header");
  }
  return { timestamp, signatures };
}

/**
 * Build a `Stripe-Signature` header for `body` (tests, local tooling).
 *
 * @example
 * ```ts
 * const header = await signStripePayload("whsec_test", body); // "t=…,v1=…"
 * ```
 */
export async function signStripePayload(
  secret: string,
  body: string,
  timestamp: number = Math.floor(Date.now() / 1000),
): Promise<string> {
  const v1 = toHex(await hmacSha256(secret, `${timestamp}.${body}`));
  return `t=${timestamp},v1=${v1}`;
}

/** Form-encode a nested object the way Stripe's API expects (`a[b][0][c]=…`). */
export function stripeForm(input: Record<string, unknown>): URLSearchParams {
  const params = new URLSearchParams();
  const walk = (prefix: string, value: unknown) => {
    if (value === undefined || value === null) return;
    if (Array.isArray(value)) value.forEach((v, i) => walk(`${prefix}[${i}]`, v));
    else if (typeof value === "object") {
      for (const [k, v] of Object.entries(value)) walk(`${prefix}[${k}]`, v);
    } else params.append(prefix, String(value));
  };
  for (const [k, v] of Object.entries(input)) walk(k, v);
  return params;
}

const SUBSCRIPTION_UPDATES = new Set([
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.paused",
  "customer.subscription.resumed",
  "customer.subscription.pending_update_applied",
  "customer.subscription.pending_update_expired",
  "customer.subscription.trial_will_end",
]);

/** Create the Stripe provider (`id: "stripe"`). */
export function createStripeProvider(options: StripeProviderOptions): BillingProvider {
  const fetchImpl = options.fetch ?? defaultFetch;
  const apiBase = (options.apiBase ?? "https://api.stripe.com").replace(/\/$/, "");
  const tolerance = options.tolerance ?? 300;
  const metadataKey = options.metadataKey ?? "customerId";
  const now = options.now ?? Date.now;

  const api = <T>(method: "GET" | "POST", path: string, form?: Record<string, unknown>) => {
    if (!options.secretKey) throw new Error("stripe: secretKey is required for API calls");
    const headers: Record<string, string> = { authorization: `Bearer ${options.secretKey}` };
    if (options.apiVersion) headers["stripe-version"] = options.apiVersion;
    const init: RequestInit = { method, headers };
    if (form) {
      headers["content-type"] = "application/x-www-form-urlencoded";
      init.body = stripeForm(form).toString();
    }
    return requestJson<T>("stripe", fetchImpl, `${apiBase}${path}`, init);
  };

  function toEvents(event: StripeEvent): BillingEvent[] {
    const object = event.data?.object ?? {};
    if (SUBSCRIPTION_UPDATES.has(event.type)) {
      return [
        {
          type: "subscription.updated",
          subscription: normalizeStripeSubscription(object as unknown as StripeSubscriptionObject),
        },
      ];
    }
    if (event.type === "customer.subscription.deleted") {
      return [
        {
          type: "subscription.deleted",
          subscription: normalizeStripeSubscription(object as unknown as StripeSubscriptionObject),
        },
      ];
    }
    if (event.type === "checkout.session.completed") {
      const s = object as {
        mode?: string;
        customer?: string | { id: string } | null;
        client_reference_id?: string | null;
        metadata?: Record<string, string> | null;
        customer_details?: { email?: string | null; name?: string | null } | null;
      };
      const providerCustomer = idOf(s.customer ?? undefined);
      const customer = opt(s.client_reference_id) ?? opt(s.metadata?.[metadataKey]);
      if (!providerCustomer || !customer) {
        return [{ type: "ignored", reason: "checkout session without customer reference" }];
      }
      const e: BillingEvent = { type: "customer.updated", providerCustomer, customer };
      const email = opt(s.customer_details?.email);
      if (email) e.email = email;
      return [e];
    }
    if (event.type === "customer.created" || event.type === "customer.updated") {
      const c = object as {
        id: string;
        email?: string | null;
        name?: string | null;
        metadata?: Record<string, string> | null;
      };
      const e: BillingEvent = { type: "customer.updated", providerCustomer: c.id };
      const customer = opt(c.metadata?.[metadataKey]);
      if (customer) e.customer = customer;
      if (opt(c.email)) e.email = c.email!;
      if (opt(c.name)) e.name = c.name!;
      return [e];
    }
    return [{ type: "ignored", reason: `unhandled event type ${event.type}` }];
  }

  const provider: BillingProvider = {
    id: "stripe",

    async parseWebhook(request: Request): Promise<BillingWebhook> {
      if (!options.webhookSecret) throw new Error("stripe: webhookSecret is required for webhooks");
      const secrets = secretList(options.webhookSecret, "stripe");
      const header = requireHeader(request, "stripe-signature");
      const body = await request.text();
      const { timestamp, signatures } = parseStripeSignature(header);
      const expected = await Promise.all(
        secrets.map(async (s) => toHex(await hmacSha256(s, `${timestamp}.${body}`))),
      );
      if (!anyMatch(signatures, expected)) {
        throw new BillingVerificationError("Stripe signature mismatch");
      }
      assertTimestamp(timestamp, now(), tolerance);
      const event = parseJson<StripeEvent>(body);
      if (typeof event.id !== "string" || typeof event.type !== "string") {
        throw new BillingVerificationError("Not a Stripe event");
      }
      const webhook: BillingWebhook = { id: event.id, type: event.type, events: toEvents(event) };
      const created = fromUnix(event.created);
      if (created) webhook.createdAt = created;
      return webhook;
    },

    async fetchSubscriptions(providerCustomer: string): Promise<ProviderSubscription[]> {
      const out: ProviderSubscription[] = [];
      let after: string | undefined;
      for (let page = 0; page < 50; page++) {
        const qs = new URLSearchParams({ customer: providerCustomer, status: "all", limit: "100" });
        if (after) qs.set("starting_after", after);
        const res = await api<{ data: StripeSubscriptionObject[]; has_more?: boolean }>(
          "GET",
          `/v1/subscriptions?${qs}`,
        );
        out.push(...res.data.map(normalizeStripeSubscription));
        if (!res.has_more || res.data.length === 0) break;
        after = res.data[res.data.length - 1]!.id;
      }
      return out;
    },

    async createCheckout(input: CheckoutInput): Promise<{ url: string }> {
      const form: Record<string, unknown> = {
        mode: "subscription",
        line_items: [{ price: input.item, quantity: input.quantity ?? 1 }],
        client_reference_id: input.customer,
        metadata: { [metadataKey]: input.customer },
        subscription_data: {
          metadata: { [metadataKey]: input.customer },
          ...(input.trialDays ? { trial_period_days: input.trialDays } : {}),
        },
        success_url: input.successUrl,
        cancel_url: input.cancelUrl,
      };
      if (input.providerCustomer) form.customer = input.providerCustomer;
      else if (input.email) form.customer_email = input.email;
      const session = await api<{ url?: string | null }>("POST", "/v1/checkout/sessions", form);
      if (!session?.url) throw new Error("stripe: checkout session has no url");
      return { url: session.url };
    },

    async createPortalSession(input: PortalSessionInput): Promise<{ url: string }> {
      const session = await api<{ url: string }>("POST", "/v1/billing_portal/sessions", {
        customer: input.providerCustomer,
        return_url: input.returnUrl,
      });
      return { url: session.url };
    },

    async reportUsage(records: UsageRecord[]): Promise<void> {
      const unlinked = new Set<string>();
      for (const r of records) {
        if (!r.providerCustomer) {
          unlinked.add(r.customer);
          continue;
        }
        await api("POST", "/v1/billing/meter_events", {
          event_name: r.meter,
          payload: { stripe_customer_id: r.providerCustomer, value: r.amount },
          timestamp: Math.floor(Date.parse(r.at) / 1000),
          identifier: r.idempotencyKey,
        });
      }
      if (unlinked.size > 0) {
        throw new Error(
          `stripe: no linked Stripe customer for ${[...unlinked].map((c) => `"${c}"`).join(", ")}; their meter events were not sent`,
        );
      }
    },
  };
  return provider;
}

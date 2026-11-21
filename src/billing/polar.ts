/**
 * Polar billing provider — no SDK, `fetch` + Web Crypto only (ADR 0007).
 *
 * - **Webhooks.** [Standard Webhooks](https://github.com/standard-webhooks/standard-webhooks/blob/main/spec/standard-webhooks.md):
 *   `webhook-id`, `webhook-timestamp` (unix seconds, default tolerance
 *   300 s) and `webhook-signature` (space-separated `v1,<base64>` entries),
 *   HMAC-SHA256 over `` `${id}.${timestamp}.${rawBody}` ``. Polar keys the
 *   HMAC in one of two ways depending on when the secret was generated, and
 *   both are tried (like Polar's own SDKs): the Standard Webhooks key
 *   (base64 after the `whsec_` prefix) and the legacy "Polar HMAC" key (the
 *   UTF-8 bytes of the whole secret string). The Standard Webhooks path is
 *   byte-compatible with `@xtandard/webhooks/receiver` (tested against it).
 *   Source: https://docs.polar.sh/integrate/webhooks/delivery
 * - **Events.** `subscription.created | updated | active | canceled |
 *   uncanceled | cycled | past_due | paused | resumed | migrated` →
 *   `subscription.updated`; `subscription.revoked` (access ends) →
 *   `subscription.deleted`; `customer.created | updated` → `customer.updated`
 *   (our id is the Polar customer's `external_id`). Everything else is
 *   `ignored`. The provider item id is the Polar **product** id; quantity is
 *   `seats` (seat-based pricing) or 1.
 *   Source: https://polar.sh/docs/api-reference (OpenAPI `Subscription`, `SubscriptionStatus`)
 * - **Status mapping.** `active`, `trialing`, `past_due`, `paused`,
 *   `canceled`, `incomplete` 1:1; `unpaid` → `paused`; `incomplete_expired`
 *   → `canceled`; `trial_ended` (trial over, not converted) → `incomplete`.
 * - **REST** (`https://api.polar.sh`, or `sandbox-api.polar.sh` with
 *   `server: "sandbox"`, `Authorization: Bearer <access token>`):
 *   `GET /v1/subscriptions/?customer_id=…` (reconcile), `POST /v1/checkouts/`
 *   (with `external_customer_id`), `POST /v1/customer-sessions/`
 *   (`customer_portal_url`), `POST /v1/events/ingest` (usage export — events
 *   named after the meter, keyed by `external_customer_id`, amount in
 *   `metadata[meterProperty]`).
 *
 * @example
 * ```ts
 * import { createPolarProvider } from "@xtandard/entitlements/billing/polar";
 *
 * const polar = createPolarProvider({
 *   accessToken: process.env.POLAR_ACCESS_TOKEN!,
 *   webhookSecret: process.env.POLAR_WEBHOOK_SECRET!,
 * });
 * ```
 *
 * @module billing/polar
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
  fromBase64,
  hmacSha256,
  opt,
  parseJson,
  requestJson,
  requireHeader,
  secretList,
  toBase64,
  type ProviderHttpOptions,
} from "./verify.ts";

/** Options for {@link createPolarProvider}. */
export interface PolarProviderOptions extends ProviderHttpOptions {
  /** Organization access token. Required for REST calls (reconcile, checkout, portal, usage). */
  accessToken?: string;
  /** Webhook secret(s) (`whsec_…` / `polar_whs_…`). Required for webhooks. */
  webhookSecret?: string | readonly string[];
  /** `"production"` (default) or `"sandbox"`. Ignored when `apiBase` is set. */
  server?: "production" | "sandbox";
  /** Signature timestamp tolerance in seconds. Default `300`. */
  tolerance?: number;
  /** Metadata key carrying our customer id (checkout metadata). Default `"customerId"`. */
  metadataKey?: string;
  /** Metadata property the Polar meter aggregates (usage export). Default `"value"`. */
  meterProperty?: string;
  /** Clock (unix ms) for the tolerance check. Default `Date.now`. */
  now?: () => number;
}

/** The subset of a Polar `Subscription` the provider reads. */
export interface PolarSubscriptionObject {
  id: string;
  status: string;
  customer_id: string;
  product_id: string;
  seats?: number | null;
  current_period_start?: string | null;
  current_period_end?: string | null;
  trial_end?: string | null;
  cancel_at_period_end?: boolean | null;
  canceled_at?: string | null;
  ended_at?: string | null;
  ends_at?: string | null;
  created_at?: string | null;
  modified_at?: string | null;
  metadata?: Record<string, string | number | boolean> | null;
  customer?: { id: string; external_id?: string | null; email?: string | null } | null;
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
  trial_ended: "incomplete",
};

/** Map a Polar subscription status to ours (unknown → `incomplete`). */
export const polarStatus = (status: string): SubscriptionStatus => STATUS[status] ?? "incomplete";

/** Normalize a Polar `Subscription`. */
export function normalizePolarSubscription(sub: PolarSubscriptionObject): ProviderSubscription {
  const out: ProviderSubscription = {
    ref: sub.id,
    providerCustomer: sub.customer_id,
    items: [{ id: sub.product_id, quantity: sub.seats ?? 1 }],
    status: polarStatus(sub.status),
    cancelAtPeriodEnd: !!sub.cancel_at_period_end,
  };
  const customer = opt(sub.customer?.external_id);
  if (customer) out.customer = customer;
  if (opt(sub.current_period_start)) out.periodStart = sub.current_period_start!;
  const end = opt(sub.current_period_end) ?? opt(sub.ends_at);
  if (end) out.periodEnd = end;
  if (opt(sub.trial_end)) out.trialEndsAt = sub.trial_end!;
  const canceled = opt(sub.canceled_at) ?? opt(sub.ended_at);
  if (canceled) out.canceledAt = canceled;
  const updated = opt(sub.modified_at) ?? opt(sub.created_at);
  if (updated) out.updatedAt = updated;
  if (sub.metadata && Object.keys(sub.metadata).length > 0) {
    out.metadata = { ...sub.metadata } as JsonObject;
  }
  return out;
}

/** HMAC keys a Polar secret may use: Standard Webhooks (base64 body) and legacy Polar HMAC (UTF-8). */
function polarKeys(secret: string): Uint8Array[] {
  const keys: Uint8Array[] = [new TextEncoder().encode(secret)];
  const body = secret.startsWith("whsec_") ? secret.slice("whsec_".length) : secret;
  const decoded = fromBase64(body);
  if (decoded && decoded.length > 0) keys.unshift(decoded);
  return keys;
}

/**
 * Build Standard Webhooks headers for `body` the way Polar signs it (tests,
 * local tooling). `legacy: true` signs with the pre-2026-09-08 "Polar HMAC" key.
 */
export async function signPolarPayload(
  secret: string,
  body: string,
  options: { id?: string; timestamp?: number; legacy?: boolean } = {},
): Promise<Record<"webhook-id" | "webhook-timestamp" | "webhook-signature", string>> {
  const id = options.id ?? `msg_${crypto.randomUUID()}`;
  const timestamp = options.timestamp ?? Math.floor(Date.now() / 1000);
  const keys = polarKeys(secret);
  const key = options.legacy ? keys[keys.length - 1]! : keys[0]!;
  const sig = toBase64(await hmacSha256(key, `${id}.${timestamp}.${body}`));
  return {
    "webhook-id": id,
    "webhook-timestamp": String(timestamp),
    "webhook-signature": `v1,${sig}`,
  };
}

const SUBSCRIPTION_UPDATES = new Set([
  "subscription.created",
  "subscription.updated",
  "subscription.active",
  "subscription.canceled",
  "subscription.uncanceled",
  "subscription.cycled",
  "subscription.past_due",
  "subscription.paused",
  "subscription.resumed",
  "subscription.migrated",
]);

interface PolarPayload {
  type: string;
  timestamp?: string;
  data: Record<string, unknown>;
}

/** Create the Polar provider (`id: "polar"`). */
export function createPolarProvider(options: PolarProviderOptions): BillingProvider {
  const fetchImpl = options.fetch ?? defaultFetch;
  const apiBase = (
    options.apiBase ??
    (options.server === "sandbox" ? "https://sandbox-api.polar.sh" : "https://api.polar.sh")
  ).replace(/\/$/, "");
  const tolerance = options.tolerance ?? 300;
  const metadataKey = options.metadataKey ?? "customerId";
  const meterProperty = options.meterProperty ?? "value";
  const now = options.now ?? Date.now;

  const api = <T>(method: "GET" | "POST", path: string, json?: unknown) => {
    if (!options.accessToken) throw new Error("polar: accessToken is required for API calls");
    const headers: Record<string, string> = {
      authorization: `Bearer ${options.accessToken}`,
      accept: "application/json",
    };
    const init: RequestInit = { method, headers };
    if (json !== undefined) {
      headers["content-type"] = "application/json";
      init.body = JSON.stringify(json);
    }
    return requestJson<T>("polar", fetchImpl, `${apiBase}${path}`, init);
  };

  function toEvents(payload: PolarPayload): BillingEvent[] {
    if (SUBSCRIPTION_UPDATES.has(payload.type) || payload.type === "subscription.revoked") {
      const subscription = normalizePolarSubscription(
        payload.data as unknown as PolarSubscriptionObject,
      );
      return [
        payload.type === "subscription.revoked"
          ? { type: "subscription.deleted", subscription }
          : { type: "subscription.updated", subscription },
      ];
    }
    if (payload.type === "customer.created" || payload.type === "customer.updated") {
      const c = payload.data as {
        id: string;
        external_id?: string | null;
        email?: string | null;
        name?: string | null;
      };
      const e: BillingEvent = { type: "customer.updated", providerCustomer: c.id };
      if (opt(c.external_id)) e.customer = c.external_id!;
      if (opt(c.email)) e.email = c.email!;
      if (opt(c.name)) e.name = c.name!;
      return [e];
    }
    return [{ type: "ignored", reason: `unhandled event type ${payload.type}` }];
  }

  return {
    id: "polar",

    async parseWebhook(request: Request): Promise<BillingWebhook> {
      if (!options.webhookSecret) throw new Error("polar: webhookSecret is required for webhooks");
      const secrets = secretList(options.webhookSecret, "polar");
      const id = requireHeader(request, "webhook-id");
      const timestampRaw = requireHeader(request, "webhook-timestamp");
      const header = requireHeader(request, "webhook-signature");
      const body = await request.text();
      if (!/^\d+$/.test(timestampRaw.trim())) {
        throw new BillingVerificationError(`Invalid webhook-timestamp "${timestampRaw}"`);
      }
      const timestamp = Number(timestampRaw);
      assertTimestamp(timestamp, now(), tolerance);
      const provided = header
        .split(" ")
        .map((s) => s.trim())
        .filter((s) => s.startsWith("v1,"))
        .map((s) => s.slice(3));
      if (provided.length === 0) throw new BillingVerificationError("No v1 signature");
      const content = `${id}.${timestamp}.${body}`;
      const expected = await Promise.all(
        secrets.flatMap(polarKeys).map(async (k) => toBase64(await hmacSha256(k, content))),
      );
      if (!anyMatch(provided, expected)) {
        throw new BillingVerificationError("Polar signature mismatch");
      }
      const payload = parseJson<PolarPayload>(body);
      if (typeof payload.type !== "string" || typeof payload.data !== "object" || !payload.data) {
        throw new BillingVerificationError("Not a Polar webhook payload");
      }
      const webhook: BillingWebhook = { id, type: payload.type, events: toEvents(payload) };
      if (opt(payload.timestamp)) webhook.createdAt = payload.timestamp!;
      return webhook;
    },

    async fetchSubscriptions(providerCustomer: string): Promise<ProviderSubscription[]> {
      const out: ProviderSubscription[] = [];
      for (let page = 1; page <= 50; page++) {
        const qs = new URLSearchParams({
          customer_id: providerCustomer,
          limit: "100",
          page: String(page),
        });
        const res = await api<{
          items: PolarSubscriptionObject[];
          pagination?: { max_page?: number };
        }>("GET", `/v1/subscriptions/?${qs}`);
        out.push(...res.items.map(normalizePolarSubscription));
        if (page >= (res.pagination?.max_page ?? 1) || res.items.length === 0) break;
      }
      return out;
    },

    async createCheckout(input: CheckoutInput): Promise<{ url: string }> {
      const body: Record<string, unknown> = {
        products: [input.item],
        external_customer_id: input.customer,
        metadata: { [metadataKey]: input.customer },
      };
      if (input.providerCustomer) body.customer_id = input.providerCustomer;
      if (input.email) body.customer_email = input.email;
      if (input.successUrl) body.success_url = input.successUrl;
      if (input.cancelUrl) body.return_url = input.cancelUrl;
      if (input.quantity !== undefined && input.quantity > 1) body.seats = input.quantity;
      if (input.trialDays) {
        body.trial_interval = "day";
        body.trial_interval_count = input.trialDays;
      }
      const checkout = await api<{ url: string }>("POST", "/v1/checkouts/", body);
      return { url: checkout.url };
    },

    async createPortalSession(input: PortalSessionInput): Promise<{ url: string }> {
      const body: Record<string, unknown> = { customer_id: input.providerCustomer };
      if (input.returnUrl) body.return_url = input.returnUrl;
      const session = await api<{ customer_portal_url: string }>(
        "POST",
        "/v1/customer-sessions/",
        body,
      );
      return { url: session.customer_portal_url };
    },

    async reportUsage(records: UsageRecord[]): Promise<void> {
      if (records.length === 0) return;
      await api("POST", "/v1/events/ingest", {
        events: records.map((r) => ({
          name: r.meter,
          external_customer_id: r.customer,
          timestamp: r.at,
          ...(r.idempotencyKey ? { external_id: r.idempotencyKey } : {}),
          metadata: { [meterProperty]: r.amount, feature: r.feature },
        })),
      });
    },
  };
}

/**
 * Paddle Billing provider — no SDK, `fetch` + Web Crypto only (ADR 0007).
 *
 * - **Webhooks.** `Paddle-Signature: ts=<unix seconds>;h1=<hex>` (several
 *   `h1` during secret rotation): HMAC-SHA256 (hex) of `` `${ts}:${rawBody}` ``
 *   keyed with the notification destination's secret key. The timestamp must
 *   be within the tolerance — default **5 s**, the window Paddle's own SDK
 *   enforces; raise it if your clock or queue adds latency.
 *   Sources: https://developer.paddle.com/webhooks/signature-verification,
 *   https://github.com/PaddleHQ/paddle-node-sdk/blob/main/src/notifications/helpers/webhooks-validator.ts
 * - **Events** (`{ event_id, event_type, occurred_at, data }`).
 *   `subscription.created | updated | activated | trialing | past_due |
 *   paused | resumed | imported` → `subscription.updated`;
 *   `subscription.canceled` (Paddle cancellations are final) →
 *   `subscription.deleted`; `customer.created | updated` → `customer.updated`
 *   (our id from `custom_data[metadataKey]`). Everything else is `ignored`.
 *   The provider item id is the Paddle **price** id (`pri_…`).
 *   Source: https://developer.paddle.com/webhooks/subscriptions/subscription-updated
 * - **Status mapping.** `active`, `trialing`, `past_due`, `paused`,
 *   `canceled` 1:1. A scheduled change with `action: "cancel"` →
 *   `cancelAtPeriodEnd`.
 * - **REST** (`https://api.paddle.com`, or `sandbox-api.paddle.com` with
 *   `environment: "sandbox"`, `Authorization: Bearer <API key>`):
 *   `GET /subscriptions?customer_id=…` (reconcile), `POST /transactions`
 *   (checkout link — requires a default payment link in Paddle → Checkout
 *   settings), `POST /customers/{id}/portal-sessions` (customer portal).
 *   Paddle has no usage meters, so there is no `reportUsage`.
 *
 * @example
 * ```ts
 * import { createPaddleProvider } from "@xtandard/entitlements/billing/paddle";
 *
 * const paddle = createPaddleProvider({
 *   apiKey: process.env.PADDLE_API_KEY!,
 *   webhookSecret: process.env.PADDLE_WEBHOOK_SECRET!,
 * });
 * ```
 *
 * @module billing/paddle
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
} from "./contract.ts";
import {
  anyMatch,
  assertTimestamp,
  defaultFetch,
  hmacSha256,
  opt,
  parseJson,
  requestJson,
  requireHeader,
  secretList,
  toHex,
  type ProviderHttpOptions,
} from "./verify.ts";

/** Options for {@link createPaddleProvider}. */
export interface PaddleProviderOptions extends ProviderHttpOptions {
  /** API key. Required for REST calls (reconcile, checkout, portal). */
  apiKey?: string;
  /** Notification destination secret key(s). Required for webhooks. */
  webhookSecret?: string | readonly string[];
  /** `"production"` (default) or `"sandbox"`. Ignored when `apiBase` is set. */
  environment?: "production" | "sandbox";
  /** Signature timestamp tolerance in seconds. Default `5` (Paddle SDK). */
  tolerance?: number;
  /** `custom_data` key carrying our customer id. Default `"customerId"`. */
  metadataKey?: string;
  /** Clock (unix ms) for the tolerance check. Default `Date.now`. */
  now?: () => number;
}

/** The subset of a Paddle `subscription` entity the provider reads. */
export interface PaddleSubscriptionObject {
  id: string;
  status: string;
  customer_id: string;
  items: Array<{
    status?: string;
    quantity: number;
    price: { id: string };
    trial_dates?: { starts_at?: string | null; ends_at?: string | null } | null;
  }>;
  current_billing_period?: { starts_at?: string | null; ends_at?: string | null } | null;
  scheduled_change?: { action: string; effective_at?: string | null } | null;
  canceled_at?: string | null;
  updated_at?: string | null;
  created_at?: string | null;
  custom_data?: Record<string, unknown> | null;
}

const STATUS: Record<string, SubscriptionStatus> = {
  active: "active",
  trialing: "trialing",
  past_due: "past_due",
  paused: "paused",
  canceled: "canceled",
};

/** Map a Paddle subscription status to ours (unknown → `incomplete`). */
export const paddleStatus = (status: string): SubscriptionStatus => STATUS[status] ?? "incomplete";

/** Normalize a Paddle `subscription` entity. */
export function normalizePaddleSubscription(sub: PaddleSubscriptionObject): ProviderSubscription {
  const items = (sub.items ?? []).filter((i) => i.status !== "inactive");
  const out: ProviderSubscription = {
    ref: sub.id,
    providerCustomer: sub.customer_id,
    items: items.map((i) => ({ id: i.price.id, quantity: i.quantity ?? 1 })),
    status: paddleStatus(sub.status),
    cancelAtPeriodEnd: sub.scheduled_change?.action === "cancel",
  };
  if (opt(sub.current_billing_period?.starts_at)) {
    out.periodStart = sub.current_billing_period!.starts_at!;
  }
  const end =
    opt(sub.current_billing_period?.ends_at) ??
    (sub.scheduled_change?.action === "cancel"
      ? opt(sub.scheduled_change.effective_at)
      : undefined);
  if (end) out.periodEnd = end;
  const trial = items.map((i) => opt(i.trial_dates?.ends_at)).find(Boolean);
  if (trial) out.trialEndsAt = trial;
  if (opt(sub.canceled_at)) out.canceledAt = sub.canceled_at!;
  const updated = opt(sub.updated_at) ?? opt(sub.created_at);
  if (updated) out.updatedAt = updated;
  if (sub.custom_data && Object.keys(sub.custom_data).length > 0) {
    out.metadata = { ...sub.custom_data } as JsonObject;
  }
  return out;
}

/** Parse a `Paddle-Signature` header. */
export function parsePaddleSignature(header: string): { timestamp: number; signatures: string[] } {
  let timestamp = Number.NaN;
  const signatures: string[] = [];
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    const key = part.slice(0, i).trim();
    const value = part.slice(i + 1).trim();
    if (key === "ts" && /^\d+$/.test(value)) timestamp = Number(value);
    else if (key === "h1" && value) signatures.push(value);
  }
  if (!Number.isFinite(timestamp) || signatures.length === 0) {
    throw new BillingVerificationError("Malformed Paddle-Signature header");
  }
  return { timestamp, signatures };
}

/** Build a `Paddle-Signature` header for `body` (tests, local tooling). */
export async function signPaddlePayload(
  secret: string,
  body: string,
  timestamp: number = Math.floor(Date.now() / 1000),
): Promise<string> {
  return `ts=${timestamp};h1=${toHex(await hmacSha256(secret, `${timestamp}:${body}`))}`;
}

const SUBSCRIPTION_UPDATES = new Set([
  "subscription.created",
  "subscription.updated",
  "subscription.activated",
  "subscription.trialing",
  "subscription.past_due",
  "subscription.paused",
  "subscription.resumed",
  "subscription.imported",
]);

interface PaddleEvent {
  event_id: string;
  event_type: string;
  occurred_at?: string;
  data: Record<string, unknown>;
}

/** Create the Paddle provider (`id: "paddle"`). */
export function createPaddleProvider(options: PaddleProviderOptions): BillingProvider {
  const fetchImpl = options.fetch ?? defaultFetch;
  const apiBase = (
    options.apiBase ??
    (options.environment === "sandbox"
      ? "https://sandbox-api.paddle.com"
      : "https://api.paddle.com")
  ).replace(/\/$/, "");
  const tolerance = options.tolerance ?? 5;
  const metadataKey = options.metadataKey ?? "customerId";
  const now = options.now ?? Date.now;

  const api = <T>(method: "GET" | "POST", pathOrUrl: string, json?: unknown) => {
    if (!options.apiKey) throw new Error("paddle: apiKey is required for API calls");
    const headers: Record<string, string> = { authorization: `Bearer ${options.apiKey}` };
    const init: RequestInit = { method, headers };
    if (json !== undefined) {
      headers["content-type"] = "application/json";
      init.body = JSON.stringify(json);
    }
    const url = pathOrUrl.startsWith("http") ? pathOrUrl : `${apiBase}${pathOrUrl}`;
    return requestJson<T>("paddle", fetchImpl, url, init);
  };

  function toEvents(event: PaddleEvent): BillingEvent[] {
    if (
      SUBSCRIPTION_UPDATES.has(event.event_type) ||
      event.event_type === "subscription.canceled"
    ) {
      const subscription = normalizePaddleSubscription(
        event.data as unknown as PaddleSubscriptionObject,
      );
      return [
        event.event_type === "subscription.canceled"
          ? { type: "subscription.deleted", subscription }
          : { type: "subscription.updated", subscription },
      ];
    }
    if (event.event_type === "customer.created" || event.event_type === "customer.updated") {
      const c = event.data as {
        id: string;
        email?: string | null;
        name?: string | null;
        custom_data?: Record<string, unknown> | null;
      };
      const e: BillingEvent = { type: "customer.updated", providerCustomer: c.id };
      const customer = c.custom_data?.[metadataKey];
      if (typeof customer === "string" && customer) e.customer = customer;
      if (opt(c.email)) e.email = c.email!;
      if (opt(c.name)) e.name = c.name!;
      return [e];
    }
    return [{ type: "ignored", reason: `unhandled event type ${event.event_type}` }];
  }

  return {
    id: "paddle",

    async parseWebhook(request: Request): Promise<BillingWebhook> {
      if (!options.webhookSecret) throw new Error("paddle: webhookSecret is required for webhooks");
      const secrets = secretList(options.webhookSecret, "paddle");
      const header = requireHeader(request, "paddle-signature");
      const body = await request.text();
      const { timestamp, signatures } = parsePaddleSignature(header);
      const expected = await Promise.all(
        secrets.map(async (s) => toHex(await hmacSha256(s, `${timestamp}:${body}`))),
      );
      if (!anyMatch(signatures, expected)) {
        throw new BillingVerificationError("Paddle signature mismatch");
      }
      assertTimestamp(timestamp, now(), tolerance);
      const event = parseJson<PaddleEvent>(body);
      if (typeof event.event_id !== "string" || typeof event.event_type !== "string") {
        throw new BillingVerificationError("Not a Paddle notification");
      }
      const webhook: BillingWebhook = {
        id: event.event_id,
        type: event.event_type,
        events: toEvents(event),
      };
      if (opt(event.occurred_at)) webhook.createdAt = event.occurred_at!;
      return webhook;
    },

    async fetchSubscriptions(providerCustomer: string): Promise<ProviderSubscription[]> {
      const out: ProviderSubscription[] = [];
      let next: string | undefined =
        `/subscriptions?${new URLSearchParams({ customer_id: providerCustomer, per_page: "200" })}`;
      for (let page = 0; next && page < 50; page++) {
        const res: {
          data: PaddleSubscriptionObject[];
          meta?: { pagination?: { next?: string | null; has_more?: boolean } };
        } = await api("GET", next);
        out.push(...res.data.map(normalizePaddleSubscription));
        const p = res.meta?.pagination;
        next = p?.has_more && p.next ? p.next : undefined;
      }
      return out;
    },

    async createCheckout(input: CheckoutInput): Promise<{ url: string }> {
      const body: Record<string, unknown> = {
        items: [{ price_id: input.item, quantity: input.quantity ?? 1 }],
        custom_data: { [metadataKey]: input.customer },
      };
      if (input.providerCustomer) body.customer_id = input.providerCustomer;
      const res = await api<{ data: { checkout?: { url?: string | null } | null } }>(
        "POST",
        "/transactions",
        body,
      );
      const url = res.data?.checkout?.url;
      if (!url) {
        throw new Error(
          "paddle: the transaction has no checkout url (set a default payment link in Paddle → Checkout settings)",
        );
      }
      return { url };
    },

    async createPortalSession(input: PortalSessionInput): Promise<{ url: string }> {
      const res = await api<{ data: { urls: { general: { overview: string } } } }>(
        "POST",
        `/customers/${encodeURIComponent(input.providerCustomer)}/portal-sessions`,
        {},
      );
      return { url: res.data.urls.general.overview };
    },
  };
}

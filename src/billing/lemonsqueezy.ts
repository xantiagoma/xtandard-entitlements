/**
 * Lemon Squeezy billing provider — no SDK, `fetch` + Web Crypto only (ADR 0007).
 *
 * - **Webhooks.** `X-Signature`: HMAC-SHA256 (hex) of the raw body keyed
 *   with the webhook's signing secret. Lemon Squeezy signs no timestamp, so
 *   there is no replay window to check — duplicate deliveries are caught by
 *   the intake's idempotency claim (the event id is the SHA-256 of the body,
 *   since payloads carry no event id).
 *   Source: https://docs.lemonsqueezy.com/help/webhooks/signing-requests
 * - **Events** (`meta.event_name`, our id in `meta.custom_data[metadataKey]`
 *   from checkout custom data). `subscription_created | updated | cancelled
 *   | resumed | paused | unpaused | plan_changed` → `subscription.updated`;
 *   `subscription_expired` → `subscription.deleted`; invoice events
 *   (`subscription_payment_*`, `data.type = "subscription-invoices"`) and
 *   everything else → `ignored`. The provider item id is the **variant** id.
 *   Source: https://docs.lemonsqueezy.com/api/subscriptions/the-subscription-object
 * - **Status mapping.** `on_trial` → `trialing`; `active`, `paused`,
 *   `past_due` 1:1; `unpaid` → `paused`; `cancelled` (still in its grace
 *   period until `ends_at`) → `active` + `cancelAtPeriodEnd` with
 *   `periodEnd = ends_at`; `expired` → `canceled`.
 * - **REST** (`https://api.lemonsqueezy.com`, JSON:API, `Authorization:
 *   Bearer <API key>`): `GET /v1/customers/{id}/subscriptions` (reconcile),
 *   `POST /v1/checkouts` (needs `storeId`), `GET /v1/customers/{id}`
 *   (`urls.customer_portal`). Usage records need a subscription-item id,
 *   which a `UsageRecord` does not carry, so there is no `reportUsage`.
 *
 * @example
 * ```ts
 * import { createLemonSqueezyProvider } from "@xtandard/entitlements/billing/lemonsqueezy";
 *
 * const lemonsqueezy = createLemonSqueezyProvider({
 *   apiKey: process.env.LEMONSQUEEZY_API_KEY!,
 *   webhookSecret: process.env.LEMONSQUEEZY_WEBHOOK_SECRET!,
 *   storeId: "12345",
 * });
 * ```
 *
 * @module billing/lemonsqueezy
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
  defaultFetch,
  hmacSha256,
  opt,
  parseJson,
  requestJson,
  requireHeader,
  secretList,
  sha256Hex,
  toHex,
  type ProviderHttpOptions,
} from "./verify.ts";

/** Options for {@link createLemonSqueezyProvider}. */
export interface LemonSqueezyProviderOptions extends ProviderHttpOptions {
  /** API key. Required for REST calls (reconcile, checkout, portal). */
  apiKey?: string;
  /** Webhook signing secret(s). Required for webhooks. */
  webhookSecret?: string | readonly string[];
  /** Store id — required for checkouts. */
  storeId?: string | number;
  /** `custom_data` key carrying our customer id. Default `"customerId"`. */
  metadataKey?: string;
}

/** A Lemon Squeezy subscription resource (JSON:API `data`). */
export interface LemonSqueezySubscriptionObject {
  type: "subscriptions";
  id: string | number;
  attributes: {
    customer_id: number | string;
    variant_id: number | string;
    status: string;
    trial_ends_at?: string | null;
    renews_at?: string | null;
    ends_at?: string | null;
    created_at?: string | null;
    updated_at?: string | null;
    cancelled?: boolean;
    first_subscription_item?: { id: number | string; quantity?: number | null } | null;
  };
}

/** Map a Lemon Squeezy status to ours (unknown → `incomplete`). */
export function lemonSqueezyStatus(status: string): SubscriptionStatus {
  switch (status) {
    case "on_trial":
      return "trialing";
    case "active":
    case "cancelled":
      return "active";
    case "paused":
    case "unpaid":
      return "paused";
    case "past_due":
      return "past_due";
    case "expired":
      return "canceled";
    default:
      return "incomplete";
  }
}

/** Normalize a Lemon Squeezy subscription resource (+ webhook `custom_data`). */
export function normalizeLemonSqueezySubscription(
  sub: LemonSqueezySubscriptionObject,
  customData?: Record<string, unknown> | null,
): ProviderSubscription {
  const a = sub.attributes;
  const item = a.first_subscription_item;
  const cancelled = a.status === "cancelled" || a.cancelled === true;
  const out: ProviderSubscription = {
    ref: String(sub.id),
    providerCustomer: String(a.customer_id),
    items: [
      {
        id: String(a.variant_id),
        quantity: item?.quantity ?? 1,
        ...(item?.id !== undefined && item.id !== null ? { itemRef: String(item.id) } : {}),
      },
    ],
    status: lemonSqueezyStatus(a.status),
    cancelAtPeriodEnd: cancelled && a.status !== "expired",
  };
  const end =
    cancelled || a.status === "expired" ? (opt(a.ends_at) ?? opt(a.renews_at)) : opt(a.renews_at);
  if (end) out.periodEnd = end;
  if (opt(a.trial_ends_at)) out.trialEndsAt = a.trial_ends_at!;
  if (a.status === "expired" && opt(a.ends_at)) out.canceledAt = a.ends_at!;
  const updated = opt(a.updated_at) ?? opt(a.created_at);
  if (updated) out.updatedAt = updated;
  if (customData && Object.keys(customData).length > 0) {
    out.metadata = { ...customData } as JsonObject;
  }
  return out;
}

/** Build the `X-Signature` header value for `body` (tests, local tooling). */
export async function signLemonSqueezyPayload(secret: string, body: string): Promise<string> {
  return toHex(await hmacSha256(secret, body));
}

const SUBSCRIPTION_UPDATES = new Set([
  "subscription_created",
  "subscription_updated",
  "subscription_cancelled",
  "subscription_resumed",
  "subscription_paused",
  "subscription_unpaused",
  "subscription_plan_changed",
]);

interface LemonSqueezyPayload {
  meta: { event_name: string; custom_data?: Record<string, unknown> | null };
  data: { type: string; id: string | number; attributes: Record<string, unknown> };
}

/** Create the Lemon Squeezy provider (`id: "lemonsqueezy"`). */
export function createLemonSqueezyProvider(options: LemonSqueezyProviderOptions): BillingProvider {
  const fetchImpl = options.fetch ?? defaultFetch;
  const apiBase = (options.apiBase ?? "https://api.lemonsqueezy.com").replace(/\/$/, "");

  const api = <T>(method: "GET" | "POST", pathOrUrl: string, json?: unknown) => {
    if (!options.apiKey) throw new Error("lemonsqueezy: apiKey is required for API calls");
    const headers: Record<string, string> = {
      authorization: `Bearer ${options.apiKey}`,
      accept: "application/vnd.api+json",
    };
    const init: RequestInit = { method, headers };
    if (json !== undefined) {
      headers["content-type"] = "application/vnd.api+json";
      init.body = JSON.stringify(json);
    }
    const url = pathOrUrl.startsWith("http") ? pathOrUrl : `${apiBase}${pathOrUrl}`;
    return requestJson<T>("lemonsqueezy", fetchImpl, url, init);
  };

  function toEvents(payload: LemonSqueezyPayload): BillingEvent[] {
    const name = payload.meta.event_name;
    const isSubscription = payload.data?.type === "subscriptions";
    if (isSubscription && (SUBSCRIPTION_UPDATES.has(name) || name === "subscription_expired")) {
      const subscription = normalizeLemonSqueezySubscription(
        payload.data as unknown as LemonSqueezySubscriptionObject,
        payload.meta.custom_data,
      );
      return [
        name === "subscription_expired"
          ? { type: "subscription.deleted", subscription }
          : { type: "subscription.updated", subscription },
      ];
    }
    return [{ type: "ignored", reason: `unhandled event ${name}` }];
  }

  const provider: BillingProvider = {
    id: "lemonsqueezy",

    async parseWebhook(request: Request): Promise<BillingWebhook> {
      if (!options.webhookSecret) {
        throw new Error("lemonsqueezy: webhookSecret is required for webhooks");
      }
      const secrets = secretList(options.webhookSecret, "lemonsqueezy");
      const signature = requireHeader(request, "x-signature");
      const body = await request.text();
      const expected = await Promise.all(
        secrets.map(async (s) => toHex(await hmacSha256(s, body))),
      );
      if (!anyMatch([signature.trim().toLowerCase()], expected)) {
        throw new BillingVerificationError("Lemon Squeezy signature mismatch");
      }
      const payload = parseJson<LemonSqueezyPayload>(body);
      if (typeof payload.meta?.event_name !== "string" || typeof payload.data !== "object") {
        throw new BillingVerificationError("Not a Lemon Squeezy webhook payload");
      }
      const webhook: BillingWebhook = {
        id: `ls_${await sha256Hex(body)}`,
        type: payload.meta.event_name,
        events: toEvents(payload),
      };
      const updated = opt(payload.data.attributes?.updated_at as string | undefined);
      if (updated) webhook.createdAt = updated;
      return webhook;
    },

    async fetchSubscriptions(providerCustomer: string): Promise<ProviderSubscription[]> {
      const out: ProviderSubscription[] = [];
      let next: string | undefined =
        `/v1/customers/${encodeURIComponent(providerCustomer)}/subscriptions?page[size]=100`;
      for (let page = 0; next && page < 50; page++) {
        const res: { data: LemonSqueezySubscriptionObject[]; links?: { next?: string | null } } =
          await api("GET", next);
        out.push(...res.data.map((s) => normalizeLemonSqueezySubscription(s)));
        next = res.links?.next ?? undefined;
      }
      return out;
    },

    async createCheckout(input: CheckoutInput): Promise<{ url: string }> {
      if (options.storeId === undefined) throw new Error("lemonsqueezy: storeId is required");
      const res = await api<{ data: { attributes: { url: string } } }>("POST", "/v1/checkouts", {
        data: {
          type: "checkouts",
          attributes: {
            checkout_data: {
              ...(input.email ? { email: input.email } : {}),
              custom: { [options.metadataKey ?? "customerId"]: input.customer },
              ...(input.quantity !== undefined && input.quantity > 1
                ? {
                    variant_quantities: [
                      { variant_id: Number(input.item), quantity: input.quantity },
                    ],
                  }
                : {}),
            },
            ...(input.successUrl ? { product_options: { redirect_url: input.successUrl } } : {}),
          },
          relationships: {
            store: { data: { type: "stores", id: String(options.storeId) } },
            variant: { data: { type: "variants", id: String(input.item) } },
          },
        },
      });
      return { url: res.data.attributes.url };
    },

    async createPortalSession(input: PortalSessionInput): Promise<{ url: string }> {
      const res = await api<{ data: { attributes: { urls: { customer_portal: string } } } }>(
        "GET",
        `/v1/customers/${encodeURIComponent(input.providerCustomer)}`,
      );
      return { url: res.data.attributes.urls.customer_portal };
    },
  };
  return provider;
}

/**
 * Realistic Stripe webhook events (shapes from https://docs.stripe.com/api/events
 * and https://docs.stripe.com/api/subscriptions/object, trimmed to the fields the
 * provider reads), signed locally exactly like Stripe signs them
 * (`Stripe-Signature: t=…,v1=HMAC-SHA256(t.body)`). No network, no Stripe account.
 */
import { signStripePayload } from "@xtandard/entitlements/billing/stripe";
import { PRICES } from "../../shared/catalog.ts";

/** The endpoint signing secret (`whsec_…`) the panel verifies with. */
export const WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET ?? "whsec_local_demo_secret";

const DAY = 86_400;

/** One subscription item: a price and a quantity. */
export interface Item {
  price: string;
  quantity?: number;
}

/** A Stripe `subscription` object. */
export function subscription(input: {
  id: string;
  customer: string;
  /** Our customer id, carried in subscription metadata (`metadata.customerId`). */
  org?: string;
  status: "trialing" | "active" | "past_due" | "canceled" | "unpaid";
  items: Item[];
  start: number;
  trialDays?: number;
  cancelAtPeriodEnd?: boolean;
}) {
  const periodEnd = input.start + 30 * DAY;
  return {
    id: input.id,
    object: "subscription",
    customer: input.customer,
    status: input.status,
    items: {
      object: "list",
      data: input.items.map((item, i) => ({
        id: `si_${input.id.slice(4)}_${i}`,
        object: "subscription_item",
        price: { id: item.price, object: "price" },
        quantity: item.quantity ?? 1,
        current_period_start: input.start,
        current_period_end: periodEnd,
      })),
    },
    trial_end: input.trialDays ? input.start + input.trialDays * DAY : null,
    cancel_at_period_end: input.cancelAtPeriodEnd ?? false,
    canceled_at: input.status === "canceled" ? input.start : null,
    metadata: input.org ? { customerId: input.org } : {},
  };
}

/** A Stripe `event` envelope. */
export function event(id: string, type: string, created: number, object: unknown) {
  return { id, object: "event", type, created, livemode: false, data: { object } };
}

/** A signed webhook `Request` for `body` (as Stripe would POST it). */
export async function signedRequest(
  url: string,
  body: unknown,
  options: { secret?: string; timestamp?: number } = {},
): Promise<Request> {
  const raw = JSON.stringify(body);
  const signature = await signStripePayload(
    options.secret ?? WEBHOOK_SECRET,
    raw,
    options.timestamp,
  );
  return new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json", "stripe-signature": signature },
    body: raw,
  });
}

/**
 * The story the demo and `send.ts` replay for one customer, in order:
 * checkout → trial → paid → upgrade + add-on seats → cancellation.
 */
export function lifecycle(org: string, now = Math.floor(Date.now() / 1000)) {
  const sub = `sub_${org}`;
  const cus = `cus_${org}`;
  const base = { id: sub, customer: cus, start: now };
  return [
    {
      label: "checkout.session.completed — links cus_… to our customer",
      event: event(`evt_${org}_1`, "checkout.session.completed", now, {
        id: `cs_${org}`,
        object: "checkout.session",
        mode: "subscription",
        customer: cus,
        client_reference_id: org,
        subscription: sub,
        customer_details: { email: `billing@${org}.test`, name: null },
      }),
    },
    {
      label: "customer.subscription.created — Pro, trialing (14 days)",
      event: event(
        `evt_${org}_2`,
        "customer.subscription.created",
        now + 1,
        subscription({
          ...base,
          status: "trialing",
          trialDays: 14,
          items: [{ price: PRICES.pro }],
        }),
      ),
    },
    {
      label: "customer.subscription.updated — trial converted, active",
      event: event(
        `evt_${org}_3`,
        "customer.subscription.updated",
        now + 2,
        subscription({ ...base, status: "active", items: [{ price: PRICES.pro }] }),
      ),
    },
    {
      label: "customer.subscription.updated — upgrade to Business + 2× extra seats",
      event: event(
        `evt_${org}_4`,
        "customer.subscription.updated",
        now + 3,
        subscription({
          ...base,
          status: "active",
          items: [{ price: PRICES.business }, { price: PRICES.extraSeats, quantity: 2 }],
        }),
      ),
    },
    {
      label: "customer.subscription.deleted — canceled",
      event: event(
        `evt_${org}_5`,
        "customer.subscription.deleted",
        now + 4,
        subscription({
          ...base,
          status: "canceled",
          items: [{ price: PRICES.business }, { price: PRICES.extraSeats, quantity: 2 }],
        }),
      ),
    },
  ];
}

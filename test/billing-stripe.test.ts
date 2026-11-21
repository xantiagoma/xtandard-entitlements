import { describe, expect, test } from "vitest";
import { BillingVerificationError } from "../src/billing/contract.ts";
import {
  createStripeProvider,
  normalizeStripeSubscription,
  parseStripeSignature,
  signStripePayload,
  stripeForm,
  stripeStatus,
} from "../src/billing/stripe.ts";
import { BillingApiError } from "../src/billing/verify.ts";
import { fakeFetch, stripeSubscription, type SubState } from "./billing-fixtures.ts";

const NOW = Date.parse("2026-11-20T10:00:00Z");
const SECRET = "whsec_stripe_test_secret";
const state: SubState = {
  ref: "sub_1",
  providerCustomer: "cus_1",
  customer: "org_1",
  status: "active",
  items: [{ id: "price_pro_m", quantity: 1, itemRef: "si_1" }],
  periodStart: "2026-11-20T10:00:00.000Z",
  periodEnd: "2026-12-20T10:00:00.000Z",
  updatedAt: "2026-11-20T10:00:00.000Z",
};

async function signed(event: unknown, secret = SECRET, t = Math.floor(NOW / 1000)) {
  const body = JSON.stringify(event);
  return new Request("https://app/webhooks/stripe", {
    method: "POST",
    headers: { "stripe-signature": await signStripePayload(secret, body, t) },
    body,
  });
}

const provider = (o: Parameters<typeof createStripeProvider>[0] = {}) =>
  createStripeProvider({ webhookSecret: SECRET, now: () => NOW, ...o });

describe("stripe webhooks", () => {
  test("verifies, accepts any v1 (rolling secrets) and ignores v0 / debug entries", async () => {
    const body = JSON.stringify({
      id: "evt_1",
      type: "customer.subscription.created",
      created: 1_795_000_000,
      data: { object: stripeSubscription(state) },
    });
    const t = Math.floor(NOW / 1000);
    const good = (await signStripePayload("whsec_new", body, t)).split(",")[1];
    const header = `t=${t},v1=deadbeef,${good},v0=abc,secret=whsec_****x,destination=we_1,payload=a2`;
    const p = provider({ webhookSecret: ["whsec_old", "whsec_new"] });
    const w = await p.parseWebhook!(
      new Request("https://x", { method: "POST", headers: { "stripe-signature": header }, body }),
    );
    expect(w).toMatchObject({
      id: "evt_1",
      type: "customer.subscription.created",
      createdAt: new Date(1_795_000_000_000).toISOString(),
      events: [{ type: "subscription.updated", subscription: { ref: "sub_1", status: "active" } }],
    });
  });

  test("rejects missing / malformed headers, wrong secrets, stale timestamps and junk bodies", async () => {
    const p = provider();
    const bad = (headers: Record<string, string>, body = "{}") =>
      p.parseWebhook!(new Request("https://x", { method: "POST", headers, body }));
    await expect(bad({})).rejects.toThrow(/Missing stripe-signature/);
    await expect(bad({ "stripe-signature": "t=abc,v1=x" })).rejects.toThrow(/Malformed/);
    await expect(bad({ "stripe-signature": "v1=x" })).rejects.toThrow(/Malformed/);
    await expect(p.parseWebhook!(await signed({ id: "e" }, "whsec_other"))).rejects.toThrow(
      /mismatch/,
    );
    await expect(
      p.parseWebhook!(await signed({ id: "e", type: "x" }, SECRET, Math.floor(NOW / 1000) + 400)),
    ).rejects.toThrow(/tolerance/);
    await expect(p.parseWebhook!(await signed("text"))).rejects.toBeInstanceOf(
      BillingVerificationError,
    );
    await expect(p.parseWebhook!(await signed({ hello: 1 }))).rejects.toThrow(/Not a Stripe event/);
    // tolerance 0 disables the recency check
    const lax = provider({ tolerance: 0 });
    const w = await lax.parseWebhook!(
      await signed({ id: "e", type: "ping", data: { object: {} } }, SECRET, 1),
    );
    expect(w.events).toEqual([{ type: "ignored", reason: "unhandled event type ping" }]);
    expect(w.createdAt).toBeUndefined();
  });

  test("requires a webhook secret", async () => {
    await expect(
      createStripeProvider({}).parseWebhook!(new Request("https://x", { method: "POST" })),
    ).rejects.toThrow(/webhookSecret/);
    await expect(
      createStripeProvider({ webhookSecret: [""] }).parseWebhook!(
        new Request("https://x", { method: "POST" }),
      ),
    ).rejects.toThrow(/secret is required/);
  });

  test("subscription.deleted, checkout.session.completed and customer events", async () => {
    const p = provider();
    const ev = async (type: string, object: unknown) =>
      (await p.parseWebhook!(await signed({ id: `evt_${type}`, type, data: { object } }))).events;
    expect(await ev("customer.subscription.deleted", stripeSubscription(state))).toMatchObject([
      { type: "subscription.deleted" },
    ]);
    expect(
      await ev("checkout.session.completed", {
        mode: "subscription",
        customer: "cus_1",
        client_reference_id: "org_1",
        customer_details: { email: "a@acme.test" },
      }),
    ).toEqual([
      {
        type: "customer.updated",
        providerCustomer: "cus_1",
        customer: "org_1",
        email: "a@acme.test",
      },
    ]);
    expect(
      await ev("checkout.session.completed", {
        customer: { id: "cus_2" },
        metadata: { customerId: "org_2" },
      }),
    ).toEqual([{ type: "customer.updated", providerCustomer: "cus_2", customer: "org_2" }]);
    expect(await ev("checkout.session.completed", { customer: null })).toMatchObject([
      { type: "ignored" },
    ]);
    expect(
      await ev("customer.updated", {
        id: "cus_3",
        email: "b@acme.test",
        name: "B",
        metadata: { customerId: "org_3" },
      }),
    ).toEqual([
      {
        type: "customer.updated",
        providerCustomer: "cus_3",
        customer: "org_3",
        email: "b@acme.test",
        name: "B",
      },
    ]);
    expect(await ev("customer.created", { id: "cus_4" })).toEqual([
      { type: "customer.updated", providerCustomer: "cus_4" },
    ]);
  });
});

describe("stripe normalization", () => {
  test("statuses", () => {
    expect(
      [
        "active",
        "trialing",
        "past_due",
        "paused",
        "canceled",
        "incomplete",
        "unpaid",
        "incomplete_expired",
        "new",
      ].map(stripeStatus),
    ).toEqual([
      "active",
      "trialing",
      "past_due",
      "paused",
      "canceled",
      "incomplete",
      "paused",
      "canceled",
      "incomplete",
    ]);
  });

  test("legacy top-level periods, expanded customer / price, cancel_at", () => {
    const s = normalizeStripeSubscription({
      id: "sub_9",
      customer: { id: "cus_9" },
      status: "active",
      items: { data: [{ id: "si_9", price: "price_x" }] },
      current_period_start: 1_700_000_000,
      current_period_end: 1_702_592_000,
      cancel_at: 1_702_592_000,
      metadata: {},
    });
    expect(s).toEqual({
      ref: "sub_9",
      providerCustomer: "cus_9",
      items: [{ id: "price_x", quantity: 1, itemRef: "si_9" }],
      status: "active",
      periodStart: new Date(1_700_000_000_000).toISOString(),
      periodEnd: new Date(1_702_592_000_000).toISOString(),
      cancelAtPeriodEnd: true,
    });
    const noPeriod = normalizeStripeSubscription({
      id: "sub_8",
      customer: "cus_8",
      status: "active",
      items: { data: [] },
      cancel_at: 1_702_592_000,
    });
    expect(noPeriod.periodEnd).toBe(new Date(1_702_592_000_000).toISOString());
  });

  test("form encoding and signature parsing", () => {
    expect(
      stripeForm({ a: 1, b: [{ c: "x" }], d: { e: true }, f: undefined, g: null }).toString(),
    ).toBe("a=1&b%5B0%5D%5Bc%5D=x&d%5Be%5D=true");
    expect(parseStripeSignature("t=1,v1=a,v1=b,junk")).toEqual({
      timestamp: 1,
      signatures: ["a", "b"],
    });
  });
});

describe("stripe REST", () => {
  test("fetchSubscriptions paginates with status=all", async () => {
    const { fetch, calls } = fakeFetch([
      {
        method: "GET",
        path: "/v1/subscriptions?customer=cus_1&status=all&limit=100&starting_after=sub_1",
        body: { data: [stripeSubscription({ ...state, ref: "sub_2" })], has_more: false },
      },
      {
        method: "GET",
        path: "/v1/subscriptions",
        body: { data: [stripeSubscription(state)], has_more: true },
      },
    ]);
    const p = createStripeProvider({ secretKey: "sk_test", fetch, apiVersion: "2025-03-31.basil" });
    const subs = await p.fetchSubscriptions!("cus_1");
    expect(subs.map((s) => s.ref)).toEqual(["sub_1", "sub_2"]);
    expect(calls[0]!.headers).toMatchObject({
      authorization: "Bearer sk_test",
      "stripe-version": "2025-03-31.basil",
    });
  });

  test("createCheckout posts a subscription-mode session", async () => {
    const { fetch, calls } = fakeFetch([
      {
        method: "POST",
        path: "/v1/checkout/sessions",
        body: { url: "https://checkout.stripe.com/c/1" },
      },
    ]);
    const p = createStripeProvider({ secretKey: "sk_test", fetch });
    expect(
      await p.createCheckout!({
        customer: "org_1",
        item: "price_pro_m",
        quantity: 2,
        trialDays: 14,
        email: "a@acme.test",
        successUrl: "https://app/ok",
      }),
    ).toEqual({ url: "https://checkout.stripe.com/c/1" });
    const form = new URLSearchParams(calls[0]!.body);
    expect(Object.fromEntries(form)).toEqual({
      mode: "subscription",
      "line_items[0][price]": "price_pro_m",
      "line_items[0][quantity]": "2",
      client_reference_id: "org_1",
      "metadata[customerId]": "org_1",
      "subscription_data[metadata][customerId]": "org_1",
      "subscription_data[trial_period_days]": "14",
      success_url: "https://app/ok",
      customer_email: "a@acme.test",
    });
    expect(calls[0]!.headers["content-type"]).toBe("application/x-www-form-urlencoded");
    await p.createCheckout!({ customer: "org_1", item: "price_pro_m", providerCustomer: "cus_1" });
    expect(new URLSearchParams(calls[1]!.body).get("customer")).toBe("cus_1");
  });

  test("checkout without url, portal, meter events, API errors", async () => {
    const { fetch, calls } = fakeFetch([
      { method: "POST", path: "/v1/checkout/sessions", body: { url: null } },
      {
        method: "POST",
        path: "/v1/billing_portal/sessions",
        body: { url: "https://billing.stripe.com/p/1" },
      },
      { method: "POST", path: "/v1/billing/meter_events", body: { object: "billing.meter_event" } },
      {
        method: "GET",
        path: "/v1/subscriptions",
        status: 401,
        body: { error: { message: "bad key" } },
      },
    ]);
    const p = createStripeProvider({ secretKey: "sk_test", fetch });
    await expect(p.createCheckout!({ customer: "o", item: "p" })).rejects.toThrow(/no url/);
    expect(
      await p.createPortalSession!({
        customer: "o",
        providerCustomer: "cus_1",
        returnUrl: "https://app",
      }),
    ).toEqual({ url: "https://billing.stripe.com/p/1" });
    await expect(
      p.reportUsage!([
        {
          customer: "o",
          providerCustomer: "cus_1",
          feature: "api_calls",
          meter: "api_requests",
          amount: 3,
          at: "2026-11-20T10:00:00.000Z",
          idempotencyKey: "k1",
        },
        {
          customer: "o2",
          feature: "api_calls",
          meter: "api_requests",
          amount: 1,
          at: "2026-11-20T10:00:00.000Z",
        },
      ]),
    ).rejects.toThrow(/"o2"/);
    const meter = Object.fromEntries(new URLSearchParams(calls.at(-1)!.body));
    expect(meter).toEqual({
      event_name: "api_requests",
      "payload[stripe_customer_id]": "cus_1",
      "payload[value]": "3",
      timestamp: String(Date.parse("2026-11-20T10:00:00Z") / 1000),
      identifier: "k1",
    });
    const error = await p.fetchSubscriptions!("cus_1").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BillingApiError);
    expect(error).toMatchObject({ status: 401, body: { error: { message: "bad key" } } });
    await expect(createStripeProvider({}).fetchSubscriptions!("c")).rejects.toThrow(/secretKey/);
  });
});

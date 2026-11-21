import { describe, expect, test } from "vitest";
import {
  createLemonSqueezyProvider,
  lemonSqueezyStatus,
  normalizeLemonSqueezySubscription,
  signLemonSqueezyPayload,
} from "../src/billing/lemonsqueezy.ts";
import {
  createPaddleProvider,
  normalizePaddleSubscription,
  paddleStatus,
  parsePaddleSignature,
  signPaddlePayload,
} from "../src/billing/paddle.ts";
import {
  fakeFetch,
  lemonSqueezySubscription,
  paddleSubscription,
  type SubState,
} from "./billing-fixtures.ts";

const NOW = Date.parse("2026-11-20T10:00:00Z");
const T = Math.floor(NOW / 1000);
const state: SubState = {
  ref: "sub_01h7",
  providerCustomer: "ctm_01h7",
  customer: "org_1",
  status: "trialing",
  items: [{ id: "pri_pro", quantity: 1 }],
  periodStart: "2026-11-20T10:00:00.000Z",
  periodEnd: "2026-12-20T10:00:00.000Z",
  trialEnd: "2026-12-04T10:00:00.000Z",
  updatedAt: "2026-11-20T10:00:00.000Z",
};
const post = (path: string, body: string, headers: Record<string, string>) =>
  new Request(`https://app/webhooks/${path}`, { method: "POST", headers, body });

describe("paddle", () => {
  const SECRET = "pdl_ntfset_secret";
  const provider = (o: Parameters<typeof createPaddleProvider>[0] = {}) =>
    createPaddleProvider({ webhookSecret: SECRET, now: () => NOW, ...o });
  const event = (event_type: string, data: unknown, event_id = "evt_01") =>
    JSON.stringify({ event_id, event_type, occurred_at: "2026-11-20T10:00:00.000Z", data });
  const signed = async (b: string, secret = SECRET, t = T) =>
    post("paddle", b, { "paddle-signature": await signPaddlePayload(secret, b, t) });

  test("verifies ts;h1 (any h1 during rotation) and maps events", async () => {
    const p = provider({ webhookSecret: ["old", SECRET] });
    const b = event("subscription.trialing", paddleSubscription(state));
    const h1 = (await signPaddlePayload(SECRET, b, T)).split(";")[1];
    const w = await p.parseWebhook!(
      post("paddle", b, { "paddle-signature": `ts=${T};h1=00;${h1}` }),
    );
    expect(w).toMatchObject({
      id: "evt_01",
      type: "subscription.trialing",
      createdAt: "2026-11-20T10:00:00.000Z",
      events: [
        {
          type: "subscription.updated",
          subscription: {
            ref: "sub_01h7",
            status: "trialing",
            trialEndsAt: "2026-12-04T10:00:00.000Z",
            metadata: { customerId: "org_1" },
            items: [{ id: "pri_pro", quantity: 1 }],
          },
        },
      ],
    });
    const ev = async (type: string, data: unknown) =>
      (await provider().parseWebhook!(await signed(event(type, data)))).events;
    expect(
      await ev("subscription.canceled", paddleSubscription({ ...state, status: "canceled" })),
    ).toMatchObject([{ type: "subscription.deleted", subscription: { status: "canceled" } }]);
    expect(
      await ev("customer.updated", {
        id: "ctm_1",
        email: "a@x.test",
        name: "A",
        custom_data: { customerId: "org_1" },
      }),
    ).toEqual([
      {
        type: "customer.updated",
        providerCustomer: "ctm_1",
        customer: "org_1",
        email: "a@x.test",
        name: "A",
      },
    ]);
    expect(await ev("customer.created", { id: "ctm_2", custom_data: null })).toEqual([
      { type: "customer.updated", providerCustomer: "ctm_2" },
    ]);
    expect(await ev("transaction.completed", {})).toMatchObject([{ type: "ignored" }]);
  });

  test("rejects bad headers, signatures, timestamps outside 5 s and junk", async () => {
    const p = provider();
    const b = event("subscription.updated", paddleSubscription(state));
    await expect(p.parseWebhook!(post("paddle", b, {}))).rejects.toThrow(
      /Missing paddle-signature/,
    );
    await expect(
      p.parseWebhook!(post("paddle", b, { "paddle-signature": "h1=abc" })),
    ).rejects.toThrow(/Malformed/);
    await expect(p.parseWebhook!(await signed(b, "nope"))).rejects.toThrow(/mismatch/);
    await expect(p.parseWebhook!(await signed(b, SECRET, T - 6))).rejects.toThrow(/tolerance/);
    expect(
      (await provider({ tolerance: 60 }).parseWebhook!(await signed(b, SECRET, T - 6))).id,
    ).toBe("evt_01");
    await expect(p.parseWebhook!(await signed(JSON.stringify({ a: 1 })))).rejects.toThrow(
      /Not a Paddle/,
    );
    await expect(createPaddleProvider({}).parseWebhook!(await signed(b))).rejects.toThrow(
      /webhookSecret/,
    );
    expect(parsePaddleSignature("ts=1;h1=a;x")).toEqual({ timestamp: 1, signatures: ["a"] });
  });

  test("normalization: statuses, scheduled cancel, inactive items", () => {
    expect(["active", "trialing", "past_due", "paused", "canceled", "?"].map(paddleStatus)).toEqual(
      ["active", "trialing", "past_due", "paused", "canceled", "incomplete"],
    );
    const s = normalizePaddleSubscription({
      id: "sub",
      status: "active",
      customer_id: "ctm",
      items: [
        { status: "active", quantity: 1, price: { id: "pri_a" } },
        { status: "inactive", quantity: 1, price: { id: "pri_b" } },
      ],
      scheduled_change: { action: "cancel", effective_at: "2026-12-01T00:00:00Z" },
      created_at: "2026-11-01T00:00:00Z",
    });
    expect(s).toEqual({
      ref: "sub",
      providerCustomer: "ctm",
      items: [{ id: "pri_a", quantity: 1 }],
      status: "active",
      cancelAtPeriodEnd: true,
      periodEnd: "2026-12-01T00:00:00Z",
      updatedAt: "2026-11-01T00:00:00Z",
    });
  });

  test("REST: list (paginated), transaction checkout, portal session", async () => {
    const { fetch, calls } = fakeFetch([
      {
        method: "GET",
        path: "/subscriptions?after=sub_01h7",
        body: {
          data: [paddleSubscription({ ...state, ref: "sub_2" })],
          meta: { pagination: { has_more: false } },
        },
      },
      {
        method: "GET",
        path: "/subscriptions?customer_id=ctm_01h7",
        body: {
          data: [paddleSubscription(state)],
          meta: {
            pagination: {
              has_more: true,
              next: "https://sandbox-api.paddle.com/subscriptions?after=sub_01h7",
            },
          },
        },
      },
      {
        method: "POST",
        path: "/transactions",
        body: { data: { checkout: { url: "https://pay.acme.test/?_ptxn=txn_1" } } },
      },
      {
        method: "POST",
        path: "/customers/ctm_01h7/portal-sessions",
        body: { data: { urls: { general: { overview: "https://customer-portal.paddle.com/x" } } } },
      },
    ]);
    const p = createPaddleProvider({ apiKey: "pdl_key", fetch, environment: "sandbox" });
    expect((await p.fetchSubscriptions!("ctm_01h7")).map((s) => s.ref)).toEqual([
      "sub_01h7",
      "sub_2",
    ]);
    expect(calls[0]!.url.startsWith("https://sandbox-api.paddle.com/")).toBe(true);
    expect(
      await p.createCheckout!({
        customer: "org_1",
        item: "pri_pro",
        providerCustomer: "ctm_01h7",
        quantity: 2,
      }),
    ).toEqual({ url: "https://pay.acme.test/?_ptxn=txn_1" });
    expect(JSON.parse(calls[2]!.body!)).toEqual({
      items: [{ price_id: "pri_pro", quantity: 2 }],
      custom_data: { customerId: "org_1" },
      customer_id: "ctm_01h7",
    });
    expect(
      await p.createPortalSession!({ customer: "org_1", providerCustomer: "ctm_01h7" }),
    ).toEqual({
      url: "https://customer-portal.paddle.com/x",
    });
    const noLink = fakeFetch([
      { method: "POST", path: "/transactions", body: { data: { checkout: null } } },
    ]);
    await expect(
      createPaddleProvider({ apiKey: "k", fetch: noLink.fetch }).createCheckout!({
        customer: "o",
        item: "p",
      }),
    ).rejects.toThrow(/default payment link/);
    await expect(createPaddleProvider({}).fetchSubscriptions!("c")).rejects.toThrow(/apiKey/);
  });
});

describe("lemon squeezy", () => {
  const SECRET = "ls_signing_secret";
  const provider = () => createLemonSqueezyProvider({ webhookSecret: SECRET });
  const ls = {
    ...state,
    ref: "501",
    providerCustomer: "4242",
    items: [{ id: "101", quantity: 1 }],
  };
  const payload = (event_name: string, data: unknown, custom_data?: unknown) =>
    JSON.stringify({ meta: { event_name, custom_data }, data });
  const signed = async (b: string, secret = SECRET) =>
    post("lemonsqueezy", b, { "x-signature": await signLemonSqueezyPayload(secret, b) });

  test("verifies X-Signature, ids are body hashes, maps events", async () => {
    const b = payload("subscription_created", lemonSqueezySubscription(ls), {
      customerId: "org_1",
    });
    const w = await provider().parseWebhook!(await signed(b));
    expect(w.id).toMatch(/^ls_[0-9a-f]{64}$/);
    expect((await provider().parseWebhook!(await signed(b))).id).toBe(w.id);
    expect(w).toMatchObject({
      type: "subscription_created",
      createdAt: "2026-11-20T10:00:00.000Z",
      events: [
        {
          type: "subscription.updated",
          subscription: {
            ref: "501",
            providerCustomer: "4242",
            status: "trialing",
            items: [{ id: "101", quantity: 1, itemRef: "9101" }],
            metadata: { customerId: "org_1" },
          },
        },
      ],
    });
    const ev = async (name: string, data: unknown) =>
      (await provider().parseWebhook!(await signed(payload(name, data)))).events;
    expect(
      await ev("subscription_expired", lemonSqueezySubscription({ ...ls, status: "canceled" })),
    ).toMatchObject([{ type: "subscription.deleted", subscription: { status: "canceled" } }]);
    expect(
      await ev("subscription_payment_success", {
        type: "subscription-invoices",
        id: 1,
        attributes: {},
      }),
    ).toMatchObject([{ type: "ignored" }]);
  });

  test("rejects missing / wrong signatures and junk; needs a secret", async () => {
    const b = payload("subscription_updated", lemonSqueezySubscription(ls));
    await expect(provider().parseWebhook!(post("lemonsqueezy", b, {}))).rejects.toThrow(
      /x-signature/,
    );
    await expect(provider().parseWebhook!(await signed(b, "wrong"))).rejects.toThrow(/mismatch/);
    await expect(
      provider().parseWebhook!(await signed(JSON.stringify({ data: {} }))),
    ).rejects.toThrow(/Not a Lemon Squeezy/);
    await expect(createLemonSqueezyProvider({}).parseWebhook!(await signed(b))).rejects.toThrow(
      /webhookSecret/,
    );
  });

  test("statuses and the cancelled grace period", () => {
    expect(
      ["on_trial", "active", "cancelled", "paused", "unpaid", "past_due", "expired", "?"].map(
        lemonSqueezyStatus,
      ),
    ).toEqual([
      "trialing",
      "active",
      "active",
      "paused",
      "paused",
      "past_due",
      "canceled",
      "incomplete",
    ]);
    const s = normalizeLemonSqueezySubscription({
      type: "subscriptions",
      id: 7,
      attributes: {
        customer_id: 1,
        variant_id: 101,
        status: "cancelled",
        renews_at: "2026-12-20T00:00:00Z",
        ends_at: "2026-12-10T00:00:00Z",
        created_at: "2026-11-01T00:00:00Z",
        first_subscription_item: null,
      },
    });
    expect(s).toEqual({
      ref: "7",
      providerCustomer: "1",
      items: [{ id: "101", quantity: 1 }],
      status: "active",
      cancelAtPeriodEnd: true,
      periodEnd: "2026-12-10T00:00:00Z",
      updatedAt: "2026-11-01T00:00:00Z",
    });
  });

  test("REST: customer subscriptions (paginated), checkout, portal", async () => {
    const { fetch, calls } = fakeFetch([
      {
        method: "GET",
        path: "/v1/customers/4242/subscriptions?page[number]=2",
        body: { data: [lemonSqueezySubscription({ ...ls, ref: "502" })], links: {} },
      },
      {
        method: "GET",
        path: "/v1/customers/4242/subscriptions",
        body: {
          data: [lemonSqueezySubscription(ls)],
          links: {
            next: "https://api.lemonsqueezy.com/v1/customers/4242/subscriptions?page[number]=2",
          },
        },
      },
      {
        method: "POST",
        path: "/v1/checkouts",
        body: { data: { attributes: { url: "https://acme.lemonsqueezy.com/checkout/custom/1" } } },
      },
      {
        method: "GET",
        path: "/v1/customers/4242",
        body: {
          data: {
            attributes: { urls: { customer_portal: "https://acme.lemonsqueezy.com/billing?x" } },
          },
        },
      },
    ]);
    const p = createLemonSqueezyProvider({ apiKey: "ls_key", fetch, storeId: 12 });
    expect((await p.fetchSubscriptions!("4242")).map((s) => s.ref)).toEqual(["501", "502"]);
    expect(calls[0]!.headers).toMatchObject({
      accept: "application/vnd.api+json",
      authorization: "Bearer ls_key",
    });
    expect(
      await p.createCheckout!({
        customer: "org_1",
        item: "101",
        email: "a@x.test",
        quantity: 2,
        successUrl: "https://app/ok",
      }),
    ).toEqual({ url: "https://acme.lemonsqueezy.com/checkout/custom/1" });
    expect(JSON.parse(calls[2]!.body!)).toEqual({
      data: {
        type: "checkouts",
        attributes: {
          checkout_data: {
            email: "a@x.test",
            custom: { customerId: "org_1" },
            variant_quantities: [{ variant_id: 101, quantity: 2 }],
          },
          product_options: { redirect_url: "https://app/ok" },
        },
        relationships: {
          store: { data: { type: "stores", id: "12" } },
          variant: { data: { type: "variants", id: "101" } },
        },
      },
    });
    await p.createCheckout!({ customer: "org_1", item: "101" });
    expect(JSON.parse(calls[3]!.body!).data.attributes).toEqual({
      checkout_data: { custom: { customerId: "org_1" } },
    });
    expect(await p.createPortalSession!({ customer: "org_1", providerCustomer: "4242" })).toEqual({
      url: "https://acme.lemonsqueezy.com/billing?x",
    });
    await expect(
      createLemonSqueezyProvider({ apiKey: "k" }).createCheckout!({ customer: "o", item: "1" }),
    ).rejects.toThrow(/storeId/);
    await expect(createLemonSqueezyProvider({}).fetchSubscriptions!("c")).rejects.toThrow(/apiKey/);
  });
});

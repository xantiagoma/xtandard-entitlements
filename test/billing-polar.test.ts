import { signatureHeader } from "@xtandard/webhooks/signing";
import { verify } from "@xtandard/webhooks/receiver";
import { describe, expect, test } from "vitest";
import {
  createPolarProvider,
  normalizePolarSubscription,
  polarStatus,
  signPolarPayload,
} from "../src/billing/polar.ts";
import { fakeFetch, polarSubscription, type SubState } from "./billing-fixtures.ts";

const NOW = Date.parse("2026-11-20T10:00:00Z");
const T = Math.floor(NOW / 1000);
const SECRET = "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw";
const state: SubState = {
  ref: "sub_p1",
  providerCustomer: "cus_p1",
  customer: "org_1",
  status: "active",
  items: [{ id: "prod_pro", quantity: 1 }],
  periodStart: "2026-11-20T10:00:00.000Z",
  periodEnd: "2026-12-20T10:00:00.000Z",
  updatedAt: "2026-11-20T10:00:00.000Z",
};
const body = (type = "subscription.updated", data: unknown = polarSubscription(state)) =>
  JSON.stringify({ type, timestamp: "2026-11-20T10:00:00.000Z", data });
const request = (b: string, headers: Record<string, string>) =>
  new Request("https://app/webhooks/polar", { method: "POST", headers, body: b });
const provider = (o: Parameters<typeof createPolarProvider>[0] = {}) =>
  createPolarProvider({ webhookSecret: SECRET, now: () => NOW, ...o });

describe("polar ↔ @xtandard/webhooks (Standard Webhooks byte compatibility)", () => {
  test("a delivery signed by @xtandard/webhooks verifies here", async () => {
    const b = body();
    const sig = await signatureHeader(["whsec_" + btoa("x".repeat(32)), SECRET], "msg_1", T, b);
    const w = await provider().parseWebhook!(
      request(b, {
        "webhook-id": "msg_1",
        "webhook-timestamp": String(T),
        "webhook-signature": sig,
      }),
    );
    expect(w).toMatchObject({ id: "msg_1", type: "subscription.updated" });
  });

  test("a payload signed here verifies with @xtandard/webhooks/receiver", async () => {
    const b = body();
    const headers = await signPolarPayload(SECRET, b, { id: "msg_2", timestamp: T });
    const envelope = await verify({ payload: b, headers, secret: SECRET, now: T });
    expect(envelope).toMatchObject({ type: "subscription.updated" });
  });

  test("legacy Polar HMAC secrets (UTF-8 key) = Standard Webhooks with base64(secret)", async () => {
    const legacy = "whsec_legacy-polar-secret-0123456789";
    const b = body();
    const headers = await signPolarPayload(legacy, b, { id: "msg_3", timestamp: T, legacy: true });
    const envelope = await verify({
      payload: b,
      headers,
      secret: "whsec_" + btoa(legacy),
      now: T,
    });
    expect(envelope).toMatchObject({ type: "subscription.updated" });
    const w = await provider({ webhookSecret: legacy }).parseWebhook!(request(b, headers));
    expect(w.id).toBe("msg_3");
    // A raw `polar_whs_…` secret (not base64) only has the UTF-8 key.
    const raw = "polar_whs_abcdef";
    const h2 = await signPolarPayload(raw, b, { id: "msg_4", timestamp: T });
    expect((await provider({ webhookSecret: raw }).parseWebhook!(request(b, h2))).id).toBe("msg_4");
  });
});

describe("polar webhooks", () => {
  test("rejects missing headers, bad timestamps, missing v1, wrong signatures, junk", async () => {
    const p = provider();
    const b = body();
    const good = await signPolarPayload(SECRET, b, { id: "m", timestamp: T });
    await expect(p.parseWebhook!(request(b, {}))).rejects.toThrow(/webhook-id/);
    await expect(
      p.parseWebhook!(request(b, { ...good, "webhook-timestamp": "12a" })),
    ).rejects.toThrow(/Invalid webhook-timestamp/);
    await expect(
      p.parseWebhook!(request(b, { ...good, "webhook-signature": "v1a,xyz" })),
    ).rejects.toThrow(/No v1/);
    await expect(p.parseWebhook!(request(b + " ", good))).rejects.toThrow(/mismatch/);
    const old = await signPolarPayload(SECRET, b, { id: "m", timestamp: T - 301 });
    await expect(p.parseWebhook!(request(b, old))).rejects.toThrow(/tolerance/);
    const notPolar = JSON.stringify({ hello: "world" });
    await expect(
      p.parseWebhook!(
        request(notPolar, await signPolarPayload(SECRET, notPolar, { timestamp: T })),
      ),
    ).rejects.toThrow(/Not a Polar/);
    await expect(createPolarProvider({}).parseWebhook!(request(b, good))).rejects.toThrow(
      /webhookSecret/,
    );
  });

  test("event types", async () => {
    const p = provider();
    const ev = async (type: string, data: unknown) => {
      const b = body(type, data);
      return (
        await p.parseWebhook!(request(b, await signPolarPayload(SECRET, b, { timestamp: T })))
      ).events;
    };
    expect(await ev("subscription.revoked", polarSubscription(state))).toMatchObject([
      { type: "subscription.deleted", subscription: { ref: "sub_p1", customer: "org_1" } },
    ]);
    expect(
      await ev("customer.updated", {
        id: "cus_p1",
        external_id: "org_1",
        email: "a@x.test",
        name: "A",
      }),
    ).toEqual([
      {
        type: "customer.updated",
        providerCustomer: "cus_p1",
        customer: "org_1",
        email: "a@x.test",
        name: "A",
      },
    ]);
    expect(await ev("customer.created", { id: "cus_p2", external_id: null })).toEqual([
      { type: "customer.updated", providerCustomer: "cus_p2" },
    ]);
    expect(await ev("order.paid", {})).toMatchObject([{ type: "ignored" }]);
  });

  test("normalization and statuses", () => {
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
        "trial_ended",
        "?",
      ].map(polarStatus),
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
      "incomplete",
    ]);
    const s = normalizePolarSubscription({
      id: "s",
      status: "active",
      customer_id: "c",
      product_id: "prod_seats",
      seats: 4,
      ends_at: "2026-12-01T00:00:00.000Z",
      created_at: "2026-11-01T00:00:00.000Z",
      ended_at: "2026-12-01T00:00:00.000Z",
      metadata: { customerId: "org_7" },
    });
    expect(s).toEqual({
      ref: "s",
      providerCustomer: "c",
      items: [{ id: "prod_seats", quantity: 4 }],
      status: "active",
      cancelAtPeriodEnd: false,
      periodEnd: "2026-12-01T00:00:00.000Z",
      canceledAt: "2026-12-01T00:00:00.000Z",
      updatedAt: "2026-11-01T00:00:00.000Z",
      metadata: { customerId: "org_7" },
    });
  });
});

describe("polar REST", () => {
  test("list, checkout, customer session, event ingest; sandbox server", async () => {
    const { fetch, calls } = fakeFetch([
      {
        method: "GET",
        path: "/v1/subscriptions/?customer_id=cus_p1&limit=100&page=2",
        body: {
          items: [polarSubscription({ ...state, ref: "sub_p2" })],
          pagination: { max_page: 2 },
        },
      },
      {
        method: "GET",
        path: "/v1/subscriptions/",
        body: { items: [polarSubscription(state)], pagination: { max_page: 2 } },
      },
      { method: "POST", path: "/v1/checkouts/", body: { url: "https://buy.polar.sh/c/1" } },
      {
        method: "POST",
        path: "/v1/customer-sessions/",
        body: { customer_portal_url: "https://polar.sh/portal/1" },
      },
      { method: "POST", path: "/v1/events/ingest", body: { inserted: 1 } },
    ]);
    const p = createPolarProvider({
      accessToken: "polar_oat",
      fetch,
      server: "sandbox",
      meterProperty: "units",
    });
    expect((await p.fetchSubscriptions!("cus_p1")).map((s) => s.ref)).toEqual(["sub_p1", "sub_p2"]);
    expect(calls[0]!.url.startsWith("https://sandbox-api.polar.sh/")).toBe(true);
    expect(calls[0]!.headers.authorization).toBe("Bearer polar_oat");

    expect(
      await p.createCheckout!({
        customer: "org_1",
        item: "prod_pro",
        providerCustomer: "cus_p1",
        email: "a@x.test",
        quantity: 3,
        trialDays: 7,
        successUrl: "https://app/ok",
        cancelUrl: "https://app/back",
      }),
    ).toEqual({ url: "https://buy.polar.sh/c/1" });
    expect(JSON.parse(calls[2]!.body!)).toEqual({
      products: ["prod_pro"],
      external_customer_id: "org_1",
      metadata: { customerId: "org_1" },
      customer_id: "cus_p1",
      customer_email: "a@x.test",
      success_url: "https://app/ok",
      return_url: "https://app/back",
      seats: 3,
      trial_interval: "day",
      trial_interval_count: 7,
    });
    await p.createCheckout!({ customer: "org_1", item: "prod_pro" });
    expect(JSON.parse(calls[3]!.body!)).toEqual({
      products: ["prod_pro"],
      external_customer_id: "org_1",
      metadata: { customerId: "org_1" },
    });

    expect(
      await p.createPortalSession!({
        customer: "org_1",
        providerCustomer: "cus_p1",
        returnUrl: "https://app",
      }),
    ).toEqual({ url: "https://polar.sh/portal/1" });
    expect(JSON.parse(calls[4]!.body!)).toEqual({
      customer_id: "cus_p1",
      return_url: "https://app",
    });
    await p.createPortalSession!({ customer: "org_1", providerCustomer: "cus_p1" });

    await p.reportUsage!([]);
    await p.reportUsage!([
      {
        customer: "org_1",
        feature: "api_calls",
        meter: "api_requests",
        amount: 5,
        at: "2026-11-20T10:00:00.000Z",
        idempotencyKey: "k",
      },
      {
        customer: "org_2",
        feature: "api_calls",
        meter: "api_requests",
        amount: 1,
        at: "2026-11-20T10:00:00.000Z",
      },
    ]);
    expect(JSON.parse(calls.at(-1)!.body!)).toEqual({
      events: [
        {
          name: "api_requests",
          external_customer_id: "org_1",
          timestamp: "2026-11-20T10:00:00.000Z",
          external_id: "k",
          metadata: { units: 5, feature: "api_calls" },
        },
        {
          name: "api_requests",
          external_customer_id: "org_2",
          timestamp: "2026-11-20T10:00:00.000Z",
          metadata: { units: 1, feature: "api_calls" },
        },
      ],
    });
    await expect(createPolarProvider({}).fetchSubscriptions!("c")).rejects.toThrow(/accessToken/);
  });
});

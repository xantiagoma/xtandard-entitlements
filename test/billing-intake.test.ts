import { describe, expect, test, vi } from "vitest";
import {
  BillingVerificationError,
  type BillingProvider,
  type BillingWebhook,
  type ProviderSubscription,
  type UsageRecord,
} from "../src/billing/contract.ts";
import { createBilling, type UnmappedEvent } from "../src/billing/intake.ts";
import { createManualProvider } from "../src/billing/manual.ts";
import { createUsageExporter } from "../src/billing/usage-export.ts";
import { EntitlementsValidationError, NotFoundError } from "../src/engine.ts";
import { eventKey } from "../src/keys.ts";
import { createTestEntitlements } from "../src/testing.ts";
import { billingCatalog } from "./billing-fixtures.ts";

const START = "2026-11-20T10:00:00Z";

const sub = (patch: Partial<ProviderSubscription> = {}): ProviderSubscription => ({
  ref: "sub_1",
  providerCustomer: "cus_1",
  items: [{ id: "price_pro_m", quantity: 1, itemRef: "si_1" }],
  status: "active",
  periodStart: "2026-11-20T10:00:00.000Z",
  periodEnd: "2026-12-20T10:00:00.000Z",
  updatedAt: "2026-11-20T10:00:00.000Z",
  ...patch,
});

function setup(provider: Partial<BillingProvider> = {}, unmapped: UnmappedEvent[] = []) {
  const t = createTestEntitlements({ catalog: billingCatalog, now: START });
  const p: BillingProvider = { id: "stripe", ...provider };
  const billing = createBilling(t.ent, {
    now: t.clock.now,
    providers: [p, createManualProvider()],
    onUnmapped: (e) => void unmapped.push(e),
  });
  return { ...t, billing, provider: p, unmapped };
}

describe("createBilling", () => {
  test("lists providers and capabilities", () => {
    const { billing } = setup();
    expect(billing.providers).toEqual(["stripe", "manual"]);
    expect(billing.canCheckout).toBe(false);
    expect(billing.canManage).toBe(false);
    const { billing: b2 } = setup({
      createCheckout: async () => ({ url: "x" }),
      createPortalSession: async () => ({ url: "y" }),
    });
    expect(b2.canCheckout).toBe(true);
    expect(b2.canManage).toBe(true);
  });

  test("rejects duplicate and anonymous providers", () => {
    const { ent } = createTestEntitlements({ catalog: billingCatalog });
    expect(() => createBilling(ent, { providers: [{ id: "a" }, { id: "a" }] })).toThrow(
      EntitlementsValidationError,
    );
    expect(() => createBilling(ent, { providers: [{} as BillingProvider] })).toThrow(/id/);
  });

  test("unknown provider → NotFoundError; provider without webhooks → NotFoundError", async () => {
    const { billing } = setup();
    const r = new Request("https://x", { method: "POST", body: "{}" });
    await expect(billing.handleWebhook("paypal", r)).rejects.toBeInstanceOf(NotFoundError);
    await expect(billing.handleWebhook("stripe", r)).rejects.toBeInstanceOf(NotFoundError);
    await expect(billing.apply("paypal", [])).rejects.toBeInstanceOf(NotFoundError);
  });

  test("verification errors propagate (HTTP 400)", async () => {
    const { billing } = setup({
      parseWebhook: async () => {
        throw new BillingVerificationError("bad");
      },
    });
    await expect(
      billing.handleWebhook("stripe", new Request("https://x", { method: "POST" })),
    ).rejects.toBeInstanceOf(BillingVerificationError);
  });

  test("handleWebhook orders by event time when the subscription has no update time", async () => {
    const webhook: BillingWebhook = {
      id: "evt_1",
      type: "customer.subscription.updated",
      createdAt: "2026-11-20T11:00:00.000Z",
      events: [
        {
          type: "subscription.updated",
          subscription: sub({ customer: "org_1", updatedAt: undefined }),
        },
        { type: "ignored", reason: "x" },
      ],
    };
    const { billing, ent } = setup({ parseWebhook: async () => webhook });
    expect(await billing.handleWebhook("stripe", new Request("https://x"))).toEqual({
      outcome: "applied",
      events: 2,
    });
    const s = (await ent.getCustomer("org_1"))!.subscriptions[0]!;
    expect(s.providerUpdatedAt).toBe("2026-11-20T11:00:00.000Z");
    expect(s.metadata).toBeUndefined();
  });

  test("ignored-only and empty event lists are 'ignored'", async () => {
    const { billing } = setup();
    expect(await billing.apply("stripe", [])).toBe("ignored");
    expect(await billing.apply("stripe", [{ type: "ignored", reason: "nope" }])).toBe("ignored");
  });

  test("records an actor and keeps provider metadata", async () => {
    const { billing, ent, events } = setup();
    await billing.apply("stripe", [
      {
        type: "subscription.updated",
        subscription: sub({ metadata: { customerId: "org_1", campaign: "bf" } }),
      },
    ]);
    const s = (await ent.getCustomer("org_1"))!.subscriptions[0]!;
    expect(s.metadata).toEqual({ customerId: "org_1", campaign: "bf" });
    expect(events[0]).toMatchObject({
      type: "subscription.changed",
      actor: { id: "stripe", type: "billing:stripe" },
    });
  });

  test("custom metadataKey", async () => {
    const t = createTestEntitlements({ catalog: billingCatalog, now: START });
    const billing = createBilling(t.ent, { providers: [{ id: "stripe" }], metadataKey: "org" });
    await billing.apply("stripe", [
      { type: "subscription.updated", subscription: sub({ metadata: { org: "org_9" } }) },
    ]);
    expect(await t.ent.resolveLink("stripe", "cus_1")).toBe("org_9");
  });
});

describe("idempotency", () => {
  test("claims the event id; a duplicate does nothing", async () => {
    const { billing, ent } = setup();
    const events = [
      { type: "subscription.updated" as const, subscription: sub({ customer: "org_1" }) },
    ];
    expect(await billing.apply("stripe", events, { eventId: "evt_1" })).toBe("applied");
    expect(await billing.apply("stripe", events, { eventId: "evt_1" })).toBe("duplicate");
    expect(await ent.counters.claim(eventKey("stripe", "evt_1"), 1000)).toBe(false);
  });

  test("releases the claim when applying throws, so a retry is processed", async () => {
    const t = createTestEntitlements({
      catalog: billingCatalog,
      now: START,
      hooks: {
        before: () => {
          if (fail) throw new Error("db down");
        },
      },
    });
    let fail = true;
    const billing = createBilling(t.ent, { providers: [{ id: "stripe" }] });
    const events = [
      { type: "subscription.updated" as const, subscription: sub({ customer: "org_1" }) },
    ];
    await expect(billing.apply("stripe", events, { eventId: "evt_9" })).rejects.toThrow("db down");
    fail = false;
    expect(await billing.apply("stripe", events, { eventId: "evt_9" })).toBe("applied");
  });
});

describe("customer resolution", () => {
  test("unknown customer → ignored + onUnmapped(unknown_customer)", async () => {
    const { billing, unmapped } = setup();
    expect(
      await billing.apply("stripe", [{ type: "subscription.updated", subscription: sub() }]),
    ).toBe("ignored");
    expect(unmapped[0]).toMatchObject({ reason: "unknown_customer", providerCustomer: "cus_1" });
  });

  test("an empty provider customer is never linked", async () => {
    const { billing, ent } = setup();
    await billing.apply("stripe", [
      {
        type: "subscription.updated",
        subscription: sub({ providerCustomer: "", customer: "org_1" }),
      },
    ]);
    expect((await ent.getCustomer("org_1"))!.providers).toEqual({});
    expect(
      await billing.apply("stripe", [
        { type: "subscription.updated", subscription: sub({ providerCustomer: "" }) },
      ]),
    ).toBe("ignored");
  });

  test("default onUnmapped warns through the logger", async () => {
    const t = createTestEntitlements({ catalog: billingCatalog, now: START });
    const warn = vi.fn();
    const billing = createBilling(t.ent, { providers: [{ id: "stripe" }], logger: { warn } });
    await billing.apply("stripe", [{ type: "subscription.updated", subscription: sub() }]);
    await billing.apply("stripe", [
      {
        type: "subscription.updated",
        subscription: sub({ customer: "org_1", items: [{ id: "price_nope", quantity: 1 }] }),
      },
    ]);
    expect(warn.mock.calls.map((c) => c[0])).toEqual([
      expect.stringContaining("not linked"),
      expect.stringContaining("not mapped"),
    ]);
  });

  test("default logger is console.warn", async () => {
    const t = createTestEntitlements({ catalog: billingCatalog, now: START });
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const billing = createBilling(t.ent, { providers: [{ id: "stripe" }] });
    await billing.apply("stripe", [{ type: "subscription.updated", subscription: sub() }]);
    expect(spy).toHaveBeenCalledOnce();
    spy.mockRestore();
  });

  test("customer.updated links and copies email / name once", async () => {
    const { billing, ent, events } = setup();
    expect(
      await billing.apply("stripe", [
        {
          type: "customer.updated",
          providerCustomer: "cus_1",
          customer: "org_1",
          email: "a@acme.test",
          name: "Acme",
        },
      ]),
    ).toBe("applied");
    expect(await ent.getCustomer("org_1")).toMatchObject({
      email: "a@acme.test",
      name: "Acme",
      providers: { stripe: "cus_1" },
    });
    const n = events.length;
    // Same details, resolved through the link: no write.
    await billing.apply("stripe", [
      { type: "customer.updated", providerCustomer: "cus_1", email: "a@acme.test" },
    ]);
    expect(events.length).toBe(n);
    expect(
      await billing.apply("stripe", [{ type: "customer.updated", providerCustomer: "cus_x" }]),
    ).toBe("ignored");
  });
});

describe("mapping", () => {
  test("several plan items: the first owns the ref, the rest get item refs", async () => {
    const { billing, ent } = setup();
    await billing.apply("stripe", [
      {
        type: "subscription.updated",
        subscription: sub({
          customer: "org_1",
          items: [
            { id: "price_pro_m", quantity: 1 },
            { id: "price_biz_m", quantity: 1, itemRef: "si_2" },
            { id: "price_seats", quantity: 2 },
          ],
        }),
      },
    ]);
    const refs = (await ent.getCustomer("org_1"))!.subscriptions.map((s) => [
      s.plan,
      s.providerRef,
    ]);
    expect(refs).toEqual([
      ["pro", "sub_1"],
      ["business", "sub_1:si_2"],
      ["extra_seats", "sub_1:price_seats"],
    ]);
  });

  test("deleted with only unknown items still cancels what we stored", async () => {
    const { billing, ent } = setup();
    await billing.apply("stripe", [
      { type: "subscription.updated", subscription: sub({ customer: "org_1" }) },
    ]);
    const outcome = await billing.apply("stripe", [
      {
        type: "subscription.deleted",
        subscription: sub({ items: [{ id: "price_gone", quantity: 1 }], updatedAt: undefined }),
      },
    ]);
    expect(outcome).toBe("applied");
    const s = (await ent.getCustomer("org_1"))!.subscriptions[0]!;
    expect(s.status).toBe("canceled");
    expect(s.canceledAt).toBeDefined();
    // Nothing left to cancel → ignored.
    expect(
      await billing.apply("stripe", [
        { type: "subscription.deleted", subscription: sub({ items: [] }) },
      ]),
    ).toBe("ignored");
  });

  test("a deleted event without canceledAt stamps one", async () => {
    const { billing, ent } = setup();
    await billing.apply("stripe", [
      { type: "subscription.deleted", subscription: sub({ customer: "org_1" }) },
    ]);
    const s = (await ent.getCustomer("org_1"))!.subscriptions[0]!;
    expect(s.status).toBe("canceled");
    expect(s.canceledAt).toBe(new Date(Date.parse(START)).toISOString());
  });
});

describe("reconcile", () => {
  test("converges on the provider's state and cancels what it no longer reports", async () => {
    let remote: ProviderSubscription[] = [
      sub({ updatedAt: undefined }),
      sub({ ref: "sub_2", items: [{ id: "price_seats", quantity: 2, itemRef: "si_s" }] }),
    ];
    const fetchSubscriptions = vi.fn(async () => remote);
    const { billing, ent } = setup({ fetchSubscriptions });
    await ent.link("org_1", "stripe", "cus_1");
    expect(await billing.reconcile("org_1")).toEqual([
      { customer: "org_1", provider: "stripe", upserted: 2, canceled: 0 },
    ]);
    expect(fetchSubscriptions).toHaveBeenCalledWith("cus_1");
    remote = [sub({ updatedAt: "2026-11-20T10:05:00.000Z" })];
    expect(await billing.reconcile("org_1", "stripe")).toEqual([
      { customer: "org_1", provider: "stripe", upserted: 1, canceled: 1 },
    ]);
    const addon = (await ent.getCustomer("org_1"))!.subscriptions.find((s) => s.kind === "addon");
    expect(addon!.status).toBe("canceled");
  });

  test("unlinked customers and providers without fetch report zeros", async () => {
    const { billing } = setup({ fetchSubscriptions: async () => [] });
    expect(await billing.reconcile("org_1")).toEqual([
      { customer: "org_1", provider: "stripe", upserted: 0, canceled: 0 },
    ]);
    expect(await billing.reconcile("org_1", "manual")).toEqual([
      { customer: "org_1", provider: "manual", upserted: 0, canceled: 0 },
    ]);
    await expect(billing.reconcile("org_1", "nope")).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("checkout and portal link-outs", () => {
  test("checkout resolves the item, provider customer, email and trial", async () => {
    const createCheckout = vi.fn(async () => ({ url: "https://checkout.test/1" }));
    const { billing, ent } = setup({ createCheckout });
    await ent.updateCustomer("org_1", { email: "a@acme.test" });
    await ent.link("org_1", "stripe", "cus_1");
    expect(
      await billing.createCheckout("org_1", {
        plan: "pro",
        quantity: 1,
        successUrl: "https://app/ok",
        cancelUrl: "https://app/no",
      }),
    ).toEqual({ url: "https://checkout.test/1" });
    expect(createCheckout).toHaveBeenLastCalledWith({
      customer: "org_1",
      item: "price_pro_m",
      providerCustomer: "cus_1",
      email: "a@acme.test",
      quantity: 1,
      successUrl: "https://app/ok",
      cancelUrl: "https://app/no",
      trialDays: 14,
    });
    // Add-ons; no trial after one was used.
    await ent.startTrial("org_2", "pro");
    await billing.createCheckout("org_2", { plan: "pro", provider: "stripe" });
    expect(createCheckout).toHaveBeenLastCalledWith({ customer: "org_2", item: "price_pro_m" });
    await billing.createCheckout("org_2", { plan: "extra_seats", quantity: 3 });
    expect(createCheckout).toHaveBeenLastCalledWith({
      customer: "org_2",
      item: "price_seats",
      quantity: 3,
    });
  });

  test("checkout errors: unknown plan, unmapped plan, provider that cannot sell", async () => {
    const { billing } = setup({ createCheckout: async () => ({ url: "x" }) });
    await expect(billing.createCheckout("o", { plan: "nope" })).rejects.toThrow(/Unknown plan/);
    await expect(billing.createCheckout("o", { plan: "team" })).rejects.toThrow(
      /No billing provider/,
    );
    await expect(billing.createCheckout("o", { plan: "pro", provider: "manual" })).rejects.toThrow(
      /cannot sell/,
    );
  });

  test("portal needs a linked account with a portal-capable provider", async () => {
    const createPortalSession = vi.fn(async () => ({ url: "https://portal.test" }));
    const { billing, ent } = setup({ createPortalSession });
    await expect(billing.createPortalSession("org_1")).rejects.toBeInstanceOf(NotFoundError);
    await expect(billing.createPortalSession("org_1", { provider: "manual" })).rejects.toThrow(
      /with manual/,
    );
    await ent.link("org_1", "stripe", "cus_1");
    expect(await billing.createPortalSession("org_1", { returnUrl: "https://app" })).toEqual({
      url: "https://portal.test",
    });
    expect(createPortalSession).toHaveBeenCalledWith({
      customer: "org_1",
      providerCustomer: "cus_1",
      returnUrl: "https://app",
    });
    await billing.createPortalSession("org_1", { provider: "stripe" });
    expect(createPortalSession).toHaveBeenLastCalledWith({
      customer: "org_1",
      providerCustomer: "cus_1",
    });
  });
});

describe("usage export", () => {
  test("batches consumes to reportUsage with provider customers", async () => {
    const sent: UsageRecord[][] = [];
    const provider: BillingProvider = {
      id: "stripe",
      reportUsage: async (r) => void sent.push(r.map((x) => ({ ...x }))),
    };
    const exporter = createUsageExporter(provider, {
      meters: { api_calls: "api_requests" },
      batch: { size: 2, interval: 0 },
    });
    const t = createTestEntitlements({
      catalog: billingCatalog,
      now: START,
      onUsage: exporter.onUsage,
    });
    exporter.attach(t.ent);
    await t.ent.link("org_1", "stripe", "cus_1");
    await t.ent.consume("org_1", "api_calls", 5, { idempotencyKey: "req_1" });
    await t.ent.consume("org_1", "api_calls", 5, { idempotencyKey: "req_1" }); // duplicate
    await t.ent.consume("org_1", "seats", 1); // not metered for export
    await t.ent.release("org_1", "api_calls", 1); // negative: skipped
    expect(exporter.pending).toBe(1);
    await t.ent.consume("org_2", "api_calls", 2);
    await exporter.close();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toEqual([
      expect.objectContaining({
        customer: "org_1",
        providerCustomer: "cus_1",
        meter: "api_requests",
        amount: 5,
        idempotencyKey: "org_1:api_calls:req_1",
      }),
      expect.objectContaining({ customer: "org_2", amount: 2, meter: "api_requests" }),
    ]);
    expect(sent[0]![1]!.providerCustomer).toBeUndefined();
    await exporter.flush(); // nothing pending: no call
    expect(sent).toHaveLength(1);
  });

  test("interval flush and error reporting", async () => {
    vi.useFakeTimers();
    try {
      const onError = vi.fn();
      const exporter = createUsageExporter(
        { id: "polar", reportUsage: async () => Promise.reject(new Error("503")) },
        { meters: { api_calls: "calls" }, batch: { interval: "1s" }, onError },
      );
      const t = createTestEntitlements({ catalog: billingCatalog, onUsage: exporter.onUsage });
      await t.ent.consume("org_1", "api_calls", 1);
      await vi.advanceTimersByTimeAsync(1100);
      expect(onError).toHaveBeenCalledWith(expect.any(Error), [
        expect.objectContaining({ amount: 1 }),
      ]);
      await exporter.close();
    } finally {
      vi.useRealTimers();
    }
  });

  test("default error reporter warns; providers without reportUsage are rejected", async () => {
    expect(() => createUsageExporter({ id: "paddle" }, { meters: {} })).toThrow(/cannot report/);
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const exporter = createUsageExporter(
      { id: "x", reportUsage: async () => Promise.reject(new Error("boom")) },
      { meters: { api_calls: "m" }, sources: ["consume"] },
    );
    exporter.onUsage({
      customer: "c",
      feature: "api_calls",
      amount: 1,
      source: "consume",
      at: START,
      result: {
        allowed: true,
        feature: "api_calls",
        kind: "metered",
        reason: "within_limit",
        unlockedBy: [],
      },
    });
    exporter.onUsage({
      customer: "c",
      feature: "api_calls",
      amount: 1,
      source: "settle",
      at: START,
      result: {
        allowed: true,
        feature: "api_calls",
        kind: "metered",
        reason: "within_limit",
        unlockedBy: [],
      },
    });
    expect(exporter.pending).toBe(1);
    await exporter.close();
    expect(spy).toHaveBeenCalledWith(
      expect.stringContaining("1 records dropped"),
      expect.any(Error),
    );
    spy.mockRestore();
  });
});

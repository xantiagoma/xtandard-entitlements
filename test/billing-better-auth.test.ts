import type { StripeOptions, SubscriptionOptions } from "@better-auth/stripe";
import { describe, expect, test } from "vitest";
import {
  betterAuthStripe,
  toBetterAuthPlans,
  type BetterAuthStripeSubscription,
} from "../src/billing/better-auth.ts";
import { createBilling } from "../src/billing/intake.ts";
import { createTestEntitlements } from "../src/testing.ts";
import { billingCatalog, stripeSubscription, type SubState } from "./billing-fixtures.ts";

const START = "2026-11-20T10:00:00Z";
const state: SubState = {
  ref: "sub_ba1",
  providerCustomer: "cus_ba1",
  status: "active",
  items: [{ id: "price_pro_m", quantity: 1, itemRef: "si_1" }],
  periodStart: "2026-11-20T10:00:00.000Z",
  periodEnd: "2026-12-20T10:00:00.000Z",
  updatedAt: START,
};
const row = (patch: Partial<BetterAuthStripeSubscription> = {}): BetterAuthStripeSubscription => ({
  id: "row_1",
  plan: "pro",
  referenceId: "org_1",
  stripeCustomerId: "cus_ba1",
  stripeSubscriptionId: "sub_ba1",
  priceId: "price_pro_m",
  status: "active",
  ...patch,
});
const event = (id: string, created = 1_795_000_000) => ({ id, created });

describe("betterAuthStripe", () => {
  test("its callbacks and plans type-check against @better-auth/stripe's subscription options", () => {
    const { ent } = createTestEntitlements({ catalog: billingCatalog });
    const fragment = betterAuthStripe(ent);
    const options: NonNullable<StripeOptions["subscription"]> = { enabled: true, ...fragment };
    const callbacks: Pick<
      SubscriptionOptions,
      | "onSubscriptionComplete"
      | "onSubscriptionCreated"
      | "onSubscriptionUpdate"
      | "onSubscriptionCancel"
      | "onSubscriptionDeleted"
      | "plans"
    > = fragment;
    expect(options.enabled).toBe(true);
    expect(callbacks.plans).toHaveLength(2);
  });

  test("plans from the catalog: price, limits, trial, group", () => {
    expect(toBetterAuthPlans(billingCatalog)).toEqual([
      {
        name: "pro",
        priceId: "price_pro_m",
        limits: {
          seats: 10,
          api_calls: 100_000,
          export_pdf: true,
          max_upload_mb: 500,
          support: "email",
        },
        freeTrial: { days: 14 },
      },
      {
        name: "business",
        priceId: "price_biz_m",
        limits: { seats: 50, api_calls: null, export_pdf: true, sso: true, support: "priority" },
      },
    ]);
    expect(toBetterAuthPlans(billingCatalog, { provider: "paddle" }).map((p) => p.priceId)).toEqual(
      ["pri_pro", "pri_biz"],
    );
  });

  test("plan groups, excluded features and hidden plans", async () => {
    const { defineCatalog, feature } = await import("../src/catalog.ts");
    const c = defineCatalog({
      features: { seats: feature.capacity(), api: feature.metered({ reset: "month" }) },
      plans: {
        a: {
          group: "addons",
          hidden: true,
          providers: { stripe: ["p_a"] },
          features: { seats: 1, api: false },
        },
        b: { features: {} },
      },
    });
    expect(toBetterAuthPlans(c)).toEqual([
      { name: "a", priceId: "p_a", group: "addons", limits: { seats: 1, api: 0 } },
    ]);
    expect(toBetterAuthPlans(c, { includeHidden: false })).toEqual([]);
  });

  test("callbacks feed subscriptions (referenceId = customer); event ids dedupe", async () => {
    const { ent } = createTestEntitlements({ catalog: billingCatalog, now: START });
    const ba = betterAuthStripe(ent);
    await ba.onSubscriptionComplete({
      event: event("evt_1"),
      stripeSubscription: stripeSubscription({
        ...state,
        status: "trialing",
        trialEnd: "2026-12-04T10:00:00.000Z",
      }),
      subscription: row({ status: "trialing" }),
    });
    let sub = (await ent.getCustomer("org_1"))!.subscriptions[0]!;
    expect(sub).toMatchObject({
      plan: "pro",
      version: 2,
      status: "trialing",
      provider: "stripe",
      providerRef: "sub_ba1",
    });
    expect(await ent.resolveLink("stripe", "cus_ba1")).toBe("org_1");

    // Upgrade + cancel delivered by the same Stripe event: applied once.
    const upgraded = stripeSubscription({
      ...state,
      items: [{ id: "price_biz_m", quantity: 1, itemRef: "si_1" }],
      cancelAtPeriodEnd: true,
    });
    await ba.onSubscriptionUpdate({
      event: event("evt_2", 1_795_000_100),
      stripeSubscription: upgraded,
      subscription: row(),
    });
    await ba.onSubscriptionCancel({
      event: event("evt_2", 1_795_000_100),
      stripeSubscription: upgraded,
      subscription: row(),
    });
    sub = (await ent.getCustomer("org_1"))!.subscriptions[0]!;
    expect(sub).toMatchObject({ plan: "business", cancelAtPeriodEnd: true });
    expect(sub.providerUpdatedAt).toBe(new Date(1_795_000_100_000).toISOString());

    await ba.onSubscriptionDeleted({
      event: event("evt_3", 1_795_000_200),
      stripeSubscription: { ...upgraded, status: "canceled" },
      subscription: row({ status: "canceled" }),
    });
    expect((await ent.getCustomer("org_1"))!.subscriptions[0]!.status).toBe("canceled");
  });

  test("falls back to the plugin row without a Stripe object; custom customer mapping", async () => {
    const { ent } = createTestEntitlements({ catalog: billingCatalog, now: START });
    const ba = betterAuthStripe(ent, { customerId: (s) => `team:${s.referenceId}` });
    await ba.onSubscriptionCreated({
      subscription: row({
        seats: 2,
        priceId: "price_seats",
        periodStart: new Date("2026-11-20T10:00:00Z"),
        periodEnd: new Date("2026-12-20T10:00:00Z"),
        trialEnd: new Date("2026-12-01T10:00:00Z"),
        cancelAtPeriodEnd: false,
        canceledAt: new Date("2026-11-20T10:00:00Z"),
        status: "unpaid",
      }),
    });
    const sub = (await ent.getCustomer("team:org_1"))!.subscriptions[0]!;
    expect(sub).toMatchObject({
      plan: "extra_seats",
      kind: "addon",
      quantity: 2,
      status: "paused",
      periodEnd: "2026-12-20T10:00:00.000Z",
      trialEndsAt: "2026-12-01T10:00:00.000Z",
      canceledAt: "2026-11-20T10:00:00.000Z",
    });
    // A row without price or Stripe ids maps to nothing.
    await ba.onSubscriptionUpdate({
      subscription: row({
        priceId: undefined,
        stripeSubscriptionId: undefined,
        stripeCustomerId: undefined,
      }),
    });
    expect((await ent.getCustomer("team:org_1"))!.subscriptions).toHaveLength(1);
  });

  test("accepts an existing billing intake (plans need the catalog)", async () => {
    const { ent } = createTestEntitlements({ catalog: billingCatalog, now: START });
    const billing = createBilling(ent, { providers: [{ id: "stripe" }] });
    expect(betterAuthStripe(billing).plans).toEqual([]);
    const ba = betterAuthStripe(billing, { catalog: billingCatalog });
    expect(ba.plans).toHaveLength(2);
    await ba.onSubscriptionUpdate({
      stripeSubscription: { ...stripeSubscription(state), customer: "" },
      subscription: row(),
    });
    expect((await ent.getCustomer("org_1"))!.providers).toEqual({ stripe: "cus_ba1" });
  });
});

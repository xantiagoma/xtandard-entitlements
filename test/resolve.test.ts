import { describe, expect, it } from "vitest";
import {
  emptyCustomerState,
  resolveEntitlements,
  subscriptionInactiveReason,
  unlockingPlans,
} from "../src/resolve.ts";
import type { CustomerState, Subscription } from "../src/schema.ts";
import { catalog } from "./fixtures.ts";

const NOW = Date.parse("2026-11-20T12:00:00Z");
const iso = (s: string) => new Date(Date.parse(s)).toISOString();

const sub = (over: Partial<Subscription>): Subscription => ({
  id: over.id ?? `sub_${over.plan}`,
  plan: "pro",
  version: 2,
  kind: "plan",
  status: "active",
  quantity: 1,
  provider: "manual",
  createdAt: iso("2026-11-01T00:00:00Z"),
  updatedAt: iso("2026-11-01T00:00:00Z"),
  ...over,
});

const state = (over: Partial<CustomerState>): CustomerState => ({
  ...emptyCustomerState("org_1", Date.parse("2026-01-01T00:00:00Z")),
  ...over,
});

describe("resolveEntitlements", () => {
  it("unknown customer → default plan only", () => {
    const set = resolveEntitlements(catalog, null, NOW);
    expect(set.plans).toEqual([{ plan: "free", version: 1, group: "base", default: true }]);
    expect(set.features.api_calls).toMatchObject({
      enabled: true,
      allowance: 1_000,
      limit: 1_000,
      period: { key: "m:2026-11" },
    });
    expect(set.features.export_pdf!.enabled).toBe(false);
    expect(set.features.max_upload_mb!.value).toBe(10);
    expect(set.features.ai_credits).toMatchObject({ enabled: false, limit: 0 });
    expect(set.validUntil).toBe("2026-11-21T00:00:00.000Z"); // daily exports period ends first
  });

  it("an entitled subscription replaces the default in its group", () => {
    const set = resolveEntitlements(catalog, state({ subscriptions: [sub({ plan: "pro" })] }), NOW);
    expect(set.plans.map((p) => p.plan)).toEqual(["pro"]);
    expect(set.features.seats).toMatchObject({ allowance: 10, limit: 10 });
    expect(set.features.projects).toMatchObject({ allowance: null, limit: null });
    expect(set.features.api_calls).toMatchObject({ overagePolicy: "allow", overageLimit: null });
    expect(set.features.support!.value).toBe("email");
    expect(set.features.export_pdf!.sources).toEqual([
      { type: "plan", id: "pro", version: 2, subscriptionId: "sub_pro" },
    ]);
  });

  it("grandfathered version pins old limits", () => {
    const set = resolveEntitlements(
      catalog,
      state({ subscriptions: [sub({ plan: "pro", version: 1 })] }),
      NOW,
    );
    expect(set.plans[0]).toMatchObject({ plan: "pro", version: 1 });
    expect(set.features.seats!.limit).toBe(5);
    expect(set.features.ai_credits!.enabled).toBe(false);
  });

  it("inactive subscriptions fall back to the default and are reported", () => {
    const subs = [
      sub({ id: "s1", plan: "pro", status: "canceled" }),
      sub({
        id: "s2",
        plan: "business",
        status: "trialing",
        trialEndsAt: iso("2026-11-19T00:00:00Z"),
      }),
      sub({
        id: "s3",
        plan: "pro",
        cancelAtPeriodEnd: true,
        periodEnd: iso("2026-11-10T00:00:00Z"),
      }),
      sub({ id: "s4", plan: "ghost" }),
    ];
    const set = resolveEntitlements(catalog, state({ subscriptions: subs }), NOW);
    expect(set.plans.map((p) => p.plan)).toEqual(["free"]);
    expect(set.inactive.map((i) => `${i.subscriptionId}:${i.reason}`)).toEqual([
      "s1:status:canceled",
      "s2:trial_expired",
      "s3:period_ended",
      "s4:unknown_plan",
    ]);
  });

  it("past_due is entitled by default but configurable", () => {
    const s = state({ subscriptions: [sub({ status: "past_due" })] });
    expect(resolveEntitlements(catalog, s, NOW).plans[0]!.plan).toBe("pro");
    expect(
      resolveEntitlements(catalog, s, NOW, { entitledStatuses: ["active"] }).plans[0]!.plan,
    ).toBe("free");
    expect(subscriptionInactiveReason(sub({ status: "paused" }), NOW)).toBe("status:paused");
  });

  it("one plan per group: newest wins, others superseded", () => {
    const subs = [
      sub({ id: "old", plan: "pro", createdAt: iso("2026-10-01T00:00:00Z") }),
      sub({ id: "new", plan: "business", version: 1, createdAt: iso("2026-11-05T00:00:00Z") }),
    ];
    const set = resolveEntitlements(catalog, state({ subscriptions: subs }), NOW);
    expect(set.plans.map((p) => p.plan)).toEqual(["business"]);
    expect(set.inactive).toEqual([{ subscriptionId: "old", plan: "pro", reason: "superseded" }]);
  });

  it("add-ons stack with quantity and honor requires", () => {
    const subs = [
      sub({ plan: "pro" }),
      sub({ id: "a1", plan: "extra_seats", kind: "addon", version: 1, quantity: 3 }),
      sub({ id: "a2", plan: "sso_addon", kind: "addon", version: 1 }),
    ];
    const set = resolveEntitlements(catalog, state({ subscriptions: subs }), NOW);
    expect(set.features.seats!.limit).toBe(25);
    expect(set.features.sso!.enabled).toBe(true);
    const free = resolveEntitlements(catalog, state({ subscriptions: subs.slice(1) }), NOW);
    expect(free.addons.find((a) => a.addon === "sso_addon")!.applied).toBe(false);
    expect(free.features.sso!.enabled).toBe(false);
    expect(free.features.seats!.limit).toBe(18);
  });

  it("grants: recurring add to the allowance, one-off become ordered buckets", () => {
    const s = state({
      grants: [
        {
          id: "g_late",
          feature: "api_calls",
          amount: 100,
          priority: 0,
          createdAt: iso("2026-11-01T00:00:00Z"),
        },
        {
          id: "g_soon",
          feature: "api_calls",
          amount: 50,
          priority: 0,
          expiresAt: iso("2026-12-01T00:00:00Z"),
          createdAt: iso("2026-11-01T00:00:00Z"),
        },
        {
          id: "g_first",
          feature: "api_calls",
          amount: 10,
          priority: -1,
          createdAt: iso("2026-11-01T00:00:00Z"),
        },
        {
          id: "g_rec",
          feature: "api_calls",
          amount: 500,
          recurring: true,
          priority: 0,
          createdAt: iso("2026-11-01T00:00:00Z"),
        },
        {
          id: "g_exp",
          feature: "api_calls",
          amount: 999,
          priority: 0,
          expiresAt: iso("2026-11-01T00:00:00Z"),
          createdAt: iso("2026-10-01T00:00:00Z"),
        },
        {
          id: "g_future",
          feature: "api_calls",
          amount: 999,
          priority: 0,
          startsAt: iso("2026-11-25T00:00:00Z"),
          createdAt: iso("2026-10-01T00:00:00Z"),
        },
        {
          id: "g_credits",
          feature: "ai_credits",
          amount: 300,
          priority: 0,
          createdAt: iso("2026-11-01T00:00:00Z"),
        },
      ],
    });
    const set = resolveEntitlements(catalog, s, NOW);
    const api = set.features.api_calls!;
    expect(api.allowance).toBe(1_500);
    expect(api.grants!.map((g) => g.id)).toEqual(["g_first", "g_soon", "g_late"]);
    expect(api.limit).toBe(1_660);
    expect(set.features.ai_credits).toMatchObject({ enabled: true, allowance: 0, limit: 300 });
    expect(set.validUntil).toBe("2026-11-21T00:00:00.000Z");
  });

  it("overrides replace the merged result; expired ones don't apply", () => {
    const s = state({
      subscriptions: [sub({ plan: "pro" })],
      overrides: [
        { id: "o1", feature: "export_pdf", enabled: false, createdAt: iso("2026-11-01T00:00:00Z") },
        { id: "o2", feature: "sso", enabled: true, createdAt: iso("2026-11-01T00:00:00Z") },
        { id: "o3", feature: "seats", limit: 40, createdAt: iso("2026-11-01T00:00:00Z") },
        { id: "o4", feature: "support", value: "vip", createdAt: iso("2026-11-01T00:00:00Z") },
        {
          id: "o5",
          feature: "exports",
          limit: 1,
          expiresAt: iso("2026-11-02T00:00:00Z"),
          createdAt: iso("2026-11-01T00:00:00Z"),
        },
        { id: "o6", feature: "ai_credits", enabled: false, createdAt: iso("2026-11-01T00:00:00Z") },
        {
          id: "o7",
          feature: "api_calls",
          overage: "block",
          createdAt: iso("2026-11-01T00:00:00Z"),
        },
      ],
    });
    const set = resolveEntitlements(catalog, s, NOW);
    expect(set.features.export_pdf).toMatchObject({ enabled: false, override: "o1" });
    expect(set.features.sso).toMatchObject({ enabled: true, override: "o2" });
    expect(set.features.seats!.limit).toBe(40);
    expect(set.features.support!.value).toBe("vip");
    expect(set.features.exports!.limit).toBe(100);
    expect(set.features.ai_credits).toMatchObject({ enabled: false, limit: 0 });
    expect(set.features.api_calls!.overagePolicy).toBe("block");
  });

  it("enabled override on a numeric feature the plan lacks = unlimited", () => {
    const s = state({
      overrides: [
        { id: "o", feature: "ai_credits", enabled: true, createdAt: iso("2026-11-01T00:00:00Z") },
      ],
    });
    expect(resolveEntitlements(catalog, s, NOW).features.ai_credits).toMatchObject({
      enabled: true,
      limit: null,
    });
  });

  it("billing_period features follow the base subscription period", () => {
    const s = state({
      subscriptions: [
        sub({
          plan: "pro",
          periodStart: iso("2026-11-14T08:00:00Z"),
          periodEnd: iso("2026-12-14T08:00:00Z"),
        }),
      ],
    });
    expect(resolveEntitlements(catalog, s, NOW).features.ai_credits!.period!.key).toBe(
      "bp:2026-11-14T08:00:00.000Z",
    );
  });
});

describe("unlockingPlans", () => {
  it("lists cheaper plans first and skips hidden/active ones", () => {
    expect(unlockingPlans(catalog, "export_pdf", 1)).toEqual(["pro", "business"]);
    expect(unlockingPlans(catalog, "sso", 1)).toEqual(["business"]);
    expect(unlockingPlans(catalog, "sso", 1, ["pro"])).toEqual(["sso_addon", "business"]);
    expect(unlockingPlans(catalog, "seats", 30)).toEqual(["extra_seats", "business"]);
    expect(unlockingPlans(catalog, "export_pdf", 1, ["pro"])).toEqual(["business"]);
    expect(unlockingPlans(catalog, "api_calls", 10_000_000)).toEqual(["pro"]);
    expect(unlockingPlans(catalog, "nope", 1)).toEqual([]);
  });
});

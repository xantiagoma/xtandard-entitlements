import { describe, expect, test } from "vitest";
import { pricingTable } from "../src/catalog.ts";
import {
  computeEntitlement,
  covers,
  currentPlanOf,
  customerInfo,
  formatCount,
  isNumericKind,
  loadingState,
  meterState,
  monthlyPrice,
  unlockersFromPricing,
} from "../src/react/compute.ts";
import type { FeatureUsage } from "../src/schema.ts";
import { catalog, portalData } from "./react-fixtures.ts";

const pricing = pricingTable(catalog);

describe("computeEntitlement", () => {
  test("null data → loading, not allowed", () => {
    const s = computeEntitlement(null, "export_pdf");
    expect(s).toMatchObject({ loading: true, allowed: false, enabled: false, kind: "unknown" });
    expect(loadingState()).toEqual(s);
  });

  test("unknown feature → not loading, not allowed, no unlockers", async () => {
    const data = await portalData(async () => {});
    expect(computeEntitlement(data, "nope")).toMatchObject({
      loading: false,
      allowed: false,
      kind: "unknown",
      unlockedBy: [],
    });
  });

  test("boolean not in plan → blocked with the cheapest unlocking plan first", async () => {
    const data = await portalData(async () => {});
    const s = computeEntitlement(data, "export_pdf");
    expect(s).toMatchObject({ allowed: false, enabled: false, kind: "boolean", loading: false });
    expect(s.unlockedBy).toEqual(["pro", "business"]);
    expect(s.limit).toBeUndefined();
    expect(s.used).toBeUndefined();
  });

  test("boolean in plan → allowed, nothing to unlock", async () => {
    const data = await portalData(
      async (ent) => void (await ent.subscribe("org_1", { plan: "pro" })),
    );
    expect(computeEntitlement(data, "export_pdf")).toMatchObject({ allowed: true, unlockedBy: [] });
  });

  test("metered within limit, then over it (amount-aware)", async () => {
    const data = await portalData(
      async (ent) => void (await ent.consume("org_1", "api_calls", 990)),
    );
    const s = computeEntitlement(data, "api_calls");
    expect(s).toMatchObject({
      allowed: true,
      enabled: true,
      kind: "metered",
      limit: 1_000,
      used: 990,
      remaining: 10,
      overage: 0,
    });
    expect(s.resetsAt).toBe("2026-12-01T00:00:00.000Z");
    const big = computeEntitlement(data, "api_calls", 50);
    expect(big.allowed).toBe(false);
    // Free is active, so it never unlocks itself; pro covers 1,040 calls.
    expect(big.unlockedBy).toEqual(["pro", "business"]);
  });

  test("capacity counts seats in use", async () => {
    const data = await portalData(async (ent) => void (await ent.setUsage("org_1", "seats", 3)));
    expect(computeEntitlement(data, "seats")).toMatchObject({
      allowed: false,
      used: 3,
      limit: 3,
      remaining: 0,
    });
    // An add-on needs pro/business, which the customer lacks.
    expect(computeEntitlement(data, "seats").unlockedBy).toEqual(["pro", "business"]);
  });

  test("value features return their value", async () => {
    const free = await portalData(async () => {});
    expect(computeEntitlement<number>(free, "max_upload_mb")).toMatchObject({
      allowed: true,
      value: 10,
      kind: "value",
    });
    const pro = await portalData(
      async (ent) => void (await ent.subscribe("org_1", { plan: "pro" })),
    );
    expect(computeEntitlement<number>(pro, "max_upload_mb").value).toBe(500);
  });

  test("disabled by override → blocked and nothing unlocks it", async () => {
    const data = await portalData(async (ent) => {
      await ent.subscribe("org_1", { plan: "pro" });
      await ent.override("org_1", { feature: "export_pdf", enabled: false, reason: "abuse" });
    });
    expect(computeEntitlement(data, "export_pdf")).toMatchObject({
      allowed: false,
      unlockedBy: [],
    });
  });

  test("unlimited override → allowed, remaining null", async () => {
    const data = await portalData(async (ent) => {
      await ent.override("org_1", { feature: "api_calls", limit: null, reason: "comp" });
      await ent.consume("org_1", "api_calls", 5_000);
    });
    expect(computeEntitlement(data, "api_calls", 1e9)).toMatchObject({
      allowed: true,
      limit: null,
      remaining: null,
    });
  });

  test("works on plain CustomerEntitlements (no pricing → no unlockers)", async () => {
    const data = await portalData(async () => {});
    const { pricing: _p, profile: _pr, canCheckout: _c, canManage: _m, ...bare } = data;
    expect(computeEntitlement(bare, "export_pdf")).toMatchObject({
      allowed: false,
      unlockedBy: [],
    });
  });
});

describe("covers (overage)", () => {
  const base: FeatureUsage = {
    key: "x",
    kind: "metered",
    enabled: true,
    allowance: 100,
    limit: 100,
    used: 100,
    remaining: 0,
    sources: [],
  };
  test("block at the limit", () => expect(covers(base, 1)).toBe(false));
  test("unbounded overage", () =>
    expect(covers({ ...base, overagePolicy: "allow" }, 1e6)).toBe(true));
  test("bounded overage", () => {
    const u = { ...base, overagePolicy: "allow" as const, overageLimit: 20, used: 110 };
    expect(covers(u, 10)).toBe(true);
    expect(covers(u, 11)).toBe(false);
  });
  test("overage with unlimited allowance", () =>
    expect(covers({ ...base, overagePolicy: "allow", allowance: null, limit: 5 }, 99)).toBe(true));
  test("one-off grant usage doesn't eat overage room", () => {
    const u = {
      ...base,
      overagePolicy: "allow" as const,
      overageLimit: 10,
      used: 150,
      grantBalances: [{ id: "g", amount: 50, used: 50 }],
    };
    expect(covers(u, 10)).toBe(true);
  });
  test("remaining derived from limit when absent", () =>
    expect(covers({ ...base, remaining: undefined, used: 40 }, 60)).toBe(true));
  test("non-numeric and disabled", () => {
    expect(covers({ ...base, kind: "boolean" }, 5)).toBe(true);
    expect(covers({ ...base, enabled: false }, 0)).toBe(false);
    expect(covers({ ...base, limit: undefined }, 5)).toBe(true);
  });
});

describe("unlockersFromPricing", () => {
  test("no pricing → []", () => expect(unlockersFromPricing(undefined, "sso", 1)).toEqual([]));
  test("needs enough units; overage plans always qualify", () => {
    expect(unlockersFromPricing(pricing, "api_calls", 200_000)).toEqual(["business"]);
    expect(unlockersFromPricing(pricing, "api_calls", 500)).toEqual(["free", "pro", "business"]);
  });
  test("add-ons need their required plan", () => {
    expect(unlockersFromPricing(pricing, "seats", 12, ["pro"])).toEqual([
      "extra_seats",
      "business",
    ]);
    expect(unlockersFromPricing(pricing, "seats", 12, [])).toEqual(["business"]);
  });
  test("cheapest first, by monthly price", () => {
    const yearly = {
      ...pricing,
      plans: pricing.plans.map((p) =>
        p.key === "business"
          ? { ...p, price: [{ amount: 12_000, currency: "usd", interval: "year" as const }] }
          : p,
      ),
    };
    expect(unlockersFromPricing(yearly, "export_pdf", 1)).toEqual(["business", "pro"]);
  });
});

describe("meterState", () => {
  test("levels", () => {
    expect(meterState({ enabled: false, limit: 10, used: 1 })).toEqual({
      ratio: null,
      level: "disabled",
    });
    expect(meterState({ enabled: true, limit: null, used: 1 })).toEqual({
      ratio: null,
      level: "unlimited",
    });
    expect(meterState({ enabled: true, limit: 100, used: 10 }).level).toBe("ok");
    expect(meterState({ enabled: true, limit: 100, used: 75 }).level).toBe("warn");
    expect(meterState({ enabled: true, limit: 100, used: 90 }).level).toBe("critical");
    expect(meterState({ enabled: true, limit: 0, used: 0 })).toEqual({ ratio: 0, level: "ok" });
    expect(meterState({ enabled: true, limit: 0, used: 2 })).toEqual({
      ratio: 1,
      level: "critical",
    });
    expect(meterState({ enabled: true, limit: 10, used: undefined }).ratio).toBe(0);
  });
});

describe("customer helpers", () => {
  test("current plan and info for a trialing customer", async () => {
    const data = await portalData(async (ent) => {
      await ent.updateCustomer("org_1", { name: "Acme", email: "billing@acme.test" });
      await ent.startTrial("org_1", "pro");
    });
    expect(currentPlanOf(data)?.plan).toBe("pro");
    expect(customerInfo(data)).toMatchObject({
      id: "org_1",
      name: "Acme",
      email: "billing@acme.test",
      plan: "pro",
      planName: "Pro",
      status: "trialing",
      isDefault: false,
      cancelAtPeriodEnd: false,
      canCheckout: true,
      canManage: false,
      loading: false,
    });
    expect(customerInfo(data).trialEndsAt).toBe("2026-11-24T12:00:00.000Z");
  });

  test("default plan and loading", async () => {
    const data = await portalData(async () => {});
    expect(customerInfo(data)).toMatchObject({ plan: "free", isDefault: true, planName: "Free" });
    expect(customerInfo(null)).toMatchObject({
      loading: true,
      plan: undefined,
      planName: undefined,
    });
    expect(currentPlanOf(null)).toBeUndefined();
    const { pricing: _p, profile: _pr, canCheckout: _c, canManage: _m, ...bare } = data;
    expect(customerInfo(bare)).toMatchObject({ id: "org_1", planName: "free", canCheckout: false });
  });
});

test("misc helpers", () => {
  expect(isNumericKind("capacity")).toBe(true);
  expect(isNumericKind("value")).toBe(false);
  expect(monthlyPrice(undefined)).toBe(0);
  expect(monthlyPrice([{ amount: 1200, currency: "usd", interval: "year" }])).toBe(100);
  expect(monthlyPrice([{ amount: 120, currency: "usd", interval: "week" }])).toBe(520);
  expect(monthlyPrice([{ amount: 10, currency: "usd", interval: "day" }])).toBe(300);
  expect(monthlyPrice([{ amount: 500, currency: "usd" }])).toBe(500);
  expect(formatCount(1234.567)).toBe("1,234.57");
});

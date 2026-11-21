import { describe, expect, it } from "vitest";
import {
  CatalogError,
  defineCatalog,
  feature,
  getPlanVersion,
  pricingTable,
} from "../src/catalog.ts";
import { catalog } from "./fixtures.ts";

describe("defineCatalog", () => {
  it("normalizes features with defaults", () => {
    const f = catalog.normalized.features;
    expect(f.get("api_calls")).toMatchObject({
      kind: "metered",
      reset: "month",
      unit: "call",
      units: "calls",
      metering: "strict",
      thresholds: [0.8, 1],
    });
    expect(f.get("max_upload_mb")).toMatchObject({ kind: "value", default: 10 });
    expect(f.get("gpt_tokens")?.creditCost).toEqual({ ai_credits: 0.01 });
    expect(catalog.featureKeys).toContain("sso");
    expect(catalog.planKeys).toEqual(["free", "pro", "business", "enterprise"]);
    expect(catalog.addonKeys).toEqual(["extra_seats", "sso_addon"]);
  });

  it("normalizes plan entries: numbers, unlimited, specs, booleans, values", () => {
    const pro = catalog.normalized.plans.get("pro")!;
    expect(pro.version).toBe(2);
    expect(pro.current).toBe(true);
    expect(pro.trialDays).toBe(14);
    expect(pro.features.seats).toMatchObject({
      kind: "capacity",
      included: true,
      limit: 10,
      overage: "block",
    });
    expect(pro.features.projects).toMatchObject({ limit: null });
    expect(pro.features.api_calls).toMatchObject({
      limit: 100_000,
      overage: "allow",
      overageLimit: null,
      reset: "month",
    });
    expect(pro.features.export_pdf).toEqual({ kind: "boolean", enabled: true });
    expect(pro.features.support).toEqual({ kind: "value", value: "email" });
    const biz = catalog.normalized.plans.get("business")!;
    expect(biz.features.api_calls).toMatchObject({ overageLimit: 500_000 });
  });

  it("keeps previous plan versions and indexes provider ids per version", () => {
    const v1 = getPlanVersion(catalog, "pro", 1)!;
    expect(v1).toMatchObject({ version: 1, current: false });
    expect(v1.features.seats).toMatchObject({ limit: 5 });
    expect(getPlanVersion(catalog, "pro", 99)?.version).toBe(2);
    expect(getPlanVersion(catalog, "nope")).toBeUndefined();
    expect(catalog.normalized.providerIndex.get("stripe:price_pro_legacy")).toEqual({
      type: "plan",
      key: "pro",
      version: 1,
    });
    expect(catalog.normalized.providerIndex.get("stripe:price_seats")).toEqual({
      type: "addon",
      key: "extra_seats",
    });
    expect(catalog.normalized.defaults.get("base")).toBe("free");
  });

  it("normalizes add-ons", () => {
    const a = catalog.normalized.addons.get("extra_seats")!;
    expect(a).toMatchObject({ quantity: true, requires: [] });
    expect(a.features.seats).toEqual({ kind: "capacity", add: 5 });
    expect(catalog.normalized.addons.get("sso_addon")!.requires).toEqual(["pro"]);
  });

  it("collects every problem into one CatalogError", () => {
    let error: CatalogError | undefined;
    try {
      defineCatalog({
        features: {
          a: feature.metered({ reset: "fortnight" as "month" }),
          b: feature.metered({ reset: "month", creditCost: { a: 1, missing: 2 } }),
          c: feature.boolean(),
          "bad key!": feature.boolean(),
        },
        plans: {
          one: {
            default: true,
            features: { a: -1, c: "yes" as unknown as boolean, zzz: 1 } as never,
            providers: { stripe: ["p1"] },
          },
          two: {
            default: true,
            version: 2,
            previous: { 3: { features: {} } },
            providers: { stripe: ["p1"] },
            features: { a: { limit: 1, overage: "maybe" as "allow" } },
          },
        },
        addons: { one: { requires: ["nope"], features: { c: false as unknown as true } } },
      });
    } catch (e) {
      error = e as CatalogError;
    }
    expect(error).toBeInstanceOf(CatalogError);
    const text = error!.problems.join("\n");
    for (const needle of [
      'feature "a": reset must be',
      'creditCost target "a" is not a credits feature',
      'creditCost references unknown "missing"',
      "bad key!",
      'unknown feature "zzz"',
      "limit must be a finite number >= 0",
      "expected true or false",
      'already has default plan "one"',
      'id "p1" is already mapped',
      "previous version 3",
      'overage must be "block" or "allow"',
      'requires unknown plan "nope"',
      "a plan has the same key",
      "add-ons can only enable boolean features",
    ]) {
      expect(text).toContain(needle);
    }
  });

  it("requires at least one plan", () => {
    expect(() => defineCatalog({ features: {}, plans: {} })).toThrow(/at least one plan/);
  });
});

describe("pricingTable", () => {
  it("renders display-ready cells and hides hidden plans", () => {
    const t = pricingTable(catalog);
    expect(t.plans.map((p) => p.key)).toEqual(["free", "pro", "business"]);
    const pro = t.plans.find((p) => p.key === "pro")!;
    expect(pro.features.api_calls).toMatchObject({
      included: true,
      limit: 100_000,
      label: "100,000 calls / month",
      overage: "allow",
    });
    expect(pro.features.projects!.label).toBe("Unlimited");
    expect(pro.features.export_pdf!.label).toBe("✓");
    expect(pro.features.sso).toEqual({ included: false, label: "—" });
    expect(pro.features.max_upload_mb).toMatchObject({ value: 500, label: "500" });
    expect(pro.trialDays).toBe(14);
    expect(pro.highlight).toBe(true);
    const free = t.plans[0]!;
    expect(free.features.ai_credits).toEqual({ included: false, label: "—" });
    expect(free.features.support!.label).toBe("community");
    expect(free.features.seats!.label).toBe("3 seats");
    expect(t.addons.find((a) => a.key === "extra_seats")!.features.seats!.label).toBe("+5 seats");
    expect(pricingTable(catalog, { includeHidden: true }).plans).toHaveLength(4);
    expect(JSON.parse(JSON.stringify(t))).toEqual(t);
  });
});

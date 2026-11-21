import { OpenFeature, type EvaluationContext } from "@openfeature/server-sdk";
import { createOpenFeatureProvider } from "@xtandard/flags/openfeature";
import { booleanFlag, createTestPanel, publishFlags, variantFlag } from "@xtandard/flags/testing";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  createEntitlementsHook,
  createEntitlementsProvider,
  entitlementsContext,
  toOpenFeatureReason,
} from "../src/flags.ts";
import { createTestEntitlements } from "../src/testing.ts";
import { billingCatalog } from "./billing-fixtures.ts";

const START = "2026-11-20T10:00:00Z";

async function setup() {
  const t = createTestEntitlements({ catalog: billingCatalog, now: START });
  await t.ent.subscribe("org_pro", { plan: "pro" });
  await t.ent.subscribe("org_pro", { plan: "team" });
  await t.ent.subscribe("org_pro", { plan: "extra_seats", quantity: 1 });
  await t.ent.consume("org_pro", "api_calls", 250);
  await t.ent.subscribe("org_biz", { plan: "business" });
  return t;
}

afterEach(async () => {
  await OpenFeature.clearProviders();
  OpenFeature.clearHooks();
});

describe("entitlementsContext", () => {
  test("flat attributes with usage", async () => {
    const { ent } = await setup();
    const attrs = await entitlementsContext(ent)("org_pro");
    expect(attrs).toMatchObject({
      plan: "pro",
      plans: ["pro", "team"],
      addons: ["extra_seats"],
      "subscription.status": "active",
      "entitlement.export_pdf": true,
      "entitlement.sso": false,
      "entitlement.api_calls": true,
      "entitlement.api_calls.limit": 100_000,
      "entitlement.api_calls.used": 250,
      "entitlement.api_calls.remaining": 99_750,
      "entitlement.seats.limit": 10 + 20 + 5, // pro + team (another group) + add-on
      "entitlement.max_upload_mb": true,
      "entitlement.max_upload_mb.value": 500,
      "entitlement.support.value": "email",
    });
    const free = await entitlementsContext(ent)("org_new");
    expect(free).toMatchObject({ plan: "free", "subscription.status": "default", addons: [] });
    expect(
      (await entitlementsContext(ent)("org_biz"))["entitlement.api_calls.remaining"],
    ).toBeNull();
  });

  test("allowed reflects usage: exhausted blocks, overage-allowed stays true", async () => {
    const { ent } = await setup();
    await ent.consume("org_new", "api_calls", 1_000);
    expect((await entitlementsContext(ent)("org_new"))["entitlement.api_calls"]).toBe(false);
    await ent.setUsage("org_pro", "api_calls", 100_000);
    expect((await entitlementsContext(ent)("org_pro"))["entitlement.api_calls"]).toBe(true);
  });

  test("usage: false reads the snapshot only; prefix and feature filter", async () => {
    const { ent } = await setup();
    const spy = vi.spyOn(ent.counters, "get");
    const attrs = await entitlementsContext(ent, {
      usage: false,
      prefix: "ent:",
      features: ["api_calls", "export_pdf"],
    })("org_pro");
    expect(spy).not.toHaveBeenCalled();
    expect(attrs).toEqual({
      plan: "pro",
      plans: ["pro", "team"],
      addons: ["extra_seats"],
      "subscription.status": "active",
      "ent:api_calls": true,
      "ent:api_calls.limit": 100_000,
      "ent:export_pdf": true,
    });
  });

  test("stale snapshots are flagged", async () => {
    const { ent } = await setup();
    vi.spyOn(ent, "resolve").mockResolvedValue({
      ...(await ent.resolve("org_pro")),
      plans: [],
      stale: true,
    });
    const attrs = await entitlementsContext(ent, { usage: false })("org_pro");
    expect(attrs["entitlements.stale"]).toBe(true);
    expect(attrs.plan).toBeUndefined();
  });
});

describe("createEntitlementsHook", () => {
  test("enriches the context; existing attributes win; no customer → untouched", async () => {
    const { ent } = await setup();
    const hook = createEntitlementsHook(ent);
    const ctx = (context: EvaluationContext) =>
      hook.before!({ context } as Parameters<NonNullable<typeof hook.before>>[0]);
    const enriched = (await ctx({
      targetingKey: "org_pro",
      plan: "override",
    })) as EvaluationContext;
    expect(enriched["entitlement.export_pdf"]).toBe(true);
    expect(enriched.plan).toBeUndefined(); // already in the context
    expect(await ctx({})).toBeUndefined();

    const byKey = createEntitlementsHook(ent, { customerKey: "orgId", usage: false });
    expect(
      ((await byKey.before!({ context: { orgId: "org_biz" } } as never)) as EvaluationContext).plan,
    ).toBe("business");
    const byFn = createEntitlementsHook(ent, { customerKey: (c) => String(c.account) });
    expect(
      ((await byFn.before!({ context: { account: "org_pro" } } as never)) as EvaluationContext)
        .plan,
    ).toBe("pro");
  });

  test("a failing load is reported and the evaluation proceeds", async () => {
    const { ent } = await setup();
    vi.spyOn(ent, "entitlements").mockRejectedValue(new Error("down"));
    const onError = vi.fn();
    const hook = createEntitlementsHook(ent, { onError });
    expect(await hook.before!({ context: { targetingKey: "org_pro" } } as never)).toBeUndefined();
    expect(onError).toHaveBeenCalledWith(expect.any(Error), "org_pro");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await createEntitlementsHook(ent).before!({ context: { targetingKey: "org_pro" } } as never);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  test("end to end: an @xtandard/flags rule targets entitlement.export_pdf and plan", async () => {
    const { ent } = await setup();
    const { core, runtimeStorage } = createTestPanel();
    await publishFlags(core, [
      booleanFlag("new-export-ui", {
        default: false,
        rules: [
          {
            id: "pdf-customers",
            conditions: [{ attribute: "entitlement.export_pdf", operator: "equals", value: true }],
            serve: { variant: "on" },
          },
        ],
      }),
      variantFlag("support-widget", "string", {
        variants: { none: "none", chat: "chat" },
        default: "none",
        rules: [
          {
            id: "paid",
            conditions: [{ attribute: "plan", operator: "in", value: ["business", "enterprise"] }],
            serve: { variant: "chat" },
          },
        ],
      }),
    ]);
    const flags = createOpenFeatureProvider({ storage: runtimeStorage, refreshIntervalMs: 0 });
    await OpenFeature.setProviderAndWait("flags-e2e", flags);
    OpenFeature.addHooks(createEntitlementsHook(ent));
    const client = OpenFeature.getClient("flags-e2e");
    expect(await client.getBooleanValue("new-export-ui", false, { targetingKey: "org_pro" })).toBe(
      true,
    );
    expect(await client.getBooleanValue("new-export-ui", false, { targetingKey: "org_free" })).toBe(
      false,
    );
    expect(await client.getStringValue("support-widget", "none", { targetingKey: "org_biz" })).toBe(
      "chat",
    );
    expect(await client.getStringValue("support-widget", "none", { targetingKey: "org_pro" })).toBe(
      "none",
    );
  });
});

describe("createEntitlementsProvider", () => {
  test("through the OpenFeature SDK: boolean, number, string, object", async () => {
    const { ent } = await setup();
    await OpenFeature.setProviderAndWait("ent", createEntitlementsProvider(ent));
    const client = OpenFeature.getClient("ent");
    const pro = { targetingKey: "org_pro" };

    const pdf = await client.getBooleanDetails("export_pdf", false, pro);
    expect(pdf).toMatchObject({ value: true, reason: "TARGETING_MATCH", variant: "included" });
    const sso = await client.getBooleanDetails("sso", true, pro);
    expect(sso).toMatchObject({ value: false, variant: "not_in_plan" });
    expect(sso.flagMetadata).toMatchObject({
      allowed: false,
      denial: "payment_required",
      unlockedBy: "business",
    });

    const calls = await client.getNumberDetails("api_calls", 0, pro);
    expect(calls.value).toBe(99_750);
    expect(calls.flagMetadata).toMatchObject({ limit: 100_000, used: 250, remaining: 99_750 });
    expect(await client.getNumberValue("api_calls", 0, { targetingKey: "org_biz" })).toBe(
      Number.POSITIVE_INFINITY,
    );
    expect(await client.getNumberValue("max_upload_mb", 0, pro)).toBe(500);
    expect(await client.getStringValue("support", "?", pro)).toBe("email");
    expect(await client.getObjectValue("support", {}, pro)).toBe("email");
    expect(await client.getObjectValue("api_calls", {}, pro)).toMatchObject({
      allowed: true,
      remaining: 99_750,
      reason: "within_limit",
    });
  });

  test("errors: missing targeting key, unknown feature, type mismatch, engine failure", async () => {
    const { ent } = await setup();
    const p = createEntitlementsProvider(ent, { name: "custom" });
    expect(p.metadata.name).toBe("custom");
    expect(await p.resolveBooleanEvaluation("export_pdf", false, {})).toMatchObject({
      value: false,
      reason: "ERROR",
      errorCode: "TARGETING_KEY_MISSING",
    });
    expect(await p.resolveBooleanEvaluation("nope", true, { targetingKey: "o" })).toMatchObject({
      value: true,
      errorCode: "FLAG_NOT_FOUND",
    });
    expect(await p.resolveStringEvaluation("api_calls", "d", { targetingKey: "o" })).toMatchObject({
      value: "d",
      errorCode: "TYPE_MISMATCH",
    });
    expect(await p.resolveNumberEvaluation("export_pdf", 7, { targetingKey: "o" })).toMatchObject({
      value: 7,
      errorCode: "TYPE_MISMATCH",
    });
    expect(await p.resolveNumberEvaluation("support", 7, { targetingKey: "o" })).toMatchObject({
      errorCode: "TYPE_MISMATCH",
    });
    vi.spyOn(ent, "check").mockRejectedValueOnce(new Error("boom")).mockRejectedValueOnce("str");
    expect(
      await p.resolveBooleanEvaluation("export_pdf", false, { targetingKey: "o" }),
    ).toMatchObject({
      errorCode: "GENERAL",
      errorMessage: "boom",
    });
    expect(
      await p.resolveBooleanEvaluation("export_pdf", false, { targetingKey: "o" }),
    ).toMatchObject({
      errorMessage: "str",
    });
  });

  test("reason mapping", () => {
    const base = { allowed: true, feature: "f", kind: "boolean" as const, unlockedBy: [] };
    expect(toOpenFeatureReason({ ...base, reason: "included" })).toBe("TARGETING_MATCH");
    expect(toOpenFeatureReason({ ...base, reason: "included", stale: true })).toBe("STALE");
    expect(toOpenFeatureReason({ ...base, reason: "fallback" })).toBe("DEFAULT");
    expect(toOpenFeatureReason({ ...base, reason: "unknown_feature" })).toBe("ERROR");
  });
});

import { describe, expect, test } from "vitest";
import {
  compactNumber,
  dateInputToIso,
  daysUntil,
  entryLabel,
  featureSummary,
  formatDate,
  formatDateTime,
  formatNumber,
  formatPrice,
  initials,
  isNumeric,
  limitLabel,
  monthlyCents,
  niceMax,
  parseAmount,
  planDirection,
  relativeTime,
  resetLabel,
  resetsInLabel,
  sourceLabel,
  STATUSES,
  statusLabel,
  statusTone,
  unitFor,
  usageLevel,
  usageRatio,
} from "../src/ui/lib/format.ts";
import { takeTokenFromUrl } from "../src/ui/lib/token.ts";
import {
  overrideModes,
  validateGrant,
  validateOverride,
  validateProfile,
  validateTrial,
  validateUsage,
  type GrantForm,
  type OverrideForm,
} from "../src/ui/lib/validate.ts";
import { EntitlementsApiError, errorMessage } from "../src/ui/types.ts";

const NOW = Date.parse("2026-11-20T12:00:00Z");
const seat = { unit: "seat", units: "seats" };

describe("format", () => {
  test("dates", () => {
    expect(formatDateTime(undefined)).toBe("—");
    expect(formatDateTime("nope")).toBe("—");
    expect(formatDateTime("2026-11-20T12:00:00Z")).toMatch(/2026/);
    expect(formatDate(null)).toBe("—");
    expect(formatDate("bad")).toBe("—");
    expect(formatDate("2026-11-20T12:00:00Z")).toMatch(/Nov/);
  });

  test("relativeTime / daysUntil / resetsInLabel", () => {
    expect(relativeTime(null, NOW)).toBe("—");
    expect(relativeTime("x", NOW)).toBe("—");
    expect(relativeTime("2026-11-20T11:59:55Z", NOW)).toBe("just now");
    expect(relativeTime("2026-11-20T11:59:00Z", NOW)).toBe("1m ago");
    expect(relativeTime("2026-11-20T11:59:30Z", NOW)).toBe("30s ago");
    expect(relativeTime("2026-11-23T12:00:00Z", NOW)).toBe("in 3d");
    expect(relativeTime("2026-11-20T09:00:00Z", NOW)).toBe("3h ago");
    expect(daysUntil(undefined, NOW)).toBeNull();
    expect(daysUntil("bad", NOW)).toBeNull();
    expect(daysUntil("2026-11-22T00:00:00Z", NOW)).toBe(2);
    expect(daysUntil("2026-11-19T00:00:00Z", NOW)).toBe(-1);
    expect(resetsInLabel(null, NOW)).toBe("Never resets");
    expect(resetsInLabel("bad", NOW)).toBe("Never resets");
    expect(resetsInLabel("2026-12-01T00:00:00Z", NOW)).toBe("Resets in 11d");
    expect(resetsInLabel("2026-11-01T00:00:00Z", NOW)).toBe("Resets now");
  });

  test("numbers", () => {
    expect(formatNumber(1234.5)).toBe("1,234.5");
    expect(formatNumber(null)).toBe("—");
    expect(formatNumber(Infinity)).toBe("—");
    expect(compactNumber(950)).toBe("950");
    expect(compactNumber(1_250)).toBe("1.3k");
    expect(compactNumber(48_000)).toBe("48k");
    expect(compactNumber(250_000)).toBe("250k");
    expect(compactNumber(3_100_000)).toBe("3.1M");
    expect(compactNumber(2_000_000_000)).toBe("2B");
    expect(parseAmount(" 1,000 ")).toBe(1000);
    expect(parseAmount("")).toBeNull();
    expect(parseAmount("abc")).toBeNull();
    expect(niceMax(0)).toBe(1);
    expect(niceMax(7)).toBe(10);
    expect(niceMax(130)).toBe(200);
    expect(niceMax(220)).toBe(250);
    expect(niceMax(4_100)).toBe(5_000);
    expect(niceMax(100)).toBe(100);
  });

  test("prices", () => {
    expect(formatPrice(undefined)).toBe("Free");
    expect(formatPrice([{ amount: 0, currency: "usd" }])).toBe("Free");
    expect(formatPrice([{ amount: 0, currency: "usd", label: "Custom" }])).toBe("Custom");
    expect(formatPrice([{ amount: 2900, currency: "usd", interval: "month" }])).toBe("$29 / mo");
    expect(formatPrice([{ amount: 29900, currency: "eur", interval: "year" }])).toBe("€299 / yr");
    expect(formatPrice([{ amount: 199, currency: "usd", interval: "week" }])).toBe("$1.99 / wk");
    expect(formatPrice([{ amount: 100, currency: "usd", interval: "day" }])).toBe("$1 / day");
    expect(formatPrice([{ amount: 500, currency: "usd", interval: "one_time" }])).toBe(
      "$5 one-time",
    );
    expect(formatPrice([{ amount: 500, currency: "usd" }])).toBe("$5");
    expect(monthlyCents(undefined)).toBe(0);
    expect(monthlyCents([{ amount: 1200, currency: "usd", interval: "year" }])).toBe(100);
    expect(monthlyCents([{ amount: 12, currency: "usd", interval: "week" }])).toBe(52);
    expect(monthlyCents([{ amount: 1, currency: "usd", interval: "day" }])).toBe(30);
  });

  test("planDirection", () => {
    const plans = [
      { key: "free", price: [] },
      { key: "pro", price: [{ amount: 2900, currency: "usd", interval: "month" as const }] },
      { key: "team", price: [{ amount: 2900, currency: "usd", interval: "month" as const }] },
      { key: "biz", price: [{ amount: 9900, currency: "usd", interval: "month" as const }] },
    ];
    expect(planDirection(plans, "pro", "pro")).toBe("current");
    expect(planDirection(plans, "pro", "biz")).toBe("upgrade");
    expect(planDirection(plans, "pro", "free")).toBe("downgrade");
    expect(planDirection(plans, "pro", "team")).toBe("upgrade");
    expect(planDirection(plans, "team", "pro")).toBe("downgrade");
    expect(planDirection(plans, undefined, "free")).toBe("upgrade");
  });

  test("statuses", () => {
    for (const s of STATUSES) {
      expect(statusLabel(s)).toBeTruthy();
      expect(statusTone(s)).toMatch(/border-/);
    }
    expect(statusLabel("past_due")).toBe("Past due");
  });

  test("usage", () => {
    expect(usageRatio(5, null)).toBeNull();
    expect(usageRatio(undefined, 10)).toBeNull();
    expect(usageRatio(5, 10)).toBe(0.5);
    expect(usageRatio(1, 0)).toBe(1);
    expect(usageRatio(0, 0)).toBe(0);
    expect(usageLevel(null)).toBe("ok");
    expect(usageLevel(0.5)).toBe("ok");
    expect(usageLevel(0.8)).toBe("warn");
    expect(usageLevel(0.95)).toBe("critical");
  });

  test("units and labels", () => {
    expect(unitFor(seat, 1)).toBe("seat");
    expect(unitFor(seat, 2)).toBe("seats");
    expect(unitFor({}, 2)).toBe("");
    expect(unitFor({ unit: "GB" }, 3)).toBe("GB");
    expect(limitLabel(seat, undefined)).toBe("—");
    expect(limitLabel(seat, null)).toBe("Unlimited");
    expect(limitLabel(seat, 10)).toBe("10 seats");
    expect(limitLabel({}, 1000)).toBe("1,000");
    for (const r of ["day", "week", "month", "quarter", "year", "billing_period", "never"]) {
      expect(resetLabel(r)).not.toBe("—");
    }
    expect(resetLabel(undefined)).toBe("—");
    expect(sourceLabel({ type: "plan", id: "pro", version: 2 })).toBe("plan pro v2");
    expect(sourceLabel({ type: "plan", id: "pro", version: 1 })).toBe("plan pro");
    expect(sourceLabel({ type: "addon", id: "extra" })).toBe("add-on extra");
    expect(sourceLabel({ type: "grant", id: "g1" })).toBe("grant");
    expect(isNumeric("credits")).toBe(true);
    expect(isNumeric("boolean")).toBe(false);
    expect(initials("Acme Corp")).toBe("AC");
    expect(initials("org_42")).toBe("O4");
    expect(initials("northwind")).toBe("NO");
    expect(initials("  ")).toBe("?");
  });

  test("featureSummary", () => {
    expect(featureSummary(seat, { kind: "boolean", enabled: true })).toBe("Enabled");
    expect(featureSummary(seat, { kind: "boolean", enabled: false })).toBe("Not included");
    expect(featureSummary(seat, { kind: "value", enabled: true, value: "eu" })).toBe("eu");
    expect(featureSummary(seat, { kind: "value", enabled: true, value: 5 })).toBe("5");
    expect(featureSummary(seat, { kind: "value", enabled: true })).toBe("null");
    expect(featureSummary(seat, { kind: "capacity", enabled: false })).toBe("Not included");
    expect(featureSummary(seat, { kind: "capacity", enabled: true, used: 3, limit: 10 })).toBe(
      "3 / 10 seats",
    );
    expect(featureSummary(seat, { kind: "capacity", enabled: true, limit: null })).toBe(
      "0 used · Unlimited",
    );
  });

  test("entryLabel", () => {
    const bool = { kind: "boolean" as const };
    expect(entryLabel(bool, { kind: "boolean", enabled: true })).toEqual({
      label: "✓",
      included: true,
    });
    expect(entryLabel(bool, undefined)).toEqual({ label: "—", included: false });
    const val = { kind: "value" as const, default: 10 };
    expect(entryLabel(val, { kind: "value", value: 2048 })).toEqual({
      label: "2,048",
      included: true,
    });
    expect(entryLabel(val, undefined)).toEqual({ label: "10", included: true, detail: "default" });
    expect(entryLabel({ kind: "value", default: "eu" }, undefined).label).toBe("eu");
    expect(entryLabel({ kind: "value", default: [1] }, undefined).label).toBe("[1]");
    const metered = {
      kind: "metered" as const,
      reset: "month" as const,
      unit: "call",
      units: "calls",
    };
    expect(entryLabel(metered, undefined)).toEqual({ label: "—", included: false });
    expect(
      entryLabel(metered, {
        kind: "metered",
        included: true,
        limit: 1000,
        overage: "block",
        overageLimit: null,
      }),
    ).toEqual({ label: "1,000 calls", included: true, detail: "monthly" });
    expect(
      entryLabel(metered, {
        kind: "metered",
        included: true,
        limit: 1000,
        overage: "allow",
        overageLimit: null,
      }).detail,
    ).toBe("monthly · overage allowed");
    expect(
      entryLabel(metered, {
        kind: "metered",
        included: true,
        limit: 1000,
        overage: "allow",
        overageLimit: 500,
        reset: "day",
      }).detail,
    ).toBe("daily · overage to 500");
    expect(
      entryLabel(
        { kind: "capacity", ...seat },
        { kind: "capacity", included: true, limit: null, overage: "block", overageLimit: null },
      ),
    ).toEqual({ label: "Unlimited", included: true });
  });

  test("dateInputToIso", () => {
    expect(dateInputToIso("2026-12-31")).toBe("2026-12-31T23:59:59.000Z");
    expect(dateInputToIso("12/31/2026")).toBeUndefined();
    expect(dateInputToIso("2026-13-45")).toBeUndefined();
  });
});

describe("takeTokenFromUrl", () => {
  test("hash token is taken and stripped, other params kept", () => {
    let replaced = "";
    const token = takeTokenFromUrl(
      { pathname: "/billing/", search: "?x=1", hash: "#token=entpt_abc&tab=usage" },
      (u) => (replaced = u),
    );
    expect(token).toBe("entpt_abc");
    expect(replaced).toBe("/billing/?x=1#tab=usage");
  });
  test("query token works too", () => {
    let replaced = "";
    expect(
      takeTokenFromUrl({ pathname: "/", search: "?token=t1", hash: "" }, (u) => (replaced = u)),
    ).toBe("t1");
    expect(replaced).toBe("/");
  });
  test("no token → null, URL untouched", () => {
    let called = false;
    expect(
      takeTokenFromUrl({ pathname: "/", search: "", hash: "#x" }, () => (called = true)),
    ).toBeNull();
    expect(called).toBe(false);
  });
});

describe("validate", () => {
  const features = [
    { key: "api_calls", kind: "metered" as const },
    { key: "seats", kind: "capacity" as const },
    { key: "sso", kind: "boolean" as const },
    { key: "region", kind: "value" as const },
  ];

  test("profile", () => {
    expect(validateProfile({ name: " Acme ", email: "" })).toEqual({
      ok: true,
      value: { name: "Acme", email: "" },
    });
    expect(validateProfile({ name: "x".repeat(201), email: "nope" })).toEqual({
      ok: false,
      errors: { name: expect.any(String), email: "Enter a valid email address." },
    });
  });

  const grant = (over: Partial<GrantForm>): GrantForm => ({
    feature: "api_calls",
    amount: "1,000",
    expiresAt: "",
    priority: "",
    recurring: false,
    reason: "",
    ...over,
  });

  test("grant: valid with all options", () => {
    expect(
      validateGrant(
        grant({ expiresAt: "2026-12-31", priority: "2", recurring: true, reason: " promo " }),
        features,
        NOW,
      ),
    ).toEqual({
      ok: true,
      value: {
        feature: "api_calls",
        amount: 1000,
        priority: 2,
        recurring: true,
        expiresAt: "2026-12-31T23:59:59.000Z",
        reason: "promo",
      },
    });
    expect(validateGrant(grant({}), features, NOW)).toEqual({
      ok: true,
      value: { feature: "api_calls", amount: 1000, priority: 0 },
    });
  });

  test("grant: errors", () => {
    const r = validateGrant(
      grant({
        feature: "sso",
        amount: "0",
        expiresAt: "2020-01-01",
        priority: "1.5",
        reason: "x".repeat(501),
      }),
      features,
      NOW,
    );
    expect(r.ok).toBe(false);
    if (!r.ok)
      expect(Object.keys(r.errors).sort()).toEqual([
        "amount",
        "expiresAt",
        "feature",
        "priority",
        "reason",
      ]);
    const missing = validateGrant(
      grant({ feature: "zzz", amount: "", expiresAt: "bad" }),
      features,
      NOW,
    );
    expect(missing).toEqual({
      ok: false,
      errors: {
        feature: "Choose a feature.",
        amount: "Enter an amount.",
        expiresAt: "Enter a valid date.",
      },
    });
    expect(validateGrant(grant({ feature: "seats", amount: "1.5" }), features, NOW)).toEqual({
      ok: false,
      errors: { amount: "Capacity grants must be whole units." },
    });
  });

  const ov = (over: Partial<OverrideForm>): OverrideForm => ({
    feature: "api_calls",
    mode: "limit",
    limit: "5000",
    value: "",
    expiresAt: "",
    reason: "pilot",
    ...over,
  });

  test("override modes per kind", () => {
    expect(overrideModes("boolean")).toEqual(["enable", "disable"]);
    expect(overrideModes("value")).toEqual(["value", "disable"]);
    expect(overrideModes("metered")).toContain("unlimited");
  });

  test("override: each mode", () => {
    expect(validateOverride(ov({}), features, NOW)).toEqual({
      ok: true,
      value: { feature: "api_calls", limit: 5000, reason: "pilot" },
    });
    expect(
      validateOverride(ov({ mode: "unlimited", expiresAt: "2026-12-01" }), features, NOW),
    ).toEqual({
      ok: true,
      value: {
        feature: "api_calls",
        limit: null,
        expiresAt: "2026-12-01T23:59:59.000Z",
        reason: "pilot",
      },
    });
    expect(validateOverride(ov({ feature: "sso", mode: "enable" }), features, NOW)).toMatchObject({
      ok: true,
      value: { enabled: true },
    });
    expect(validateOverride(ov({ feature: "sso", mode: "disable" }), features, NOW)).toMatchObject({
      ok: true,
      value: { enabled: false },
    });
    expect(
      validateOverride(ov({ feature: "region", mode: "value", value: "eu" }), features, NOW),
    ).toMatchObject({
      ok: true,
      value: { value: "eu" },
    });
    expect(
      validateOverride(ov({ feature: "region", mode: "value", value: '{"a":1}' }), features, NOW),
    ).toMatchObject({
      ok: true,
      value: { value: { a: 1 } },
    });
  });

  test("override: errors", () => {
    expect(
      validateOverride(ov({ feature: "sso", mode: "limit", limit: "", reason: "" }), features, NOW),
    ).toEqual({
      ok: false,
      errors: {
        mode: expect.any(String),
        limit: "Enter a limit.",
        reason: expect.stringMatching(/Say why/),
      },
    });
    expect(
      validateOverride(
        ov({ feature: "x", limit: "-1", expiresAt: "2001-01-01", reason: "y".repeat(501) }),
        features,
        NOW,
      ),
    ).toEqual({
      ok: false,
      errors: {
        feature: "Choose a feature.",
        limit: "The limit cannot be negative.",
        expiresAt: "The expiry must be in the future.",
        reason: expect.any(String),
      },
    });
    expect(
      validateOverride(
        ov({ feature: "region", mode: "value", value: " ", expiresAt: "bad" }),
        features,
        NOW,
      ),
    ).toEqual({
      ok: false,
      errors: { value: "Enter a value.", expiresAt: "Enter a valid date." },
    });
  });

  test("usage and trial", () => {
    expect(validateUsage("12")).toEqual({ ok: true, value: 12 });
    expect(validateUsage("x")).toEqual({ ok: false, errors: { value: "Enter a number." } });
    expect(validateUsage("-1")).toEqual({
      ok: false,
      errors: { value: "Usage cannot be negative." },
    });
    expect(validateTrial({ plan: "pro", days: "" })).toEqual({ ok: true, value: { plan: "pro" } });
    expect(validateTrial({ plan: "pro", days: "30" })).toEqual({
      ok: true,
      value: { plan: "pro", days: 30 },
    });
    expect(validateTrial({ plan: "", days: "0" })).toEqual({
      ok: false,
      errors: { plan: "Choose a plan.", days: "Between 1 and 365 days." },
    });
  });
});

test("errorMessage", () => {
  expect(errorMessage(new EntitlementsApiError(404, { error: "Not found" }))).toBe("Not found");
  expect(errorMessage(new EntitlementsApiError(500, { error: "" }), "fallback")).toBe("fallback");
  expect(errorMessage(new Error("boom"))).toBe("boom");
  expect(errorMessage("weird")).toBe("Something went wrong");
});

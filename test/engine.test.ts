import { describe, expect, it } from "vitest";
import {
  createEntitlements,
  EntitlementDeniedError,
  EntitlementsValidationError,
  NotFoundError,
  ReadonlyError,
} from "../src/engine.ts";
import { HookDeniedError } from "../src/hooks/contract.ts";
import { createMemoryCounterStore } from "../src/counters/memory.ts";
import { createBufferedCounterStore } from "../src/counters/buffered.ts";
import type { CounterStore } from "../src/counters/contract.ts";
import { createMemoryStorage } from "../src/storage/memory.ts";
import type { EntitlementsStorage } from "../src/storage/contract.ts";
import { createTestEntitlements } from "../src/testing.ts";
import { catalog } from "./fixtures.ts";

const START = "2026-11-20T12:00:00Z";
const setup = (extra: Partial<Parameters<typeof createTestEntitlements<typeof catalog>>[0]> = {}) =>
  createTestEntitlements({ catalog, now: START, ...extra });

describe("check", () => {
  it("boolean, value and unknown features", async () => {
    const { ent } = setup();
    expect(await ent.check("org", "export_pdf")).toMatchObject({
      allowed: false,
      reason: "not_in_plan",
      denial: "payment_required",
      unlockedBy: ["pro", "business"],
    });
    await ent.subscribe("org", { plan: "pro" });
    expect(await ent.check("org", "export_pdf")).toMatchObject({
      allowed: true,
      reason: "included",
      unlockedBy: [],
    });
    const v = await ent.check("org", "max_upload_mb");
    expect(v).toMatchObject({ allowed: true, value: 500 });
    expect(await ent.check("org", "enterprise_only" as never)).toMatchObject({
      allowed: false,
      reason: "unknown_feature",
      denial: "forbidden",
    });
  });

  it("strict mode throws on unknown features", async () => {
    const { ent } = setup({ strict: true });
    await expect(ent.check("org", "nope" as never)).rejects.toBeInstanceOf(
      EntitlementsValidationError,
    );
  });

  it("metered: usage, remaining and resetsAt; check never counts", async () => {
    const { ent } = setup();
    await ent.consume("org", "api_calls", 250);
    const r = await ent.check("org", "api_calls", { amount: 10 });
    expect(r).toMatchObject({
      allowed: true,
      reason: "within_limit",
      used: 250,
      remaining: 750,
      limit: 1000,
      resetsAt: "2026-12-01T00:00:00.000Z",
    });
    expect((await ent.check("org", "api_calls", { amount: 751 })).allowed).toBe(false);
    expect((await ent.check("org", "api_calls")).used).toBe(250);
  });

  it("require throws EntitlementDeniedError with 402 / 403", async () => {
    const { ent } = setup();
    const e = await ent.require("org", "sso").catch((x) => x);
    expect(e).toBeInstanceOf(EntitlementDeniedError);
    expect(e.status).toBe(402);
    await ent.override("org", { feature: "export_pdf", enabled: false });
    const e2 = await ent.require("org", "export_pdf").catch((x) => x);
    expect(e2.status).toBe(403);
    expect(e2.result.reason).toBe("disabled_by_override");
  });
});

describe("consume", () => {
  it("a refusal never counts", async () => {
    const { ent, usage } = setup();
    expect((await ent.consume("org", "api_calls", 900)).allowed).toBe(true);
    const refused = await ent.consume("org", "api_calls", 200);
    expect(refused).toMatchObject({
      allowed: false,
      reason: "limit_reached",
      denial: "payment_required",
      used: 900,
      remaining: 100,
    });
    expect(refused.unlockedBy).toEqual(["pro", "business"]);
    expect((await ent.check("org", "api_calls")).used).toBe(900);
    expect((await ent.consume("org", "api_calls", 100)).remaining).toBe(0);
    expect(usage.map((u) => u.amount)).toEqual([900, 100]);
  });

  it("concurrent consumers never over-grant", async () => {
    const { ent } = setup();
    const results = await Promise.all(
      Array.from({ length: 1500 }, () => ent.consume("org", "api_calls")),
    );
    expect(results.filter((r) => r.allowed)).toHaveLength(1000);
    expect((await ent.check("org", "api_calls")).used).toBe(1000);
  });

  it("resets with the period", async () => {
    const { ent, clock } = setup();
    await ent.consume("org", "exports", 5);
    expect((await ent.consume("org", "exports")).allowed).toBe(false);
    clock.set("2026-11-21T00:00:01Z");
    expect(await ent.consume("org", "exports")).toMatchObject({
      allowed: true,
      used: 1,
      resetsAt: "2026-11-22T00:00:00.000Z",
    });
  });

  it("drains allowance, then one-off grants by priority, then refunds on failure", async () => {
    const { ent } = setup();
    await ent.grant("org", { feature: "api_calls", amount: 50, priority: 1 });
    const g0 = await ent.grant("org", { feature: "api_calls", amount: 20, priority: 0 });
    expect((await ent.check("org", "api_calls")).limit).toBe(1070);
    expect((await ent.consume("org", "api_calls", 1010)).allowed).toBe(true);
    let e = await ent.entitlements("org");
    expect(e.features.api_calls!.grantBalances!.find((g) => g.id === g0.id)!.used).toBe(10);
    // 60 left (10 + 50): asking 61 refunds the partial takes
    expect((await ent.consume("org", "api_calls", 61)).allowed).toBe(false);
    e = await ent.entitlements("org");
    expect(e.features.api_calls).toMatchObject({ used: 1010, remaining: 60 });
    expect((await ent.consume("org", "api_calls", 60)).remaining).toBe(0);
  });

  it("overage: soft limits keep going and report overage", async () => {
    const { ent } = setup();
    await ent.subscribe("org", { plan: "business" });
    await ent.consume("org", "api_calls", 1_000_000);
    const r = await ent.consume("org", "api_calls", 10);
    expect(r).toMatchObject({
      allowed: true,
      reason: "overage_allowed",
      overage: 10,
      remaining: 0,
    });
    expect((await ent.consume("org", "api_calls", 500_000)).allowed).toBe(false); // overageLimit 500k
    expect((await ent.consume("org", "api_calls", 499_990)).allowed).toBe(true);
  });

  it("unlimited features always allow and still count", async () => {
    const { ent } = setup();
    await ent.subscribe("org", { plan: "business" });
    const r = await ent.consume("org", "exports", 1e6);
    expect(r).toMatchObject({
      allowed: true,
      reason: "included",
      remaining: null,
      limit: null,
      used: 1e6,
    });
  });

  it("capacity: consume within the limit, release frees, setUsage sets truth", async () => {
    const { ent } = setup();
    expect((await ent.consume("org", "seats", 3)).allowed).toBe(true);
    expect(await ent.consume("org", "seats")).toMatchObject({
      allowed: false,
      reason: "limit_reached",
      unlockedBy: ["extra_seats", "pro", "business"],
    });
    expect((await ent.release("org", "seats")).used).toBe(2);
    await ent.setUsage("org", "seats", 1);
    expect(await ent.check("org", "seats", { amount: 2 })).toMatchObject({
      allowed: true,
      used: 1,
      remaining: 2,
      resetsAt: null,
    });
    expect((await ent.release("org", "seats", 5)).used).toBe(0);
  });

  it("credits: a feature drawing only from a pool", async () => {
    const { ent } = setup();
    expect(await ent.consume("org", "gpt_tokens", 100)).toMatchObject({
      allowed: false,
      reason: "not_in_plan",
      denial: "payment_required",
      unlockedBy: ["pro", "business"],
    });
    await ent.subscribe("org", { plan: "pro" }); // 5,000 credits; 0.01 per token → 500k tokens
    const r = await ent.consume("org", "gpt_tokens", 100_000);
    expect(r).toMatchObject({ allowed: true, remaining: 400_000, limit: 500_000 });
    expect((await ent.check("org", "ai_credits")).used).toBe(1000);
    expect((await ent.consume("org", "gpt_tokens", 400_001)).allowed).toBe(false);
    expect((await ent.check("org", "ai_credits")).used).toBe(1000);
    expect((await ent.check("org", "gpt_tokens")).used).toBe(100_000);
  });

  it("idempotency keys apply once; refusals release the key", async () => {
    const { ent, usage } = setup();
    expect(
      (await ent.consume("org", "api_calls", 10, { idempotencyKey: "req-1" })).duplicate,
    ).toBeUndefined();
    const dup = await ent.consume("org", "api_calls", 10, { idempotencyKey: "req-1" });
    expect(dup).toMatchObject({ allowed: true, duplicate: true, used: 10 });
    expect((await ent.consume("org", "api_calls", 5000, { idempotencyKey: "req-2" })).allowed).toBe(
      false,
    );
    expect((await ent.consume("org", "api_calls", 5, { idempotencyKey: "req-2" })).allowed).toBe(
      true,
    );
    expect(usage).toHaveLength(2);
  });

  it("consumeOrThrow / boolean consume / validation", async () => {
    const { ent } = setup();
    await expect(ent.consumeOrThrow("org", "api_calls", 2000)).rejects.toBeInstanceOf(
      EntitlementDeniedError,
    );
    expect((await ent.consume("org", "export_pdf")).allowed).toBe(false);
    await expect(ent.consume("org", "api_calls", -1)).rejects.toBeInstanceOf(
      EntitlementsValidationError,
    );
    expect((await ent.consume("org", "nope" as never)).reason).toBe("unknown_feature");
  });

  it("thresholds fire once per period", async () => {
    const { ent, thresholds, clock } = setup();
    await ent.consume("org", "api_calls", 700);
    await ent.consume("org", "api_calls", 150);
    await ent.consume("org", "api_calls", 10);
    await ent.consume("org", "api_calls", 140);
    await new Promise((r) => setTimeout(r, 0));
    expect(thresholds.map((t) => t.threshold)).toEqual([0.8, 1]);
    expect(thresholds[0]).toMatchObject({
      feature: "api_calls",
      used: 850,
      limit: 1000,
      period: "m:2026-11",
    });
    clock.set("2026-12-02T00:00:00Z");
    await ent.consume("org", "api_calls", 900);
    await new Promise((r) => setTimeout(r, 0));
    expect(thresholds).toHaveLength(3);
  });

  it("buffered features decide locally and report buffered", async () => {
    const strict = createMemoryCounterStore();
    const buffered = createBufferedCounterStore(strict, { flushInterval: 0 });
    const { defineCatalog, feature } = await import("../src/catalog.ts");
    const c = defineCatalog({
      features: { hits: feature.metered({ reset: "month", metering: "buffered" }) },
      plans: { free: { default: true, features: { hits: 3 } } },
    });
    const ent = createEntitlements({
      catalog: c,
      counters: { default: strict, buffered },
      usageSeries: false,
    });
    expect(await ent.consume("o", "hits", 2)).toMatchObject({ allowed: true, buffered: true });
    expect((await ent.consume("o", "hits", 2)).allowed).toBe(false);
    expect(
      await strict.get([
        (await import("../src/keys.ts")).usageKey(
          "o",
          "hits",
          (await ent.entitlements("o")).features.hits!.period!.key,
        ),
      ]),
    ).toEqual([0]);
    await ent.close();
    expect((await ent.check("o", "hits")).used).toBe(2);
  });
});

describe("reserve / settle", () => {
  it("refunds the unused part and charges the extra", async () => {
    const { ent, usage } = setup();
    await ent.subscribe("org", { plan: "pro" });
    const r = await ent.reserve("org", "gpt_tokens", 10_000);
    expect(r.allowed).toBe(true);
    expect((await ent.check("org", "ai_credits")).used).toBe(100);
    await ent.settle(r.reservation!.id, 4_000);
    expect((await ent.check("org", "ai_credits")).used).toBeCloseTo(40);
    expect((await ent.check("org", "gpt_tokens")).used).toBe(4_000);
    const r2 = await ent.reserve("org", "api_calls", 10);
    await ent.settle(r2.reservation!.id, 25);
    expect((await ent.check("org", "api_calls")).used).toBe(25);
    await expect(ent.settle(r2.reservation!.id, 1)).rejects.toBeInstanceOf(NotFoundError);
    expect(usage.map((u) => u.source)).toEqual(["reserve", "settle", "reserve", "settle"]);
  });

  it("settle past the limit records by default, caps on request", async () => {
    const { ent } = setup();
    const a = await ent.reserve("org", "exports", 4);
    await ent.settle(a.reservation!.id, 7);
    expect((await ent.check("org", "exports")).used).toBe(7);
    const { ent: ent2 } = setup();
    const b = await ent2.reserve("org", "exports", 4);
    await ent2.settle(b.reservation!.id, 7, { overage: "cap" });
    expect((await ent2.check("org", "exports")).used).toBe(5);
  });

  it("refused reservations take nothing; cancel and sweep release", async () => {
    const { ent, clock } = setup();
    expect((await ent.reserve("org", "exports", 6)).reservation).toBeUndefined();
    const a = await ent.reserve("org", "exports", 2);
    await ent.cancelReservation(a.reservation!.id);
    expect((await ent.check("org", "exports")).used).toBe(0);
    await ent.reserve("org", "exports", 3, { ttl: "1m" });
    await ent.reserve("org", "exports", 1, { ttl: "1h" });
    clock.advance("2m");
    expect(await ent.sweep()).toEqual({ released: 1 });
    expect((await ent.check("org", "exports")).used).toBe(1);
  });
});

describe("control plane", () => {
  it("subscribe replaces manual plans in the group; cancel and remove", async () => {
    const { ent, events } = setup();
    const pro = await ent.subscribe("org", { plan: "pro" });
    expect(pro).toMatchObject({ plan: "pro", version: 2, status: "active", provider: "manual" });
    expect(pro.periodEnd).toBe("2026-12-20T12:00:00.000Z");
    await ent.subscribe("org", { plan: "business" });
    let state = await ent.getCustomer("org");
    expect(state!.subscriptions.map((s) => `${s.plan}:${s.status}`)).toEqual([
      "pro:canceled",
      "business:active",
    ]);
    const biz = state!.subscriptions[1]!;
    await ent.cancelSubscription("org", biz.id, { atPeriodEnd: true });
    expect((await ent.entitlements("org")).plans[0]).toMatchObject({
      plan: "business",
      cancelAtPeriodEnd: true,
    });
    await ent.removeSubscription("org", biz.id);
    state = await ent.getCustomer("org");
    expect(state!.subscriptions).toHaveLength(1);
    expect(events.map((e) => e.type)).toContain("subscription.removed");
    await expect(ent.removeSubscription("org", "nope")).rejects.toBeInstanceOf(NotFoundError);
    await expect(ent.subscribe("org", { plan: "nope" })).rejects.toBeInstanceOf(
      EntitlementsValidationError,
    );
  });

  it("upsertSubscription by provider ref ignores stale updates", async () => {
    const { ent } = setup();
    const a = await ent.upsertSubscription("org", {
      plan: "pro",
      provider: "stripe",
      providerRef: "sub_1",
      providerUpdatedAt: "2026-11-20T10:00:00Z",
      status: "trialing",
      trialEndsAt: "2026-12-04T00:00:00Z",
    });
    expect(a.outcome).toBe("created");
    const b = await ent.upsertSubscription("org", {
      plan: "pro",
      provider: "stripe",
      providerRef: "sub_1",
      providerUpdatedAt: "2026-11-20T09:00:00Z",
      status: "canceled",
    });
    expect(b.outcome).toBe("stale");
    const c = await ent.upsertSubscription("org", {
      plan: "pro",
      provider: "stripe",
      providerRef: "sub_1",
      providerUpdatedAt: "2026-11-20T11:00:00Z",
      status: "active",
    });
    expect(c).toMatchObject({
      outcome: "updated",
      subscription: { id: a.subscription.id, status: "active" },
    });
    const state = await ent.getCustomer("org");
    expect(state!.trials.pro).toBeDefined();
    expect(state!.subscriptions).toHaveLength(1);
  });

  it("trials expire on their own and are one per plan", async () => {
    const { ent, clock } = setup();
    const t = await ent.startTrial("org", "pro");
    expect(t).toMatchObject({ status: "trialing", trialEndsAt: "2026-12-04T12:00:00.000Z" });
    expect((await ent.check("org", "export_pdf")).allowed).toBe(true);
    clock.set("2026-12-05T00:00:00Z");
    expect(await ent.check("org", "export_pdf")).toMatchObject({
      allowed: false,
      reason: "subscription_inactive",
      denial: "payment_required",
    });
    await expect(ent.startTrial("org", "pro")).rejects.toThrow(/already used/);
    await expect(ent.startTrial("org", "business")).rejects.toThrow(/no trial/);
    expect((await ent.startTrial("org", "pro", { force: true })).status).toBe("trialing");
  });

  it("migratePlan moves grandfathered subscriptions explicitly", async () => {
    const { ent } = setup();
    await ent.upsertSubscription("a", { plan: "pro", version: 1 });
    await ent.upsertSubscription("b", { plan: "pro", version: 1 });
    expect((await ent.check("a", "seats", { amount: 6 })).allowed).toBe(false);
    expect(await ent.migratePlan("a", "pro")).toEqual({ migrated: 1 });
    expect((await ent.check("a", "seats", { amount: 6 })).allowed).toBe(true);
    expect(await ent.migratePlan("*", "pro", 2)).toEqual({ migrated: 1 });
    await expect(ent.migratePlan("*", "pro", 7)).rejects.toThrow(/no version 7/);
  });

  it("grants and overrides: validation, revoke, remove", async () => {
    const { ent } = setup();
    await expect(ent.grant("org", { feature: "sso", amount: 1 })).rejects.toThrow(/override/);
    await expect(ent.grant("org", { feature: "api_calls", amount: 0 })).rejects.toThrow(/> 0/);
    const g = await ent.grant("org", {
      feature: "api_calls",
      amount: 100,
      recurring: true,
      reason: "goodwill",
    });
    expect((await ent.check("org", "api_calls")).limit).toBe(1100);
    await ent.revokeGrant("org", g.id);
    expect((await ent.check("org", "api_calls")).limit).toBe(1000);
    await expect(ent.revokeGrant("org", g.id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(ent.override("org", { feature: "sso" })).rejects.toThrow(/needs/);
    await expect(ent.override("org", { feature: "sso", value: 1 })).rejects.toThrow(/not a value/);
    await expect(ent.override("org", { feature: "sso", limit: 3 })).rejects.toThrow(/no limit/);
    const o = await ent.override("org", { feature: "sso", enabled: true, reason: "pilot" });
    expect(await ent.check("org", "sso")).toMatchObject({
      allowed: true,
      reason: "granted_by_override",
    });
    await ent.removeOverride("org", o.id);
    expect((await ent.check("org", "sso")).allowed).toBe(false);
  });

  it("activity is recorded per customer and globally, newest first", async () => {
    const { ent } = setup();
    await ent.subscribe("org", { plan: "pro" }, { actor: { id: "u1", name: "Ada" } });
    await ent.grant(
      "org",
      { feature: "api_calls", amount: 5, reason: "sorry" },
      { actor: { id: "u1" } },
    );
    await ent.subscribe("other", { plan: "pro" });
    const mine = await ent.activity("org");
    expect(mine.map((a) => a.type)).toEqual(["grant.created", "subscription.changed"]);
    expect(mine[0]!.summary).toBe("Granted 5 API calls — sorry");
    expect(mine[1]!.actor).toEqual({ id: "u1", name: "Ada" });
    expect((await ent.activity()).map((a) => a.customer)).toEqual(["other", "org", "org"]);
  });

  it("before hooks can deny; after hooks see committed changes", async () => {
    const seen: string[] = [];
    const { ent } = setup({
      hooks: {
        before: (e) => {
          if (e.type === "grant.create" && e.grant.amount > 1000)
            throw new HookDeniedError("too generous");
        },
        after: (e) => void seen.push(e.type),
      },
    });
    await expect(ent.grant("org", { feature: "api_calls", amount: 5000 })).rejects.toThrow(
      "too generous",
    );
    expect(await ent.getCustomer("org")).toBeNull();
    await ent.grant("org", { feature: "api_calls", amount: 5 });
    expect(seen).toEqual(["grant.created"]);
  });

  it("customers: list, search, update, delete, links", async () => {
    const { ent } = setup();
    await ent.subscribe("org_b", { plan: "pro" });
    await ent.updateCustomer("org_a", {
      name: "Acme",
      email: "billing@acme.test",
      metadata: { tier: "x" },
    });
    await ent.updateCustomer("org_c", { name: "Contoso" });
    const all = await ent.listCustomers({ limit: 2 });
    expect(all.customers.map((c) => c.id)).toEqual(["org_a", "org_b"]);
    expect(all.next).toBe("org_b");
    expect((await ent.listCustomers({ after: all.next })).customers.map((c) => c.id)).toEqual([
      "org_c",
    ]);
    expect((await ent.listCustomers({ search: "acme" })).customers).toMatchObject([
      { id: "org_a", name: "Acme", plans: ["free"] },
    ]);
    expect((await ent.listCustomers({ search: "org_b" })).customers[0]!.plans).toEqual(["pro"]);
    await ent.link("org_a", "stripe", "cus_123");
    expect(await ent.resolveLink("stripe", "cus_123")).toBe("org_a");
    expect((await ent.getCustomer("org_a"))!.providers).toEqual({ stripe: "cus_123" });
    await ent.deleteCustomer("org_a");
    expect(await ent.getCustomer("org_a")).toBeNull();
    expect(await ent.resolveLink("stripe", "cus_123")).toBeNull();
    await expect(ent.deleteCustomer("org_a")).rejects.toBeInstanceOf(NotFoundError);
  });

  it("resetUsage and setUsage on metered features", async () => {
    const { ent } = setup();
    await ent.consume("org", "api_calls", 900);
    await ent.resetUsage("org", "api_calls");
    expect((await ent.check("org", "api_calls")).used).toBe(0);
    await ent.setUsage("org", "api_calls", 42, { actor: { id: "admin" } });
    expect((await ent.check("org", "api_calls")).used).toBe(42);
    await expect(ent.setUsage("org", "sso", 1)).rejects.toThrow(/no usage/);
  });

  it("readonly blocks control-plane writes but not consumption", async () => {
    const { ent } = setup({ readonly: true });
    await expect(ent.subscribe("org", { plan: "pro" })).rejects.toBeInstanceOf(ReadonlyError);
    await expect(ent.setUsage("org", "seats", 1)).rejects.toBeInstanceOf(ReadonlyError);
    expect((await ent.consume("org", "api_calls")).allowed).toBe(true);
  });

  it("entitlements() returns the full set with usage", async () => {
    const { ent } = setup();
    await ent.subscribe("org", { plan: "pro" });
    await ent.consume("org", "seats", 4);
    const e = await ent.entitlements("org");
    expect(e.plans[0]!.plan).toBe("pro");
    expect(e.features.seats).toMatchObject({ used: 4, remaining: 6, limit: 10 });
    expect(e.features.export_pdf!.enabled).toBe(true);
    expect(e.features.gpt_tokens).toMatchObject({ remaining: null });
    expect(ent.pricing().plans).toHaveLength(3);
  });

  it("bound customer client", async () => {
    const { ent } = setup();
    const org = ent.customer("org");
    expect((await org.consume("api_calls", 3)).used).toBe(3);
    expect((await org.check("max_upload_mb")).value).toBe(10);
    await expect(org.require("sso")).rejects.toBeInstanceOf(EntitlementDeniedError);
    expect((await org.reserve("exports", 1)).reservation).toBeDefined();
    expect((await org.release("exports")).used).toBe(0);
    expect((await org.entitlements()).customer).toBe("org");
  });

  it("usageSeries records daily usage", async () => {
    const { ent, clock } = setup({ usageSeries: true });
    await ent.consume("org", "api_calls", 5);
    clock.advance("1d");
    await ent.consume("org", "api_calls", 7);
    const s = await ent.usageSeries("org", "api_calls", { days: 3 });
    expect(s).toEqual([
      { date: "2026-11-19", value: 0 },
      { date: "2026-11-20", value: 5 },
      { date: "2026-11-21", value: 7 },
    ]);
    await ent.close();
  });
});

describe("caching and failure modes (ADR 0003)", () => {
  const flaky = () => {
    const inner = createMemoryStorage();
    let down = false;
    let reads = 0;
    const storage: EntitlementsStorage = {
      getItem: async (k) => {
        reads++;
        if (down) throw new Error("storage down");
        return inner.getItem(k);
      },
      setItem: (k, v) => inner.setItem(k, v),
      removeItem: (k) => inner.removeItem(k),
      getKeys: (p) => inner.getKeys(p),
    };
    return { storage, setDown: (d: boolean) => (down = d), reads: () => reads };
  };

  it("serves from memory; refresh failures keep last-known-good (stale)", async () => {
    const f = flaky();
    const { ent, clock } = setup({ storage: f.storage, cache: { ttl: "30s" } });
    await ent.subscribe("org", { plan: "pro" });
    const before = f.reads();
    for (let i = 0; i < 10; i++) await ent.check("org", "export_pdf");
    expect(f.reads()).toBe(before);
    f.setDown(true);
    clock.advance("31s");
    await ent.check("org", "export_pdf"); // triggers background refresh
    await new Promise((r) => setTimeout(r, 0));
    expect(await ent.check("org", "export_pdf")).toMatchObject({ allowed: true, stale: true });
  });

  it("unknown customer + storage down → fallback modes", async () => {
    for (const [mode, allowed, reason] of [
      ["default-plan", false, "not_in_plan"],
      ["deny", false, "fallback"],
      ["allow", true, "fallback"],
    ] as const) {
      const f = flaky();
      f.setDown(true);
      const { ent } = setup({ storage: f.storage, fallback: mode });
      expect(await ent.check("org", "export_pdf")).toMatchObject({ allowed, reason, stale: true });
    }
  });

  it("counter failures fail closed by default, open on request", async () => {
    const broken: CounterStore = {
      ...createMemoryCounterStore(),
      get: async () => {
        throw new Error("redis down");
      },
      add: async () => {
        throw new Error("redis down");
      },
    };
    const { ent } = setup({ counters: broken });
    expect(await ent.consume("org", "api_calls")).toMatchObject({
      allowed: false,
      reason: "fallback",
      stale: true,
    });
    expect(await ent.check("org", "api_calls")).toMatchObject({
      allowed: true,
      reason: "fallback",
      stale: true,
    });
    const { ent: open } = setup({ counters: broken, counterFallback: "allow" });
    expect((await open.consume("org", "api_calls")).allowed).toBe(true);
    expect((await open.entitlements("org")).stale).toBe(true);
  });

  it("watchable storage invalidates other instances", async () => {
    const storage = createMemoryStorage();
    const counters = createMemoryCounterStore();
    const a = createEntitlements({ catalog, storage, counters, usageSeries: false });
    const b = createEntitlements({
      catalog,
      storage,
      counters,
      usageSeries: false,
      cache: { ttl: "1h" },
    });
    expect((await b.check("org", "export_pdf")).allowed).toBe(false);
    await a.subscribe("org", { plan: "pro" });
    await new Promise((r) => setTimeout(r, 5));
    expect((await b.check("org", "export_pdf")).allowed).toBe(true);
    await a.close();
    await b.close();
  });

  it("CAS retries on concurrent writers keep every change", async () => {
    const storage = createMemoryStorage();
    const counters = createMemoryCounterStore();
    const a = createEntitlements({ catalog, storage, counters, usageSeries: false });
    const b = createEntitlements({ catalog, storage, counters, usageSeries: false });
    await Promise.all([
      ...Array.from({ length: 5 }, (_, i) =>
        a.grant("org", { feature: "api_calls", amount: i + 1 }),
      ),
      ...Array.from({ length: 5 }, (_, i) => b.grant("org", { feature: "exports", amount: i + 1 })),
    ]);
    expect(
      (await storage.getItem<{ grants: unknown[] }>("ent/customers/org"))!.grants,
    ).toHaveLength(10);
  });
});

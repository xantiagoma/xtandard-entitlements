import { createWebhooksCore } from "@xtandard/webhooks/core";
import { createMemoryStorage as createWebhooksMemoryStorage } from "@xtandard/webhooks/storage/memory";
import { describe, expect, test, vi } from "vitest";
import { auditHooks, type AuditRecordInputLike } from "../src/bridges/audit.ts";
import { ENTITLEMENTS_EVENT_TYPES, webhooksEvents } from "../src/bridges/webhooks.ts";
import { createTestEntitlements } from "../src/testing.ts";
import { billingCatalog } from "./billing-fixtures.ts";

const START = "2026-11-20T10:00:00Z";
const actor = { id: "u_1", name: "Ada", email: "ada@acme.test", type: "user" };

describe("auditHooks", () => {
  test("records every control-plane change with targets, actor and metadata", async () => {
    const recorded: AuditRecordInputLike[] = [];
    const audit = { record: async (input: AuditRecordInputLike) => void recorded.push(input) };
    const { ent } = createTestEntitlements({
      catalog: billingCatalog,
      now: START,
      hooks: auditHooks(audit, { tenant: "acme" }),
    });
    const sub = await ent.subscribe("org_1", { plan: "pro" }, { actor });
    await ent.upsertSubscription(
      "org_1",
      { id: sub.id, plan: "business", provider: "manual" },
      { actor },
    );
    await ent.cancelSubscription("org_1", sub.id);
    await ent.removeSubscription("org_1", sub.id);
    const grant = await ent.grant("org_1", { feature: "api_calls", amount: 500, reason: "promo" });
    await ent.revokeGrant("org_1", grant.id);
    const o = await ent.override("org_1", { feature: "sso", enabled: true });
    await ent.removeOverride("org_1", o.id);
    await ent.resetUsage("org_1", "api_calls");
    await ent.setUsage("org_1", "seats", 4);
    await ent.updateCustomer("org_1", { name: "Acme" });
    await ent.deleteCustomer("org_1");

    expect(recorded.map((r) => r.action)).toEqual([
      "entitlements.subscription.changed",
      "entitlements.subscription.changed",
      "entitlements.subscription.changed",
      "entitlements.subscription.removed",
      "entitlements.grant.created",
      "entitlements.grant.revoked",
      "entitlements.override.created",
      "entitlements.override.removed",
      "entitlements.usage.reset",
      "entitlements.usage.set",
      "entitlements.customer.updated",
      "entitlements.customer.deleted",
    ]);
    expect(recorded[0]).toEqual({
      tenant: "acme",
      action: "entitlements.subscription.changed",
      occurredAt: "2026-11-20T10:00:00.000Z",
      actor: { id: "u_1", type: "user", name: "Ada", email: "ada@acme.test" },
      targets: [
        { type: "customer", id: "org_1" },
        { type: "subscription", id: sub.id, name: "pro" },
      ],
      metadata: {
        plan: "pro",
        version: 2,
        kind: "plan",
        status: "active",
        quantity: 1,
        provider: "manual",
      },
      description: "pro (active)",
    });
    expect(recorded[1]!.description).toBe("business: pro → active");
    expect(recorded[1]!.metadata).toMatchObject({ previous: { plan: "pro", status: "active" } });
    expect(recorded[2]!.description).toBe("business: active → canceled");
    expect(recorded[2]!.actor).toBeUndefined();
    expect(recorded[4]).toMatchObject({
      targets: [
        { type: "customer" },
        { type: "grant", id: grant.id },
        { type: "feature", id: "api_calls" },
      ],
      metadata: { feature: "api_calls", amount: 500, reason: "promo" },
      description: "Granted 500 api_calls",
    });
    expect(recorded[5]!.description).toBe("Revoked 500 api_calls");
    expect(recorded[6]!.description).toBe("Override on sso");
    expect(recorded[7]!.description).toBe("Removed override on sso");
    expect(recorded[9]!.metadata).toEqual({ feature: "seats", value: 4 });
    expect(recorded[10]!.metadata).toEqual({ name: "Acme" });
    expect(recorded[11]!.description).toBe("Customer deleted");
  });

  test("tenant per event, custom prefix, event filter, no tenant", async () => {
    const record = vi.fn();
    const { ent } = createTestEntitlements({
      catalog: billingCatalog,
      hooks: [
        auditHooks(
          { record },
          { tenant: (e) => `t:${e.customer}`, actionPrefix: "billing.", events: ["grant.created"] },
        ),
        auditHooks({ record }, { events: ["usage.reset"] }),
      ],
    });
    await ent.subscribe("org_2", { plan: "pro" });
    await ent.grant("org_2", { feature: "api_calls", amount: 1 });
    await ent.resetUsage("org_2", "api_calls");
    expect(record.mock.calls.map((c) => [c[0].action, c[0].tenant])).toEqual([
      ["billing.grant.created", "t:org_2"],
      ["entitlements.usage.reset", undefined],
    ]);
  });

  test("a failing recorder is isolated by the hook runner", async () => {
    const onHookError = vi.fn();
    const { ent } = createTestEntitlements({
      catalog: billingCatalog,
      onHookError,
      hooks: auditHooks({ record: () => Promise.reject(new Error("audit down")) }),
    });
    await expect(ent.subscribe("org_3", { plan: "pro" })).resolves.toBeDefined();
    expect(onHookError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ type: "subscription.changed" }),
    );
  });
});

describe("webhooksEvents (against @xtandard/webhooks core)", () => {
  async function setup(options: Parameters<typeof webhooksEvents>[1] = {}) {
    const webhooks = createWebhooksCore({ storage: createWebhooksMemoryStorage() });
    for (const t of ENTITLEMENTS_EVENT_TYPES) await webhooks.upsertEventType(t);
    await webhooks.createApplication({ key: "org_1" });
    await webhooks.createApplication({ key: "acme" });
    const bridge = webhooksEvents(webhooks, options);
    const t = createTestEntitlements({
      catalog: billingCatalog,
      now: START,
      hooks: bridge.hooks,
      onThreshold: bridge.onThreshold,
      ...(bridge.onUsage ? { onUsage: bridge.onUsage } : {}),
    });
    // Runtime taps publish fire-and-forget: wait until `count` messages landed.
    const messagesOf = async (app: string, count: number) => {
      await vi.waitFor(
        async () => expect(await webhooks.listMessages(app, { limit: 100 })).toHaveLength(count),
        { timeout: 5_000, interval: 10 },
      );
      return webhooks.listMessages(app, { limit: 100 });
    };
    return { ...t, webhooks, bridge, messagesOf };
  }

  test("plan changes, trials, cancellations, grants, overrides, resets and thresholds", async () => {
    const { ent, bridge, messagesOf } = await setup();
    expect(bridge.onUsage).toBeUndefined();
    const trial = await ent.startTrial("org_1", "pro");
    await ent.cancelSubscription("org_1", trial.id);
    await ent.removeSubscription("org_1", trial.id);
    const g = await ent.grant("org_1", { feature: "api_calls", amount: 100 });
    await ent.revokeGrant("org_1", g.id);
    const o = await ent.override("org_1", { feature: "sso", enabled: true });
    await ent.removeOverride("org_1", o.id);
    await ent.resetUsage("org_1", "api_calls");
    await ent.setUsage("org_1", "seats", 1); // not published
    await ent.consume("org_1", "api_calls", 800); // free: 1,000 → crosses 80 %
    const messages = await messagesOf("org_1", 11);
    // Several events can land in the same millisecond, and message ids only sort
    // by time — compare the multiset, not the order.
    expect(messages.map((m) => m.eventType).sort()).toEqual(
      [
        "entitlements.subscription.changed",
        "entitlements.trial.started",
        "entitlements.subscription.changed",
        "entitlements.subscription.canceled",
        "entitlements.subscription.removed",
        "entitlements.grant.created",
        "entitlements.grant.revoked",
        "entitlements.override.created",
        "entitlements.override.removed",
        "entitlements.usage.reset",
        "entitlements.usage.threshold",
      ].sort(),
    );
    const threshold = messages[0]!;
    expect(threshold.payload).toMatchObject({
      customer: "org_1",
      feature: "api_calls",
      threshold: 0.8,
      used: 800,
      limit: 1000,
    });
    expect(threshold.idempotencyKey).toMatch(/^entitlements\.usage\.threshold\.org_1_api_calls_/);
    expect(messages.at(-1)!.payload).toMatchObject({
      customer: "org_1",
      subscription: { plan: "pro", status: "trialing" },
    });
  });

  test("fixed application, usage events, custom prefix", async () => {
    const { ent, webhooks, messagesOf } = await setup({
      application: "acme",
      usage: true,
      eventPrefix: "ent.",
    });
    for (const t of ENTITLEMENTS_EVENT_TYPES) {
      await webhooks.upsertEventType({ ...t, name: t.name.replace("entitlements.", "ent.") });
    }
    await ent.consume("org_9", "api_calls", 5, { idempotencyKey: "r1" });
    const r = await ent.reserve("org_9", "api_calls", 10);
    await ent.settle(r.reservation!.id, 4);
    await ent.consume("org_9", "api_calls", 1);
    const messages = await messagesOf("acme", 4);
    // Fire-and-forget publishes may land in any order.
    expect(
      messages
        .map((m) => [m.eventType, (m.payload as { amount: number }).amount] as const)
        .sort((a, b) => a[1] - b[1]),
    ).toEqual([
      ["ent.usage.recorded", -6],
      ["ent.usage.recorded", 1],
      ["ent.usage.recorded", 5],
      ["ent.usage.recorded", 10],
    ]);
    expect(
      messages.find((m) => (m.payload as { amount: number }).amount === 5)!.idempotencyKey,
    ).toBe("ent.usage.recorded.org_9_api_calls_r1");
  });

  test("application per customer via a function; publish errors surface to onHookError", async () => {
    const publish = vi.fn(async () => {
      throw new Error("queue down");
    });
    const onHookError = vi.fn();
    const bridge = webhooksEvents({ publish }, { application: (c) => `app_${c}` });
    const { ent } = createTestEntitlements({
      catalog: billingCatalog,
      hooks: bridge.hooks,
      onHookError,
    });
    await ent.subscribe("org_5", { plan: "business" });
    expect(publish).toHaveBeenCalledWith(
      "app_org_5",
      expect.objectContaining({ eventType: "entitlements.subscription.changed" }),
    );
    expect(onHookError).toHaveBeenCalled();
    // customer.* events are not published
    publish.mockClear();
    await ent.updateCustomer("org_5", { name: "x" });
    expect(publish).not.toHaveBeenCalled();
  });
});

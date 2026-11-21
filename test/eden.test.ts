import { describe, expect, test } from "vitest";
import { Elysia } from "elysia";
import { treaty } from "@elysiajs/eden";
import { entitlementsElysia } from "../src/adapters/elysia.ts";
import type { CheckResult, Subscription } from "../src/schema.ts";
import { createTestEntitlements } from "../src/testing.ts";
import { catalog } from "./fixtures.ts";

// Mounting the typed plugin under /billing gives Eden's treaty a typed surface:
// client.billing.api.customers({ id }).subscriptions.post(…), etc.
const { ent } = createTestEntitlements({ catalog, now: "2026-11-20T12:00:00Z" });
const app = new Elysia().use(
  entitlementsElysia({ entitlements: ent, prefix: "/billing", title: "Eden Test" }),
);
const client = treaty<typeof app>(app);
// Eden types the prefix group as optional; bind it once for ergonomic access.
const billing = client.billing!;
// Handlers delegate to a web Response, so Eden infers `data: Response`; cast via unknown.
const as = <T>(v: unknown): T => v as unknown as T;

describe("eden typed client", () => {
  test("reads bootstrap config", async () => {
    const { data, error } = await billing.config.get();
    expect(error).toBeNull();
    expect(as<{ title: string; basePath: string }>(data)).toMatchObject({
      title: "Eden Test",
      basePath: "/billing",
    });
  });

  test("subscribes, grants and reads a customer through the typed path", async () => {
    const customer = billing.api.customers({ id: "org_1" });
    const sub = await customer.subscriptions.post({ plan: "pro", quantity: 1 });
    expect(sub.response.status).toBe(201);
    expect(as<Subscription>(sub.data).plan).toBe("pro");

    const grant = await customer.grants.post({ feature: "ai_credits", amount: 100 });
    expect(grant.response.status).toBe(201);

    const detail = await customer.get();
    expect(
      as<{ state: { subscriptions: unknown[] } }>(detail.data).state.subscriptions,
    ).toHaveLength(1);
  });

  test("meters through the runtime API", async () => {
    const consumed = await billing.api.v1.consume.post({
      customer: "org_2",
      feature: "api_calls",
      amount: 10,
    });
    expect(as<CheckResult>(consumed.data)).toMatchObject({ allowed: true, used: 10 });
    const checked = await billing.api.v1.check.post({ customer: "org_2", feature: "sso" });
    expect(as<CheckResult>(checked.data).allowed).toBe(false);
    const ents = await billing.api.v1.entitlements({ customer: "org_2" }).get();
    expect(
      as<{ features: Record<string, { used?: number }> }>(ents.data).features.api_calls!.used,
    ).toBe(10);
  });

  test("usage, overrides and the portal preview", async () => {
    const usage = await billing.api.customers({ id: "org_3" }).usage({ feature: "seats" }).put({
      value: 2,
    });
    expect(as<CheckResult>(usage.data).used).toBe(2);
    const override = await billing.api
      .customers({ id: "org_3" })
      .overrides.post({ feature: "export_pdf", enabled: true });
    expect(override.response.status).toBe(201);
    const me = await billing.api.portal.me.get({ query: { customer: "org_3" } });
    expect(as<{ profile: { id: string } }>(me.data).profile.id).toBe("org_3");
  });

  test("exposes the OpenAPI document and pricing", async () => {
    const doc = await billing.api["openapi.json"].get();
    expect(as<{ openapi: string }>(doc.data).openapi).toBe("3.1.0");
    const pricing = await billing.api.pricing.get();
    expect(as<{ plans: unknown[] }>(pricing.data).plans.length).toBe(3);
  });
});

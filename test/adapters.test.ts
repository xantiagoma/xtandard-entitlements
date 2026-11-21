import { describe, expect, test } from "vitest";
import { Hono } from "hono";
import { Elysia } from "elysia";
import * as bun from "../src/adapters/bun.ts";
import * as elysia from "../src/adapters/elysia.ts";
import { denialOf, denialResponse, evaluateGuard, guardFetch } from "../src/adapters/guard.ts";
import * as hono from "../src/adapters/hono.ts";
import * as next from "../src/adapters/next.ts";
import type { CheckResult } from "../src/schema.ts";
import { createTestEntitlements } from "../src/testing.ts";
import { catalog } from "./fixtures.ts";
import { body, req } from "./server-helpers.ts";

const setup = () => createTestEntitlements({ catalog, now: "2026-11-20T12:00:00Z" });
const orgHeader = (r: Request) => r.headers.get("x-org-id");
const withOrg = (org: string, init: RequestInit = {}) => ({
  ...init,
  headers: { "x-org-id": org, ...(init.headers as Record<string, string> | undefined) },
});

describe("guard core", () => {
  test("allowed / 402 / 403 / 401 outcomes", async () => {
    const { ent } = setup();
    await ent.override("org_off", { feature: "export_pdf", enabled: false });
    const opts = { customer: (c: { org?: string }) => c.org };
    const free = await evaluateGuard(ent, "export_pdf", opts, { org: "org_free" });
    expect(free).toMatchObject({ allowed: false, status: 402 });
    const off = await evaluateGuard(ent, "export_pdf", opts, { org: "org_off" });
    expect(off).toMatchObject({ allowed: false, status: 403 });
    const nobody = await evaluateGuard(ent, "export_pdf", opts, {});
    expect(nobody).toMatchObject({ allowed: false, status: 401, result: null });
    const seats = await evaluateGuard(ent, "seats", { ...opts, amount: 2 }, { org: "org_free" });
    expect(seats).toMatchObject({ allowed: true, result: { remaining: 3 } });
  });

  test("consume mode records usage; check mode does not", async () => {
    const { ent } = setup();
    const ctx = { org: "org_1" };
    await evaluateGuard(ent, "api_calls", { customer: (c: typeof ctx) => c.org, amount: 5 }, ctx);
    expect((await ent.check("org_1", "api_calls")).used).toBe(0);
    await evaluateGuard(
      ent,
      "api_calls",
      { customer: (c: typeof ctx) => c.org, amount: async () => 5, consume: true },
      ctx,
    );
    expect((await ent.check("org_1", "api_calls")).used).toBe(5);
  });

  test("denial payloads", () => {
    const result: CheckResult = {
      allowed: false,
      feature: "sso",
      kind: "boolean",
      reason: "disabled_by_override",
      denial: "forbidden",
      unlockedBy: [],
    };
    expect(denialOf(result)).toEqual({
      status: 403,
      body: { error: 'Not entitled to "sso" (disabled_by_override)', ...result },
    });
    expect(denialResponse(result).status).toBe(403);
  });

  test("guardFetch forwards extra handler arguments", async () => {
    const { ent } = setup();
    const handler = guardFetch(
      ent,
      "seats",
      { customer: orgHeader },
      (_r, decision, extra: string) => Response.json({ extra, used: decision.used }),
    );
    const res = await handler(new Request("http://localhost/", withOrg("o")), "ctx");
    expect(await res.json()).toEqual({ extra: "ctx", used: 0 });
  });
});

describe("bun adapter", () => {
  test("entitlementsPanel is the fetch handler", async () => {
    const { ent } = setup();
    const panel = bun.entitlementsPanel({ entitlements: ent, basePath: "/billing" });
    const config = await body(await panel.fetch(req("GET", "/billing/config")));
    expect(config.basePath).toBe("/billing");
    expect(panel.engine).toBe(ent);
  });

  test("requireEntitlement wraps a route handler", async () => {
    const { ent } = setup();
    const guard = bun.requireEntitlement(ent, "export_pdf", { customer: orgHeader });
    const route = guard(async (_req, decision) => Response.json({ reason: decision.reason }));
    expect((await route(new Request("http://localhost/", withOrg("free")))).status).toBe(402);
    await ent.subscribe("pro_org", { plan: "pro" });
    const ok = await route(new Request("http://localhost/", withOrg("pro_org")));
    expect(await ok.json()).toEqual({ reason: "included" });
    const custom = bun.requireEntitlement(ent, "sso", {
      customer: orgHeader,
      onDenied: () => new Response("nope", { status: 418 }),
    })(() => new Response("ok"));
    expect((await custom(new Request("http://localhost/", withOrg("free")))).status).toBe(418);
  });
});

describe("hono adapter", () => {
  test("panel sub-app composes under app.route", async () => {
    const { ent } = setup();
    const panel = hono.entitlementsPanel({ entitlements: ent, basePath: "/billing" });
    const app = new Hono().route("/billing", panel);
    const res = await app.request("/billing/api/v1/consume", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ customer: "org_1", feature: "api_calls", amount: 2 }),
    });
    expect((await res.json()).used).toBe(2);
    expect(panel.engine).toBe(ent);
    expect(panel.openapi().openapi).toBe("3.1.0");
    panel.close();
  });

  test("requireEntitlement middleware sets c.var.entitlement", async () => {
    const { ent } = setup();
    const app = new Hono().post(
      "/export",
      hono.requireEntitlement(ent, "exports", {
        customer: (c) => c.req.header("x-org-id"),
        consume: true,
      }),
      (c) => c.json({ remaining: c.var.entitlement.remaining }),
    );
    const call = () => app.request("/export", withOrg("org_h", { method: "POST" }));
    expect(await (await call()).json()).toEqual({ remaining: 4 });
    for (let i = 0; i < 4; i++) await call();
    const refused = await call();
    expect(refused.status).toBe(402);
    expect(await refused.json()).toMatchObject({ reason: "limit_reached" });
    expect((await app.request("/export", { method: "POST" })).status).toBe(401);
  });
});

describe("next adapter", () => {
  test("toNextHandler exports every method from one panel", async () => {
    const { ent } = setup();
    const handlers = next.toNextHandler(
      next.entitlementsPanel({ entitlements: ent, basePath: "/billing" }),
    );
    expect(Object.keys(handlers).sort()).toEqual(
      ["DELETE", "GET", "HEAD", "OPTIONS", "PATCH", "POST", "PUT"].sort(),
    );
    const ctx = { params: Promise.resolve({ path: ["config"] }) };
    const config = await body(await handlers.GET(req("GET", "/billing/config"), ctx));
    expect(config.basePath).toBe("/billing");
    const sub = await handlers.POST(
      req("POST", "/billing/api/customers/org_1/subscriptions", { plan: "pro" }),
      ctx,
    );
    expect(sub.status).toBe(201);
    const patched = await handlers.PATCH(
      req("PATCH", "/billing/api/customers/org_1", { name: "N" }),
      ctx,
    );
    expect(patched.status).toBe(200);
    expect((await handlers.DELETE(req("DELETE", "/billing/api/customers/org_1"), ctx)).status).toBe(
      204,
    );
  });

  test("withEntitlement passes the decision with Next's route context", async () => {
    const { ent } = setup();
    const POST = next.withEntitlement(
      async (_request, { params, entitlement }) =>
        Response.json({ id: (await params).id, remaining: entitlement.remaining }),
      { engine: ent, feature: "seats", customer: orgHeader, consume: true },
    );
    const ctx = { params: Promise.resolve({ id: "p1" }) };
    const ok = await POST(
      new Request("http://localhost/", withOrg("org_n", { method: "POST" })),
      ctx,
    );
    expect(await ok.json()).toEqual({ id: "p1", remaining: 2 });
    const denied = next.withEntitlement(() => new Response("never"), {
      engine: ent,
      feature: "sso",
      customer: orgHeader,
    });
    const res = await denied(new Request("http://localhost/", withOrg("org_n")), ctx);
    expect(res.status).toBe(402);
  });
});

describe("elysia adapter (1.x)", () => {
  test("entitlementsPanel mounts under a prefix", async () => {
    const { ent } = setup();
    const panel = elysia.entitlementsPanel({ entitlements: ent, basePath: "/billing" });
    const app = new Elysia().mount("/billing", panel);
    const res = await app.handle(new Request("http://localhost/billing/config"));
    expect((await res.json()).basePath).toBe("/billing");
    expect(panel.engine).toBe(ent);
    expect(panel.openapi().openapi).toBe("3.1.0");
    panel.close();
  });

  test("typed plugin: parsed bodies are re-serialized; webhooks get the raw body; UI catch-all", async () => {
    const { ent } = setup();
    let raw = "";
    const app = new Elysia().use(
      elysia.entitlementsElysia({
        entitlements: ent,
        prefix: "/billing",
        billing: {
          providers: ["stripe"],
          canCheckout: false,
          canManage: false,
          async handleWebhook(_p, request) {
            raw = await request.text();
            return { outcome: "applied", events: 1 };
          },
          apply: async () => "applied",
          reconcile: async () => [],
          createCheckout: async () => ({ url: "" }),
          createPortalSession: async () => ({ url: "" }),
        },
      }),
    );
    const patched = await app.handle(
      req("PATCH", "/billing/api/customers/org_1", { name: "Acme", metadata: { a: 1 } }),
    );
    expect((await patched.json()).name).toBe("Acme");
    const body = '{"id":"evt_1",   "spaced":true}';
    const hook = await app.handle(req("POST", "/billing/webhooks/stripe", body));
    expect(hook.status).toBe(200);
    expect(raw).toBe(body);
    const ui = await app.handle(new Request("http://localhost/billing/customers"));
    expect(ui.status).toBe(200);
    expect(ui.headers.get("content-type")).toContain("text/html");
  });

  test("the plugin decorates the engine for host handlers", async () => {
    const { ent } = setup();
    const app = new Elysia()
      .use(elysia.entitlementsElysia({ entitlements: ent, prefix: "/billing" }))
      .get(
        "/usage",
        async ({ entitlements }) => (await entitlements.consume("org_d", "api_calls")).used,
      );
    expect(await (await app.handle(new Request("http://localhost/usage"))).text()).toBe("1");
  });

  test("requireEntitlement beforeHandle guard", async () => {
    const { ent } = setup();
    const app = new Elysia().get(
      "/export",
      (ctx) => ({ reason: (ctx as unknown as elysia.ElysiaGuardContext).entitlement!.reason }),
      {
        beforeHandle: elysia.requireEntitlement(ent, "export_pdf", {
          customer: ({ request }) => request.headers.get("x-org-id"),
        }),
      },
    );
    const denied = await app.handle(new Request("http://localhost/export", withOrg("free")));
    expect(denied.status).toBe(402);
    await ent.subscribe("pro_e", { plan: "pro" });
    const ok = await app.handle(new Request("http://localhost/export", withOrg("pro_e")));
    expect(await ok.json()).toEqual({ reason: "included" });
  });
});

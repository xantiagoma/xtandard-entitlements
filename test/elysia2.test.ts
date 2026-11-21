// Runs in the `elysia2` vitest project: `elysia` → the elysia-v2 devDep alias
// (see vite.config.ts + tsconfig.elysia2.json). Elysia 2's Eden is `@elysia/eden`.
import { describe, expect, test } from "vitest";
import { Elysia, t } from "elysia";
import { treaty } from "@elysia/eden";
import {
  entitlementsElysia,
  entitlementsPanel,
  requireEntitlement,
  type ElysiaGuardContext,
} from "../src/adapters/elysia2.ts";
import type { CheckResult } from "../src/schema.ts";
import { createTestEntitlements } from "../src/testing.ts";
import { catalog } from "./fixtures.ts";

const { ent } = createTestEntitlements({ catalog, now: "2026-11-20T12:00:00Z" });
let raw = "";
const app = new Elysia().use(
  entitlementsElysia({
    entitlements: ent,
    prefix: "/billing",
    title: "Eden v2",
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
const client = treaty<typeof app>(app);
const billing = client.billing!;
// Handlers delegate to a web Response, so Eden infers `data: Response`; cast via unknown.
const as = <T>(v: unknown): T => v as unknown as T;

describe("elysia 2 adapter", () => {
  test("runs against Elysia 2 (rejects the 1.x handler-then-hook order)", () => {
    const legacy = () =>
      // the 1.x order type-checks on v2, but Elysia 2 throws on it at registration
      new Elysia().post("/x", () => "x", { body: t.Object({ k: t.String() }) });
    expect(legacy).toThrow(/1\.x order/);
  });

  test("entitlementsPanel mounts under a prefix", async () => {
    const panel = entitlementsPanel({ entitlements: ent, basePath: "/billing" });
    const mounted = new Elysia().mount("/billing", panel);
    const res = await mounted.handle(new Request("http://localhost/billing/config"));
    expect((await res.json()).basePath).toBe("/billing");
    expect(panel.engine).toBe(ent);
  });

  test("reads bootstrap config via the typed client", async () => {
    const { data, error } = await billing.config.get();
    expect(error).toBeNull();
    expect(as<{ title: string }>(data).title).toBe("Eden v2");
  });

  test("subscribes and meters through the typed path", async () => {
    const sub = await billing.api.customers({ id: "org_1" }).subscriptions.post({ plan: "pro" });
    expect(sub.response.status).toBe(201);
    const consumed = await billing.api.v1.consume.post({
      customer: "org_1",
      feature: "api_calls",
      amount: 3,
    });
    expect(as<CheckResult>(consumed.data)).toMatchObject({ allowed: true, used: 3 });
  });

  test("validates declared bodies", async () => {
    const res = await app.handle(
      new Request("http://localhost/billing/api/v1/check", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ feature: "missing customer" }),
      }),
    );
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });

  test("billing webhooks receive the raw body", async () => {
    const body = '{"id":"evt_1",  "x":1}';
    const res = await app.handle(
      new Request("http://localhost/billing/webhooks/stripe", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      }),
    );
    expect(res.status).toBe(200);
    expect(raw).toBe(body);
  });

  test("requireEntitlement guard and the decorated engine", async () => {
    const guarded = new Elysia()
      .use(entitlementsElysia({ entitlements: ent, prefix: "/b2" }))
      .get(
        "/export",
        {
          beforeHandle: requireEntitlement(ent, "export_pdf", {
            customer: ({ request }) => request.headers.get("x-org-id"),
          }),
        },
        (ctx) => ({ reason: (ctx as unknown as ElysiaGuardContext).entitlement!.reason }),
      )
      .get(
        "/used",
        async ({ entitlements }) => (await entitlements.check("org_1", "api_calls")).used,
      );
    const denied = await guarded.handle(
      new Request("http://localhost/export", { headers: { "x-org-id": "free" } }),
    );
    expect(denied.status).toBe(402);
    const ok = await guarded.handle(
      new Request("http://localhost/export", { headers: { "x-org-id": "org_1" } }),
    );
    expect(await ok.json()).toEqual({ reason: "included" });
    expect(await (await guarded.handle(new Request("http://localhost/used"))).text()).toBe("3");
  });

  test("serves the bundled UI catch-all", async () => {
    const res = await app.handle(new Request("http://localhost/billing/"));
    expect(res.status).toBeLessThan(500);
  });
});

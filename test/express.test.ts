import { afterAll, beforeAll, describe, expect, test } from "vitest";
import express from "express";
import type { Server } from "node:http";
import {
  entitlementsPanel,
  requireEntitlement,
  type EntitlementRequest,
} from "../src/adapters/express.ts";
import { createTestEntitlements } from "../src/testing.ts";
import { catalog } from "./fixtures.ts";
import { fakeBilling } from "./server-helpers.ts";

let server: Server;
let base: string;
const { ent } = createTestEntitlements({ catalog, now: "2026-11-20T12:00:00Z" });
const billing = fakeBilling();
const panel = entitlementsPanel({ entitlements: ent, basePath: "/billing", billing });
const org = (req: express.Request) => req.get("x-org-id");

beforeAll(async () => {
  const app = express();
  app.get("/", (_req, res) => res.send("app"));
  app.use("/billing", panel);
  // An upstream body parser consumes the stream first → the adapter re-serializes req.body.
  app.use("/parsed", express.json(), entitlementsPanel({ entitlements: ent, basePath: "/parsed" }));
  app.post("/export", requireEntitlement(ent, "export_pdf", { customer: org }), (req, res) => {
    res.json({ ok: true, reason: (req as EntitlementRequest).entitlement!.reason });
  });
  app.post(
    "/call",
    requireEntitlement(ent, "exports", {
      customer: org,
      consume: true,
      amount: (req) => Number(req.get("x-amount") ?? 1),
      idempotencyKey: (req) => req.get("idempotency-key"),
    }),
    (_req, res) => res.json({ remaining: res.locals.entitlement.remaining }),
  );
  app.get(
    "/sso",
    requireEntitlement(ent, "sso", {
      customer: org,
      onDenied: (result) => new Response(`upgrade to ${result.unlockedBy[0]}`, { status: 402 }),
    }),
    (_req, res) => res.send("sso"),
  );
  app.get(
    "/boom",
    requireEntitlement(ent, "sso", {
      customer: () => {
        throw new Error("session store down");
      },
    }),
    (_req, res) => res.send("unreachable"),
  );
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => resolve());
  });
  const addr = server.address();
  base = `http://localhost:${typeof addr === "object" && addr ? addr.port : 0}`;
});

afterAll(() => {
  server?.close();
});

describe("express panel", () => {
  test("serves config and the API under the mount path; exposes engine + openapi", async () => {
    const res = await fetch(`${base}/billing/config`);
    expect((await res.json()).basePath).toBe("/billing");
    expect(panel.engine).toBe(ent);
    expect(panel.openapi().openapi).toBe("3.1.0");
    panel.close();
  });

  test("POST bodies reach the router (raw stream and pre-parsed)", async () => {
    for (const mount of ["billing", "parsed"]) {
      const res = await fetch(`${base}/${mount}/api/v1/consume`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ customer: `org_${mount}`, feature: "api_calls", amount: 3 }),
      });
      expect((await res.json()).used).toBe(3);
    }
  });

  test("billing webhooks receive the raw body", async () => {
    const raw = '{"id":"evt_1",   "x":1}';
    const res = await fetch(`${base}/billing/webhooks/stripe`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-signature": "ok" },
      body: raw,
    });
    expect(res.status).toBe(200);
    expect(billing.calls.webhooks.at(-1)!.body).toBe(raw);
  });

  test("other routes of the host app are untouched", async () => {
    expect(await (await fetch(`${base}/`)).text()).toBe("app");
  });
});

describe("express requireEntitlement", () => {
  test("402 with the upsell payload, 401 without a customer, next() when allowed", async () => {
    const denied = await fetch(`${base}/export`, {
      method: "POST",
      headers: { "x-org-id": "org_free" },
    });
    expect(denied.status).toBe(402);
    expect(await denied.json()).toMatchObject({
      error: expect.stringContaining("export_pdf"),
      allowed: false,
      reason: "not_in_plan",
      unlockedBy: expect.arrayContaining(["pro"]),
    });
    expect((await fetch(`${base}/export`, { method: "POST" })).status).toBe(401);

    await ent.subscribe("org_pro", { plan: "pro" });
    const ok = await fetch(`${base}/export`, {
      method: "POST",
      headers: { "x-org-id": "org_pro" },
    });
    expect(await ok.json()).toEqual({ ok: true, reason: "included" });
  });

  test("consume mode meters per request and refuses past the limit", async () => {
    const call = (amount: number, key?: string) =>
      fetch(`${base}/call`, {
        method: "POST",
        headers: {
          "x-org-id": "org_meter",
          "x-amount": String(amount),
          ...(key ? { "idempotency-key": key } : {}),
        },
      });
    expect((await (await call(3, "a")).json()).remaining).toBe(2);
    expect((await (await call(3, "a")).json()).remaining).toBe(2); // idempotent
    const refused = await call(3);
    expect(refused.status).toBe(402);
    expect((await refused.json()).reason).toBe("limit_reached");
  });

  test("onDenied and resolver errors", async () => {
    const custom = await fetch(`${base}/sso`, { headers: { "x-org-id": "org_free" } });
    expect(custom.status).toBe(402);
    expect(await custom.text()).toBe("upgrade to business");
    expect((await fetch(`${base}/boom`)).status).toBe(500);
  });
});

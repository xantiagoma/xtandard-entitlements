import { mkdtempSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { HookDeniedError } from "../src/hooks/contract.ts";
import type {
  CustomerEntitlements,
  CustomerState,
  Grant,
  Override,
  Subscription,
} from "../src/schema.ts";
import { createFetchHandler } from "../src/server/create-fetch-handler.ts";
import {
  mapError,
  type CatalogView,
  type Overview,
  type PanelConfig,
} from "../src/server/routes.ts";
import type { CheckResult } from "../src/schema.ts";
import { catalog } from "./fixtures.ts";
import { body, fakeBilling, req, testPanel } from "./server-helpers.ts";

describe("public routes", () => {
  test("healthcheck", async () => {
    const { panel } = testPanel();
    const res = await panel.fetch(req("GET", "/healthcheck"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  test("config (both paths) describes the admin mode and the billing providers", async () => {
    const { panel } = testPanel({ title: "Acme", logoUrl: "/logo.svg", billing: fakeBilling() });
    for (const path of ["/config", "/api/config"]) {
      const config = await body<PanelConfig>(await panel.fetch(req("GET", path)));
      expect(config).toMatchObject({
        title: "Acme",
        logoUrl: "/logo.svg",
        basePath: "",
        readonly: false,
        mode: "admin",
        authenticated: true,
        principal: { id: "anonymous" },
        billingProviders: ["stripe"],
      });
    }
    expect((await panel.fetch(req("POST", "/config"))).status).toBe(405);
  });

  test("openapi.json is served without auth", async () => {
    const { panel } = testPanel();
    const doc = await body<{ openapi: string }>(await panel.fetch(req("GET", "/api/openapi.json")));
    expect(doc.openapi).toBe("3.1.0");
    expect(panel.openapi()).toEqual(doc);
  });

  test("pricing is public, CORS-open, and hides hidden plans", async () => {
    const { panel } = testPanel();
    const res = await panel.fetch(req("GET", "/api/pricing"));
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    const pricing = await body<{ plans: Array<{ key: string }> }>(res);
    expect(pricing.plans.map((p) => p.key)).toEqual(["free", "pro", "business"]);
  });

  test("unknown API path → 404 JSON; known path, wrong method → 405 with Allow", async () => {
    const { panel } = testPanel();
    const missing = await panel.fetch(req("GET", "/api/nope"));
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: "Not found" });

    const wrong = await panel.fetch(req("PUT", "/api/customers"));
    expect(wrong.status).toBe(405);
    expect(wrong.headers.get("allow")).toBe("GET");

    const multi = await panel.fetch(req("POST", "/api/customers/c1"));
    expect(multi.headers.get("allow")).toBe("GET, PATCH, DELETE");
  });

  test("HEAD is answered like GET", async () => {
    const { panel } = testPanel();
    expect((await panel.fetch(req("HEAD", "/healthcheck"))).status).toBe(200);
  });

  test("non-API paths fall through to the SPA (or a build hint), assets 404, writes 405", async () => {
    const { panel } = testPanel();
    const spa = await panel.fetch(req("GET", "/customers/org_1"));
    expect(spa.status).toBe(200);
    expect(spa.headers.get("content-type")).toContain("text/html");
    expect(await spa.text()).toContain("bun run build:ui");

    expect((await panel.fetch(req("GET", "/assets/missing.js"))).status).toBe(404);
    expect((await panel.fetch(req("POST", "/customers/org_1"))).status).toBe(405);
  });

  test("serves the built UI and its assets under a base path", async () => {
    const uiDir = join(mkdtempSync(join(tmpdir(), "xte-ui-")), "ui");
    await mkdir(join(uiDir, "assets"), { recursive: true });
    await writeFile(join(uiDir, "index.html"), "<html><head></head><body>app</body></html>");
    await writeFile(join(uiDir, "assets", "app.js"), "console.log(1)");
    const { panel } = testPanel({ uiDir, basePath: "/billing/" });

    const html = await (await panel.fetch(req("GET", "/billing/customers"))).text();
    expect(html).toContain('<base href="/billing/">');
    expect(html).toContain("window.__ENTITLEMENTS_CONFIG__=");
    const js = await panel.fetch(req("GET", "/billing/assets/app.js"));
    expect(await js.text()).toBe("console.log(1)");
    const config = await body<PanelConfig>(await panel.fetch(req("GET", "/billing/config")));
    expect(config.basePath).toBe("/billing");
  });
});

describe("catalog + overview", () => {
  test("catalog view: features in order, every plan version (current first), hidden plans", async () => {
    const { panel } = testPanel();
    const view = await body<CatalogView>(await panel.fetch(req("GET", "/api/catalog")));
    expect(view.features.map((f) => f.key)).toEqual(catalog.normalized.featureOrder);
    expect(view.plans.map((p) => `${p.key}@${p.version}`)).toEqual([
      "free@1",
      "pro@2",
      "pro@1",
      "business@1",
      "enterprise@1",
    ]);
    expect(view.addons.map((a) => a.key)).toEqual(["extra_seats", "sso_addon"]);
    expect(view.pricing.plans.map((p) => p.key)).toContain("enterprise");
  });

  test("overview counts customers by plan, statuses, trials ending soon and activity", async () => {
    const { panel, ent, clock } = testPanel();
    await ent.subscribe("a", { plan: "pro" });
    await ent.startTrial("b", "business", { days: 3 });
    await ent.startTrial("c", "pro", { days: 30 });
    await ent.updateCustomer("d", { name: "Dee" });
    const overview = await body<Overview>(await panel.fetch(req("GET", "/api/overview")));
    expect(overview.customers).toBe(4);
    expect(overview.byPlan).toMatchObject({ pro: 2, business: 1, free: 1 });
    expect(overview.statuses.active).toBe(1);
    expect(overview.statuses.trialing).toBe(2);
    expect(overview.statuses.canceled).toBe(0);
    expect(overview.trialsEndingSoon).toEqual([
      {
        customer: "b",
        plan: "business",
        trialEndsAt: new Date(clock.now() + 3 * 86_400_000).toISOString(),
      },
    ]);
    expect(overview.recentActivity.length).toBeGreaterThan(0);
    expect(overview.recentActivity.length).toBeLessThanOrEqual(20);
  });
});

describe("customers", () => {
  test("list, search, paginate; invalid limit → 400", async () => {
    const { panel, ent } = testPanel();
    await ent.updateCustomer("org_a", { name: "Alpha", email: "a@acme.test" });
    await ent.updateCustomer("org_b", { name: "Beta" });
    await ent.updateCustomer("org_c", { name: "Gamma" });

    const all = await body<{ customers: Array<{ id: string }> }>(
      await panel.fetch(req("GET", "/api/customers")),
    );
    expect(all.customers.map((c) => c.id)).toEqual(["org_a", "org_b", "org_c"]);

    const search = await body<{ customers: Array<{ id: string }> }>(
      await panel.fetch(req("GET", "/api/customers?search=acme.test")),
    );
    expect(search.customers.map((c) => c.id)).toEqual(["org_a"]);

    const page = await body<{ customers: Array<{ id: string }>; next?: string }>(
      await panel.fetch(req("GET", "/api/customers?limit=2")),
    );
    expect(page.customers).toHaveLength(2);
    expect(page.next).toBe("org_b");
    const rest = await body<{ customers: Array<{ id: string }>; next?: string }>(
      await panel.fetch(req("GET", `/api/customers?limit=2&after=${page.next}`)),
    );
    expect(rest.customers.map((c) => c.id)).toEqual(["org_c"]);
    expect(rest.next).toBeUndefined();

    const bad = await panel.fetch(req("GET", "/api/customers?limit=abc"));
    expect(bad.status).toBe(400);
  });

  test("detail: unknown customers resolve to the default plan with a null state", async () => {
    const { panel } = testPanel();
    const detail = await body<{ state: CustomerState | null; entitlements: CustomerEntitlements }>(
      await panel.fetch(req("GET", "/api/customers/ghost")),
    );
    expect(detail.state).toBeNull();
    expect(detail.entitlements.plans[0]!.plan).toBe("free");
    expect(detail.entitlements.features.api_calls!.limit).toBe(1_000);
  });

  test("patch merges metadata; delete → 204 then 404", async () => {
    const { panel } = testPanel();
    const first = await panel.fetch(
      req("PATCH", "/api/customers/org_1", { name: "Acme", metadata: { tier: "gold" } }),
    );
    expect(first.status).toBe(200);
    const state = await body<CustomerState>(
      await panel.fetch(req("PATCH", "/api/customers/org_1", { metadata: { region: "eu" } })),
    );
    expect(state.name).toBe("Acme");
    expect(state.metadata).toEqual({ tier: "gold", region: "eu" });

    const del = await panel.fetch(req("DELETE", "/api/customers/org_1"));
    expect(del.status).toBe(204);
    expect(await del.text()).toBe("");
    const again = await panel.fetch(req("DELETE", "/api/customers/org_1"));
    expect(again.status).toBe(404);
    expect(await body(again)).toMatchObject({ code: "NOT_FOUND" });
  });

  test("ids with reserved characters round-trip through the path", async () => {
    const { panel } = testPanel();
    const id = "org/with spaces";
    await panel.fetch(req("PATCH", `/api/customers/${encodeURIComponent(id)}`, { name: "X" }));
    const detail = await body<{ state: CustomerState }>(
      await panel.fetch(req("GET", `/api/customers/${encodeURIComponent(id)}`)),
    );
    expect(detail.state.id).toBe(id);
  });

  test("schema errors → 400 { error, issues }", async () => {
    const { panel } = testPanel();
    const res = await panel.fetch(
      req("PATCH", "/api/customers/org_1", { name: 42, unknownField: true }),
    );
    expect(res.status).toBe(400);
    const err = await body<{ error: string; code: string; issues: Array<{ path: string }> }>(res);
    expect(err.code).toBe("VALIDATION");
    expect(err.issues.map((i) => i.path).sort()).toEqual(["name", "unknownField"]);
  });

  test("malformed JSON → 400", async () => {
    const { panel } = testPanel();
    const res = await panel.fetch(req("PATCH", "/api/customers/org_1", "{not json"));
    expect(res.status).toBe(400);
    expect(await body(res)).toEqual({ error: "Invalid JSON body", code: "VALIDATION" });
  });
});

describe("subscriptions", () => {
  test("subscribe → 201; patch; cancel at period end; cancel now; remove → 204", async () => {
    const { panel } = testPanel();
    const created = await panel.fetch(
      req("POST", "/api/customers/org_1/subscriptions", { plan: "pro", quantity: 1 }),
    );
    expect(created.status).toBe(201);
    const sub = await body<Subscription>(created);
    expect(sub).toMatchObject({ plan: "pro", version: 2, status: "active", provider: "manual" });

    const patched = await body<Subscription>(
      await panel.fetch(
        req("PATCH", `/api/customers/org_1/subscriptions/${sub.id}`, { version: 1, quantity: 3 }),
      ),
    );
    expect(patched).toMatchObject({ id: sub.id, plan: "pro", version: 1, quantity: 3 });

    const atEnd = await body<Subscription>(
      await panel.fetch(
        req("POST", `/api/customers/org_1/subscriptions/${sub.id}/cancel`, { atPeriodEnd: true }),
      ),
    );
    expect(atEnd.cancelAtPeriodEnd).toBe(true);

    const now = await body<Subscription>(
      await panel.fetch(req("POST", `/api/customers/org_1/subscriptions/${sub.id}/cancel`)),
    );
    expect(now.status).toBe("canceled");

    const removed = await panel.fetch(
      req("DELETE", `/api/customers/org_1/subscriptions/${sub.id}`),
    );
    expect(removed.status).toBe(204);
  });

  test("unknown subscription → 404; unknown plan → 400; bad status → 400", async () => {
    const { panel } = testPanel();
    expect(
      (await panel.fetch(req("PATCH", "/api/customers/org_1/subscriptions/sub_x", { quantity: 2 })))
        .status,
    ).toBe(404);
    const unknownPlan = await panel.fetch(
      req("POST", "/api/customers/org_1/subscriptions", { plan: "platinum" }),
    );
    expect(unknownPlan.status).toBe(400);
    expect((await body<{ error: string }>(unknownPlan)).error).toContain("platinum");
    const badStatus = await panel.fetch(
      req("POST", "/api/customers/org_1/subscriptions", { plan: "pro", status: "zombie" }),
    );
    expect(badStatus.status).toBe(400);
  });

  test("trials → 201 trialing; a second trial of the same plan → 400", async () => {
    const { panel } = testPanel();
    const trial = await panel.fetch(req("POST", "/api/customers/org_1/trials", { plan: "pro" }));
    expect(trial.status).toBe(201);
    expect((await body<Subscription>(trial)).status).toBe("trialing");
    const again = await panel.fetch(req("POST", "/api/customers/org_1/trials", { plan: "pro" }));
    expect(again.status).toBe(400);
    const forced = await panel.fetch(
      req("POST", "/api/customers/org_1/trials", { plan: "pro", days: 7, force: true }),
    );
    expect(forced.status).toBe(201);
  });

  test("migrate a plan to its current version (all customers, or one)", async () => {
    const { panel, ent } = testPanel();
    await ent.subscribe("a", { plan: "pro", version: 1 });
    await ent.subscribe("b", { plan: "pro", version: 1 });
    const one = await body<{ migrated: number }>(
      await panel.fetch(req("POST", "/api/plans/pro/migrate", { customer: "a" })),
    );
    expect(one.migrated).toBe(1);
    const all = await body<{ migrated: number }>(
      await panel.fetch(req("POST", "/api/plans/pro/migrate")),
    );
    expect(all.migrated).toBe(1);
    const unknown = await panel.fetch(req("POST", "/api/plans/nope/migrate", {}));
    expect(unknown.status).toBe(400);
  });
});

describe("grants + overrides", () => {
  test("grant → 201, revoke → 204, unknown grant → 404, boolean feature → 400", async () => {
    const { panel } = testPanel();
    const created = await panel.fetch(
      req("POST", "/api/customers/org_1/grants", {
        feature: "api_calls",
        amount: 500,
        reason: "goodwill",
      }),
    );
    expect(created.status).toBe(201);
    const grant = await body<Grant>(created);
    expect(grant).toMatchObject({ feature: "api_calls", amount: 500, actor: { id: "anonymous" } });

    expect(
      (await panel.fetch(req("DELETE", `/api/customers/org_1/grants/${grant.id}`))).status,
    ).toBe(204);
    expect(
      (await panel.fetch(req("DELETE", `/api/customers/org_1/grants/${grant.id}`))).status,
    ).toBe(404);
    const bool = await panel.fetch(
      req("POST", "/api/customers/org_1/grants", { feature: "export_pdf", amount: 1 }),
    );
    expect(bool.status).toBe(400);
    const negative = await panel.fetch(
      req("POST", "/api/customers/org_1/grants", { feature: "api_calls", amount: -1 }),
    );
    expect(negative.status).toBe(400);
  });

  test("override → 201 changes the decision; remove → 204", async () => {
    const { panel } = testPanel();
    const res = await panel.fetch(
      req("POST", "/api/customers/org_1/overrides", { feature: "export_pdf", enabled: true }),
    );
    expect(res.status).toBe(201);
    const override = await body<Override>(res);
    const decision = await body<CheckResult>(
      await panel.fetch(req("POST", "/api/v1/check", { customer: "org_1", feature: "export_pdf" })),
    );
    expect(decision).toMatchObject({ allowed: true, reason: "granted_by_override" });
    expect(
      (await panel.fetch(req("DELETE", `/api/customers/org_1/overrides/${override.id}`))).status,
    ).toBe(204);
    const empty = await panel.fetch(
      req("POST", "/api/customers/org_1/overrides", { feature: "export_pdf" }),
    );
    expect(empty.status).toBe(400);
  });
});

describe("usage", () => {
  test("PUT sets usage and answers the decision; DELETE resets; series", async () => {
    const { panel } = testPanel({ engine: { catalog, usageSeries: true } });
    const set = await body<CheckResult>(
      await panel.fetch(req("PUT", "/api/customers/org_1/usage/seats", { value: 2 })),
    );
    expect(set).toMatchObject({ feature: "seats", used: 2, remaining: 1, allowed: true });

    await panel.fetch(
      req("POST", "/api/v1/consume", { customer: "org_1", feature: "api_calls", amount: 7 }),
    );
    expect((await panel.fetch(req("DELETE", "/api/customers/org_1/usage/api_calls"))).status).toBe(
      204,
    );
    const after = await body<CheckResult>(
      await panel.fetch(req("POST", "/api/v1/check", { customer: "org_1", feature: "api_calls" })),
    );
    expect(after.used).toBe(0);

    const series = await body<Array<{ date: string; value: number }>>(
      await panel.fetch(req("GET", "/api/customers/org_1/usage/api_calls/series?days=7")),
    );
    expect(series).toHaveLength(7);
    expect(series.at(-1)!.date).toBe("2026-11-20");
    expect(series.at(-1)!.value).toBe(7);
  });

  test("usage on a boolean feature → 400; negative value → 400", async () => {
    const { panel } = testPanel();
    expect(
      (await panel.fetch(req("PUT", "/api/customers/org_1/usage/export_pdf", { value: 1 }))).status,
    ).toBe(400);
    expect(
      (await panel.fetch(req("PUT", "/api/customers/org_1/usage/seats", { value: -1 }))).status,
    ).toBe(400);
  });

  test("reservation sweep releases expired reservations", async () => {
    const { panel, clock } = testPanel();
    const reserved = await body<{ reservation: { id: string } }>(
      await panel.fetch(
        req("POST", "/api/v1/reserve", {
          customer: "org_1",
          feature: "api_calls",
          amount: 10,
          ttl: "1m",
        }),
      ),
    );
    expect(reserved.reservation.id).toBeTruthy();
    clock.advance("2m");
    const swept = await body<{ released: number }>(
      await panel.fetch(req("POST", "/api/reservations/sweep")),
    );
    expect(swept.released).toBe(1);
  });
});

describe("activity", () => {
  test("per customer and global, with limit", async () => {
    const { panel, ent } = testPanel();
    await ent.updateCustomer("a", { name: "A" });
    await ent.grant("a", { feature: "api_calls", amount: 5 });
    await ent.updateCustomer("b", { name: "B" });
    const mine = await body<Array<{ customer: string }>>(
      await panel.fetch(req("GET", "/api/customers/a/activity")),
    );
    expect(mine.length).toBe(2);
    expect(mine.every((e) => e.customer === "a")).toBe(true);
    const global = await body<unknown[]>(await panel.fetch(req("GET", "/api/activity?limit=2")));
    expect(global).toHaveLength(2);
    const one = await body<unknown[]>(
      await panel.fetch(req("GET", "/api/customers/a/activity?limit=1")),
    );
    expect(one).toHaveLength(1);
  });
});

describe("runtime API", () => {
  test("check: 200 even when denied, with denial + unlockedBy", async () => {
    const { panel } = testPanel();
    const res = await panel.fetch(
      req("POST", "/api/v1/check", { customer: "org_1", feature: "sso" }),
    );
    expect(res.status).toBe(200);
    expect(await body<CheckResult>(res)).toMatchObject({
      allowed: false,
      reason: "not_in_plan",
      denial: "payment_required",
      unlockedBy: expect.arrayContaining(["business"]),
    });
    const amount = await body<CheckResult>(
      await panel.fetch(
        req("POST", "/api/v1/check", { customer: "org_1", feature: "api_calls", amount: 5_000 }),
      ),
    );
    expect(amount.allowed).toBe(false);
  });

  test("consume to the limit; a refusal never counts; idempotency header", async () => {
    const { panel } = testPanel();
    const consume = (amount: number, headers: Record<string, string> = {}) =>
      panel.fetch(
        req("POST", "/api/v1/consume", { customer: "org_1", feature: "exports", amount }, headers),
      );
    expect((await body<CheckResult>(await consume(4))).remaining).toBe(1);
    const refused = await body<CheckResult>(await consume(2));
    expect(refused).toMatchObject({ allowed: false, reason: "limit_reached", used: 4 });

    const key = { "idempotency-key": "k-1" };
    expect((await body<CheckResult>(await consume(1, key))).allowed).toBe(true);
    const dup = await body<CheckResult>(await consume(1, key));
    expect(dup.duplicate).toBe(true);
    const viaBody = await body<CheckResult>(
      await panel.fetch(
        req("POST", "/api/v1/consume", {
          customer: "org_2",
          feature: "exports",
          idempotencyKey: "k-2",
        }),
      ),
    );
    expect(viaBody.used).toBe(1);
  });

  test("release gives units back", async () => {
    const { panel } = testPanel();
    await panel.fetch(
      req("POST", "/api/v1/consume", { customer: "org_1", feature: "seats", amount: 3 }),
    );
    const released = await body<CheckResult>(
      await panel.fetch(req("POST", "/api/v1/release", { customer: "org_1", feature: "seats" })),
    );
    expect(released.used).toBe(2);
  });

  test("reserve + settle; unknown reservation → 404", async () => {
    const { panel } = testPanel();
    await panel.fetch(req("POST", "/api/customers/org_1/subscriptions", { plan: "pro" }));
    const reserved = await body<CheckResult & { reservation: { id: string } }>(
      await panel.fetch(
        req("POST", "/api/v1/reserve", { customer: "org_1", feature: "gpt_tokens", amount: 4_000 }),
      ),
    );
    expect(reserved.allowed).toBe(true);
    const settled = await body<CheckResult>(
      await panel.fetch(
        req("POST", "/api/v1/settle", {
          reservationId: reserved.reservation.id,
          actual: 3_000,
          overage: "cap",
        }),
      ),
    );
    expect(settled.allowed).toBe(true);
    const ent = await body<CustomerEntitlements>(
      await panel.fetch(req("GET", "/api/v1/entitlements/org_1")),
    );
    expect(ent.features.ai_credits!.used).toBe(30);

    const missing = await panel.fetch(
      req("POST", "/api/v1/settle", { reservationId: "rsv_nope", actual: 1 }),
    );
    expect(missing.status).toBe(404);
  });

  test("runtime input is validated", async () => {
    const { panel } = testPanel();
    const res = await panel.fetch(req("POST", "/api/v1/consume", { customer: "", feature: "x" }));
    expect(res.status).toBe(400);
    expect((await body<{ issues: Array<{ path: string }> }>(res)).issues[0]!.path).toBe("customer");
    const ttl = await panel.fetch(
      req("POST", "/api/v1/reserve", {
        customer: "c",
        feature: "api_calls",
        amount: 1,
        ttl: "soon",
      }),
    );
    expect(ttl.status).toBe(400);
  });

  test("unknown features: denied by default, 400 when the engine is strict", async () => {
    const lax = testPanel();
    expect(
      await body<CheckResult>(
        await lax.panel.fetch(req("POST", "/api/v1/check", { customer: "c", feature: "nope" })),
      ),
    ).toMatchObject({ allowed: false, reason: "unknown_feature" });
    const strict = testPanel({ engine: { catalog, strict: true } });
    expect(
      (await strict.panel.fetch(req("POST", "/api/v1/check", { customer: "c", feature: "nope" })))
        .status,
    ).toBe(400);
  });
});

describe("billing", () => {
  test("webhook intake: 404 without billing; 404 unknown provider; 400 bad signature; 200", async () => {
    const without = testPanel();
    expect(
      (await without.panel.fetch(req("POST", "/webhooks/stripe", { id: "evt_1" }))).status,
    ).toBe(404);

    const billing = fakeBilling();
    const { panel } = testPanel({ billing });
    expect((await panel.fetch(req("POST", "/webhooks/paddle", {}))).status).toBe(404);
    const bad = await panel.fetch(req("POST", "/webhooks/stripe", { id: "evt_1" }));
    expect(bad.status).toBe(400);
    expect(await body(bad)).toMatchObject({ code: "BILLING_VERIFICATION" });

    const raw = '{"id":"evt_1",  "spacing":"kept"}';
    const ok = await panel.fetch(req("POST", "/webhooks/stripe", raw, { "x-signature": "ok" }));
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ received: true, outcome: "applied" });
    expect(billing.calls.webhooks).toEqual([{ provider: "stripe", body: raw }]);
  });

  test("webhook intake needs no authentication", async () => {
    const { panel } = testPanel({
      billing: fakeBilling(),
      auth: { authenticate: async () => null },
    });
    const ok = await panel.fetch(req("POST", "/webhooks/stripe", "{}", { "x-signature": "ok" }));
    expect(ok.status).toBe(200);
  });

  test("reconcile: 404 without billing; results with billing", async () => {
    expect(
      (await testPanel().panel.fetch(req("POST", "/api/customers/org_1/reconcile"))).status,
    ).toBe(404);
    const billing = fakeBilling();
    const { panel } = testPanel({ billing });
    const res = await panel.fetch(
      req("POST", "/api/customers/org_1/reconcile", { provider: "stripe" }),
    );
    expect(await res.json()).toEqual([
      { customer: "org_1", provider: "stripe", upserted: 1, canceled: 0 },
    ]);
  });
});

describe("portal routes (admin preview)", () => {
  test("me needs ?customer= for admin principals", async () => {
    const { panel } = testPanel();
    const missing = await panel.fetch(req("GET", "/api/portal/me"));
    expect(missing.status).toBe(400);
    const me = await body<{ profile: { id: string; name?: string }; canCheckout: boolean }>(
      await panel.fetch(req("GET", "/api/portal/me?customer=org_1")),
    );
    expect(me.profile).toEqual({ id: "org_1" });
    expect(me.canCheckout).toBe(false);
  });

  test("checkout / manage link-outs go through billing (404 without it)", async () => {
    expect(
      (
        await testPanel().panel.fetch(
          req("POST", "/api/portal/checkout?customer=org_1", { plan: "pro" }),
        )
      ).status,
    ).toBe(404);
    const billing = fakeBilling();
    const { panel, ent } = testPanel({ billing });
    await ent.updateCustomer("org_1", { name: "Acme", email: "ops@acme.test" });
    const me = await body<{ profile: object; canCheckout: boolean; canManage: boolean }>(
      await panel.fetch(req("GET", "/api/portal/me?customer=org_1")),
    );
    expect(me).toMatchObject({
      profile: { id: "org_1", name: "Acme", email: "ops@acme.test" },
      canCheckout: true,
      canManage: true,
    });
    const checkout = await body<{ url: string }>(
      await panel.fetch(
        req("POST", "/api/portal/checkout?customer=org_1", { plan: "pro", quantity: 2 }),
      ),
    );
    expect(checkout.url).toBe("https://pay.example.com/org_1/pro");
    expect(billing.calls.checkout[0]).toEqual({
      customer: "org_1",
      input: { plan: "pro", quantity: 2 },
    });
    const manage = await body<{ url: string }>(
      await panel.fetch(req("POST", "/api/portal/manage?customer=org_1")),
    );
    expect(manage.url).toBe("https://billing.example.com/org_1");
  });
});

describe("errors", () => {
  test("a before-hook denial maps to its status", async () => {
    const { panel } = testPanel({
      engine: {
        catalog,
        hooks: {
          before(event) {
            if (event.type === "grant.create") {
              throw new HookDeniedError("Grants need approval", { status: 409 });
            }
          },
        },
      },
    });
    const res = await panel.fetch(
      req("POST", "/api/customers/org_1/grants", { feature: "api_calls", amount: 1 }),
    );
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "Grants need approval", code: "HOOK_DENIED" });
  });

  test("readonly panel: mutations → 423, reads and metering keep working", async () => {
    const { panel } = testPanel({ readonly: true });
    const res = await panel.fetch(
      req("POST", "/api/customers/org_1/grants", { feature: "api_calls", amount: 1 }),
    );
    expect(res.status).toBe(423);
    expect(await body(res)).toMatchObject({ code: "READONLY" });
    expect((await panel.fetch(req("GET", "/api/customers"))).status).toBe(200);
    const consumed = await panel.fetch(
      req("POST", "/api/v1/consume", { customer: "org_1", feature: "api_calls" }),
    );
    expect((await body<CheckResult>(consumed)).allowed).toBe(true);
    const config = await body<PanelConfig>(await panel.fetch(req("GET", "/config")));
    expect(config.readonly).toBe(true);
  });

  test("readonly engine: its ReadonlyError maps to 423 too", async () => {
    const { panel } = testPanel({ engine: { catalog, readonly: true }, readonly: false });
    const res = await panel.fetch(req("PATCH", "/api/customers/org_1", { name: "x" }));
    expect(res.status).toBe(423);
  });

  test("a throwing auth provider → 500 (not a misleading 401)", async () => {
    const { panel } = testPanel({
      auth: {
        authenticate: async () => {
          throw new Error("IdP down");
        },
      },
    });
    const res = await panel.fetch(req("GET", "/api/customers"));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "IdP down" });
  });

  test("mapError detects errors from other bundles by name", async () => {
    const named = (name: string, extra: Record<string, unknown> = {}) =>
      Object.assign(new Error(`${name}!`), { name }, extra);
    expect(mapError(named("NotFoundError")).status).toBe(404);
    expect(mapError(named("ReadonlyError")).status).toBe(423);
    expect(mapError(named("PortalTokenError")).status).toBe(401);
    expect(mapError(named("BillingVerificationError")).status).toBe(400);
    expect(mapError(named("HookDeniedError", { status: 402 })).status).toBe(402);
    expect(mapError(named("HookDeniedError")).status).toBe(403);
    const validation = mapError(
      named("EntitlementsValidationError", { issues: [{ path: "a", message: "b" }] }),
    );
    expect(validation.status).toBe(400);
    expect(await validation.json()).toMatchObject({ issues: [{ path: "a", message: "b" }] });
    expect(mapError(new SyntaxError("x")).status).toBe(400);
    const unknown = mapError("boom");
    expect(unknown.status).toBe(500);
    expect(await unknown.json()).toEqual({ error: "Internal error" });
  });
});

describe("createFetchHandler", () => {
  test("builds an engine from a catalog (and requires one)", async () => {
    const handler = createFetchHandler({ catalog, title: "Built" });
    const res = await handler.fetch(
      req("POST", "/api/v1/consume", { customer: "org_1", feature: "api_calls" }),
    );
    expect((await body<CheckResult>(res)).used).toBe(1);
    expect((await handler.engine.check("org_1", "api_calls")).used).toBe(1);
    await handler.engine.close();
    expect(() => createFetchHandler({})).toThrow(/catalog/);
  });

  test("passes engine options through (readonly → engine readonly)", () => {
    const handler = createFetchHandler({ catalog, readonly: true });
    expect(handler.engine.readonly).toBe(true);
  });

  test("CORS: preflight and headers on responses", async () => {
    const { panel } = testPanel({ cors: { origin: "https://app.example.com" } });
    const pre = await panel.fetch(
      new Request("http://localhost/api/portal/me", {
        method: "OPTIONS",
        headers: { origin: "https://app.example.com" },
      }),
    );
    expect(pre.status).toBe(204);
    const res = await panel.fetch(
      req("GET", "/healthcheck", undefined, { origin: "https://app.example.com" }),
    );
    expect(res.headers.get("access-control-allow-origin")).toBe("https://app.example.com");
  });

  test("sweepInterval releases expired reservations in the background", async () => {
    const t = testPanel({ sweepInterval: 10 });
    await t.ent.reserve("org_1", "api_calls", 5, { ttl: 1 });
    t.clock.advance("1s");
    await new Promise((r) => setTimeout(r, 60));
    expect((await t.ent.check("org_1", "api_calls")).used).toBe(0);
    t.panel.close();
    t.panel.close(); // idempotent
  });

  test("a failing background sweep is logged, not thrown", async () => {
    const t = testPanel({ sweepInterval: "10ms" });
    const original = t.ent.sweep;
    const warnings: unknown[] = [];
    const warn = console.warn;
    console.warn = (...args: unknown[]) => void warnings.push(args);
    t.ent.sweep = async () => {
      throw new Error("storage down");
    };
    await new Promise((r) => setTimeout(r, 40));
    console.warn = warn;
    t.ent.sweep = original;
    t.panel.close();
    expect(warnings.length).toBeGreaterThan(0);
  });
});

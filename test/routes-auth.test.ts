import { describe, expect, test } from "vitest";
import { basicAuth } from "../src/auth/basic.ts";
import type {
  AuthorizeInput,
  EntitlementsAction,
  EntitlementsResource,
} from "../src/authorization/contract.ts";
import { delegatedAuthorization } from "../src/authorization/delegated.ts";
import { rolesAuthorization } from "../src/authorization/roles.ts";
import { createPortalToken } from "../src/portal.ts";
import type { PanelConfig, PortalView } from "../src/server/routes.ts";
import {
  basic,
  bearer,
  body,
  fakeBilling,
  PORTAL_SECRET,
  req,
  testPanel,
} from "./server-helpers.ts";

const users = [
  { username: "root", password: "r", roles: ["admin"] },
  { username: "vera", password: "v", roles: ["viewer"] },
  { username: "sam", password: "s", roles: ["support"] },
  { username: "bill", password: "b", roles: ["billing-admin"] },
  { username: "svc", password: "x", roles: ["runtime-service"] },
  { username: "nobody", password: "n" },
];
const as = (name: string) => basic(name, users.find((u) => u.username === name)!.password);

const authed = (extra: Parameters<typeof testPanel>[0] = {}) =>
  testPanel({
    auth: basicAuth({ users, realm: "Billing Admin" }),
    authorization: rolesAuthorization(),
    billing: fakeBilling(),
    portal: { secret: PORTAL_SECRET },
    ...extra,
  });

describe("authentication", () => {
  test("no credentials → 401 with the provider's challenge; config stays public", async () => {
    const { panel } = authed();
    const res = await panel.fetch(req("GET", "/api/customers"));
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBe('Basic realm="Billing Admin"');

    const config = await body<PanelConfig>(await panel.fetch(req("GET", "/config")));
    expect(config).toMatchObject({ authenticated: false, principal: null, mode: "admin" });
    const signedIn = await body<PanelConfig>(
      await panel.fetch(req("GET", "/config", undefined, as("vera"))),
    );
    expect(signedIn.principal).toEqual({ id: "vera", name: "vera", roles: ["viewer"] });
  });

  test("a provider without a challenge → plain 401 JSON", async () => {
    const { panel } = testPanel({ auth: { authenticate: async () => null } });
    const res = await panel.fetch(req("GET", "/api/catalog"));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Unauthorized" });
  });

  test("public routes need no credentials", async () => {
    const { panel } = authed();
    for (const path of ["/healthcheck", "/api/pricing", "/api/openapi.json"]) {
      expect((await panel.fetch(req("GET", path))).status).toBe(200);
    }
  });

  test("the actor of a change is the principal", async () => {
    const { panel, ent } = authed();
    await panel.fetch(
      req("POST", "/api/customers/org_1/grants", { feature: "api_calls", amount: 1 }, as("sam")),
    );
    const [entry] = await ent.activity("org_1");
    expect(entry!.actor).toEqual({ id: "sam", type: "user", name: "sam" });
  });
});

describe("role presets", () => {
  const cases: Array<[string, string, string, number, unknown?]> = [
    // [user, method, path, expected status, body]
    ["vera", "GET", "/api/customers", 200],
    ["vera", "GET", "/api/catalog", 200],
    ["vera", "GET", "/api/activity", 200],
    ["vera", "GET", "/api/customers/org_1/usage/api_calls/series", 200],
    ["vera", "POST", "/api/customers/org_1/grants", 403, { feature: "api_calls", amount: 1 }],
    ["vera", "POST", "/api/v1/check", 403, { customer: "org_1", feature: "sso" }],
    ["vera", "GET", "/api/portal/me?customer=org_1", 403],
    ["sam", "POST", "/api/customers/org_1/grants", 201, { feature: "api_calls", amount: 1 }],
    ["sam", "POST", "/api/customers/org_1/overrides", 201, { feature: "sso", enabled: true }],
    ["sam", "PUT", "/api/customers/org_1/usage/seats", 200, { value: 1 }],
    ["sam", "PATCH", "/api/customers/org_1", 200, { name: "Acme" }],
    ["sam", "POST", "/api/customers/org_1/subscriptions", 403, { plan: "pro" }],
    ["sam", "DELETE", "/api/customers/org_1", 403],
    ["bill", "POST", "/api/customers/org_1/subscriptions", 201, { plan: "pro" }],
    ["bill", "POST", "/api/customers/org_1/trials", 201, { plan: "pro" }],
    ["bill", "POST", "/api/customers/org_1/reconcile", 200],
    ["bill", "POST", "/api/customers/org_1/overrides", 403, { feature: "sso", enabled: true }],
    ["svc", "POST", "/api/v1/check", 200, { customer: "org_1", feature: "sso" }],
    ["svc", "POST", "/api/v1/consume", 200, { customer: "org_1", feature: "api_calls" }],
    ["svc", "GET", "/api/v1/entitlements/org_1", 200],
    ["svc", "GET", "/api/catalog", 200],
    ["svc", "GET", "/api/customers", 403],
    ["root", "DELETE", "/api/customers/org_1", 204],
    ["root", "GET", "/api/portal/me?customer=org_1", 200],
    ["nobody", "GET", "/api/catalog", 403],
  ];

  test.each(cases)("%s %s %s → %i", async (user, method, path, status, input) => {
    const { panel, ent } = authed();
    await ent.updateCustomer("org_1", { name: "seed" });
    const res = await panel.fetch(req(method, path, input, as(user)));
    expect(res.status).toBe(status);
    if (status === 403) {
      expect(await body(res)).toMatchObject({ error: "Forbidden", action: expect.any(String) });
    }
  });

  test("roles readonly switch denies mutating actions only", async () => {
    const { panel } = authed({ authorization: rolesAuthorization({ readonly: true }) });
    expect((await panel.fetch(req("GET", "/api/customers", undefined, as("root")))).status).toBe(
      200,
    );
    expect(
      (await panel.fetch(req("PATCH", "/api/customers/org_1", { name: "x" }, as("root")))).status,
    ).toBe(403);
    expect(
      (
        await panel.fetch(
          req("POST", "/api/v1/consume", { customer: "org_1", feature: "api_calls" }, as("root")),
        )
      ).status,
    ).toBe(200);
  });
});

describe("authorization resources", () => {
  test("each route hands the provider its action and resource", async () => {
    const seen: Array<{ action: EntitlementsAction; resource: EntitlementsResource }> = [];
    const { panel, ent } = testPanel({
      authorization: delegatedAuthorization({
        authorize: ({ action, resource }: AuthorizeInput) => {
          seen.push({ action, resource });
          return true;
        },
      }),
    });
    const sub = await ent.subscribe("org_1", { plan: "pro" });
    const grant = await ent.grant("org_1", { feature: "api_calls", amount: 5 });
    const reservation = await ent.reserve("org_1", "gpt_tokens", 10);

    const calls: Array<[string, string, unknown?]> = [
      ["GET", "/api/catalog"],
      ["GET", "/api/customers"],
      ["GET", "/api/customers/org_1"],
      ["PATCH", `/api/customers/org_1/subscriptions/${sub.id}`, { quantity: 2 }],
      ["DELETE", `/api/customers/org_1/grants/${grant.id}`],
      ["PUT", "/api/customers/org_1/usage/seats", { value: 1 }],
      ["GET", "/api/activity"],
      ["POST", "/api/plans/pro/migrate", { customer: "org_1" }],
      ["POST", "/api/plans/pro/migrate"],
      ["POST", "/api/v1/consume", { customer: "org_1", feature: "api_calls" }],
      ["POST", "/api/v1/settle", { reservationId: reservation.reservation!.id, actual: 5 }],
      ["POST", "/api/v1/settle", { reservationId: "rsv_missing", actual: 5 }],
      ["GET", "/api/portal/me?customer=org_1"],
    ];
    for (const [method, path, input] of calls) await panel.fetch(req(method, path, input));

    expect(seen).toEqual([
      { action: "catalog:read", resource: { type: "catalog" } },
      { action: "customer:read", resource: { type: "customer" } },
      { action: "customer:read", resource: { type: "customer", customer: "org_1" } },
      {
        action: "subscription:write",
        resource: { type: "subscription", customer: "org_1", id: sub.id },
      },
      { action: "grant:write", resource: { type: "grant", customer: "org_1", id: grant.id } },
      { action: "usage:write", resource: { type: "usage", customer: "org_1", feature: "seats" } },
      { action: "activity:read", resource: { type: "activity" } },
      {
        action: "subscription:write",
        resource: { type: "subscription", plan: "pro", customer: "org_1" },
      },
      { action: "subscription:write", resource: { type: "subscription", plan: "pro" } },
      {
        action: "runtime:consume",
        resource: { type: "runtime", customer: "org_1", feature: "api_calls" },
      },
      {
        action: "runtime:consume",
        resource: { type: "runtime", customer: "org_1", feature: "gpt_tokens" },
      },
      { action: "runtime:consume", resource: { type: "runtime" } },
      { action: "portal:read", resource: { type: "portal", customer: "org_1" } },
    ]);
  });

  test("a denial stops the route before it runs", async () => {
    const { panel, ent } = testPanel({
      authorization: delegatedAuthorization({
        authorize: ({ resource }) => !("customer" in resource) || resource.customer !== "vip",
      }),
    });
    const res = await panel.fetch(
      req("POST", "/api/customers/vip/grants", { feature: "api_calls", amount: 1 }),
    );
    expect(res.status).toBe(403);
    expect(await ent.getCustomer("vip")).toBeNull();
  });
});

describe("portal tokens", () => {
  const token = (customer = "org_1", options: Parameters<typeof createPortalToken>[2] = {}) =>
    createPortalToken(PORTAL_SECRET, customer, options);

  test("config switches to portal mode with the token's customer and scope", async () => {
    const { panel } = authed();
    const config = await body<PanelConfig>(
      await panel.fetch(req("GET", "/config", undefined, bearer(await token()))),
    );
    expect(config).toMatchObject({
      mode: "portal",
      authenticated: true,
      customer: "org_1",
      scope: ["portal:read", "portal:checkout", "portal:manage"],
      principal: { id: "portal:org_1" },
    });
  });

  test("portal me / checkout / manage are force-scoped to the token's customer", async () => {
    const billing = fakeBilling();
    const { panel, ent } = authed({ billing });
    await ent.updateCustomer("org_1", { name: "Acme" });
    await ent.subscribe("org_1", { plan: "pro" });
    const auth = bearer(await token());

    // ?customer= is ignored for portal principals.
    const me = await body<PortalView>(
      await panel.fetch(req("GET", "/api/portal/me?customer=org_2", undefined, auth)),
    );
    expect(me.profile).toEqual({ id: "org_1", name: "Acme" });
    expect(me.customer).toBe("org_1");
    expect(me.plans[0]!.plan).toBe("pro");
    expect(me.pricing.plans.map((p) => p.key)).not.toContain("enterprise");
    expect(me).toMatchObject({ canCheckout: true, canManage: true });
    expect(me.features.export_pdf!.enabled).toBe(true);

    const checkout = await body<{ url: string }>(
      await panel.fetch(
        req("POST", "/api/portal/checkout?customer=org_2", { plan: "business" }, auth),
      ),
    );
    expect(checkout.url).toBe("https://pay.example.com/org_1/business");
    await panel.fetch(req("POST", "/api/portal/manage", { returnUrl: "https://app/x" }, auth));
    expect(billing.calls.portal).toEqual([
      { customer: "org_1", input: { returnUrl: "https://app/x" } },
    ]);
  });

  test("portal principals cannot reach admin or runtime routes", async () => {
    const { panel } = authed();
    const auth = bearer(await token());
    for (const [method, path, input] of [
      ["GET", "/api/customers"],
      ["GET", "/api/customers/org_1"],
      ["GET", "/api/catalog"],
      ["POST", "/api/customers/org_1/grants", { feature: "api_calls", amount: 1 }],
      ["POST", "/api/v1/consume", { customer: "org_1", feature: "api_calls" }],
      ["GET", "/api/v1/entitlements/org_1"],
    ] as Array<[string, string, unknown?]>) {
      const res = await panel.fetch(req(method, path, input, auth));
      expect(res.status, `${method} ${path}`).toBe(403);
    }
  });

  test("the host's authorization provider is not consulted for portal principals", async () => {
    let consulted = 0;
    const { panel } = testPanel({
      portal: { secret: PORTAL_SECRET },
      authorization: {
        authorize: async () => {
          consulted++;
          return false;
        },
      },
    });
    const res = await panel.fetch(req("GET", "/api/portal/me", undefined, bearer(await token())));
    expect(res.status).toBe(200);
    expect(consulted).toBe(0);
  });

  test("a narrowed scope hides and blocks the link-outs", async () => {
    const { panel } = authed();
    const auth = bearer(await token("org_1", { scope: ["portal:read"] }));
    const me = await body<PortalView>(
      await panel.fetch(req("GET", "/api/portal/me", undefined, auth)),
    );
    expect(me).toMatchObject({ canCheckout: false, canManage: false });
    const res = await panel.fetch(req("POST", "/api/portal/checkout", { plan: "pro" }, auth));
    expect(res.status).toBe(403);
    expect(await body(res)).toMatchObject({ action: "portal:checkout" });
  });

  test("bad, forged and expired tokens → 401 PORTAL_TOKEN (never the host's auth)", async () => {
    const { panel } = authed();
    const forged = await createPortalToken("another-secret", "org_1");
    const expired = await token("org_1", { now: Date.now() - 7_200_000 });
    for (const t of ["entpt_garbage", forged, expired]) {
      const res = await panel.fetch(req("GET", "/api/portal/me", undefined, bearer(t)));
      expect(res.status).toBe(401);
      expect(await body(res)).toMatchObject({ code: "PORTAL_TOKEN" });
    }
    expect(
      (await panel.fetch(req("GET", "/config", undefined, bearer("entpt_garbage")))).status,
    ).toBe(401);
  });

  test("without `portal` configured, entpt_ bearers go to the host's auth", async () => {
    const { panel } = testPanel();
    const res = await panel.fetch(req("GET", "/api/portal/me", undefined, bearer(await token())));
    // Anonymous admin principal → admin preview semantics → needs ?customer=.
    expect(res.status).toBe(400);
  });
});

/**
 * The end-to-end scenario every framework example's demo runs against its own
 * app — the same routes (see page.ts), so the adapters are shown to behave
 * identically: guards answer 401 / 402 / 200, a refused consume never counts,
 * operators unblock a customer with a grant, and a portal token is scoped to
 * one customer.
 */
import { call, equal, info, ok, step, type FetchHandler } from "./demo-kit.ts";

/** A decision as the guards and the runtime API return it. */
interface Decision {
  allowed: boolean;
  reason: string;
  denial?: string;
  unlockedBy: string[];
  used?: number;
  remaining?: number | null;
}

/** Run the scenario against `app` (anything answering web Requests). */
export async function runAdapterScenario(app: FetchHandler, panelPath = "/billing"): Promise<void> {
  const as = (org: string) => ({ headers: { "x-org-id": org } });

  step("The panel is mounted");
  equal((await call(app, "GET", `${panelPath}/healthcheck`)).status, 200, "healthcheck");
  const pricing = await call<{ plans: Array<{ key: string }> }>(
    app,
    "GET",
    `${panelPath}/api/pricing`,
  );
  equal(
    pricing.body.plans.map((p) => p.key),
    ["free", "pro", "business"],
    "public pricing table",
  );

  step("A plan gate: export_pdf");
  const denied = await call<Decision>(app, "POST", "/api/export", as("org_free"));
  equal(denied.status, 402, "free plan → 402 Payment Required");
  equal(denied.body.reason, "not_in_plan", "reason");
  equal(denied.body.unlockedBy, ["pro", "business"], "unlockedBy (cheapest first)");
  equal((await call(app, "POST", "/api/export", as("org_acme"))).status, 200, "pro plan → 200");
  equal((await call(app, "POST", "/api/export")).status, 401, "no customer → 401");

  step("Metering: api_calls on the free plan (1 000 / month)");
  // Operators can set usage through the admin API (here: 999 of 1 000 used).
  await call(app, "PUT", `${panelPath}/api/customers/org_free/usage/api_calls`, {
    body: { value: 999 },
  });
  const last = await call<{ remaining: number }>(app, "POST", "/api/generate", as("org_free"));
  equal([last.status, last.body.remaining], [200, 0], "the 1 000th call is allowed");
  const over = await call<Decision>(app, "POST", "/api/generate", as("org_free"));
  equal([over.status, over.body.reason], [402, "limit_reached"], "the 1 001st is refused");
  const usage = await call<{ features: Record<string, Decision> }>(
    app,
    "GET",
    `${panelPath}/api/v1/entitlements/org_free`,
  );
  equal(usage.body.features.api_calls?.used, 1_000, "a refused consume never counts");

  step("Idempotency: a retried request is metered once");
  const retry = { headers: { "x-org-id": "org_acme", "idempotency-key": "req_42" } };
  const first = await call<{ remaining: number }>(app, "POST", "/api/generate", retry);
  const again = await call<{ remaining: number }>(app, "POST", "/api/generate", retry);
  equal(again.body.remaining, first.body.remaining, "same remaining after the retry");

  step("An operator grants 500 extra calls (admin API)");
  const grant = await call(app, "POST", `${panelPath}/api/customers/org_free/grants`, {
    body: { feature: "api_calls", amount: 500, reason: "support ticket #123" },
  });
  equal(grant.status, 201, "grant created");
  const unblocked = await call<{ remaining: number }>(app, "POST", "/api/generate", as("org_free"));
  equal([unblocked.status, unblocked.body.remaining], [200, 499], "allowed again, from the grant");

  step("Customer portal: a token scoped to one customer");
  const minted = await call<{ token: string; url: string }>(
    app,
    "GET",
    "/api/portal-token",
    as("org_acme"),
  );
  ok(minted.body.token.startsWith("entpt_"), "portal token minted");
  info(`open: ${minted.body.url.slice(0, 40)}…`);
  const bearer = { headers: { authorization: `Bearer ${minted.body.token}` } };
  const me = await call<{ profile: { id: string }; plans: Array<{ plan: string }> }>(
    app,
    "GET",
    `${panelPath}/api/portal/me`,
    bearer,
  );
  equal([me.status, me.body.profile.id], [200, "org_acme"], "GET /api/portal/me");
  equal(
    me.body.plans.map((p) => p.plan),
    ["pro"],
    "the portal shows the customer's own plan",
  );
  const admin = await call(app, "GET", `${panelPath}/api/customers`, bearer);
  equal(admin.status, 403, "admin routes are out of a portal token's scope");
}

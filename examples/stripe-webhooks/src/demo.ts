/**
 * Non-interactive demo: sign realistic Stripe events locally and POST them to
 * the panel's webhook route in-process — no network, no Stripe account — then
 * watch each one land as a plan change. Also: a duplicate delivery, an
 * out-of-order (older) event, a bad signature, and a grandfathered legacy price.
 * Exits 0 when every step holds.
 *
 *   bun run demo     # or, from the repo root: bun run examples:stripe-webhooks --demo
 */
import { PRICES } from "../../shared/catalog.ts";
import { call, equal, info, runDemo, step } from "../../shared/demo-kit.ts";
import { createApp } from "./app.ts";
import { event, lifecycle, signedRequest, subscription } from "./stripe-events.ts";

const URL = "http://localhost/billing/webhooks/stripe";

runDemo("Stripe webhooks × @xtandard/entitlements", async () => {
  const { panel, ent } = createApp();
  const post = async (body: unknown, options?: { secret?: string; timestamp?: number }) => {
    const res = await panel.fetch(await signedRequest(URL, body, options));
    return { status: res.status, body: (await res.json()) as { outcome?: string; error?: string } };
  };
  /** The plan(s) and a few limits the customer has right now. */
  const snapshot = async (org: string) => {
    const e = await ent.entitlements(org);
    return {
      plans: e.plans.map((p) => `${p.plan}${p.status ? `:${p.status}` : ""}`),
      seats: e.features.seats?.limit,
      sso: e.features.sso?.enabled,
    };
  };

  const story = lifecycle("org_stripe");
  const expected = [
    { plans: ["free"], seats: 3, sso: false }, // checkout links the customer; no subscription yet
    { plans: ["pro:trialing"], seats: 10, sso: false },
    { plans: ["pro:active"], seats: 10, sso: false },
    { plans: ["business:active"], seats: 50 + 2 * 5, sso: true },
    { plans: ["free"], seats: 3, sso: false }, // canceled → back to the default plan
  ];

  step("A subscription's lifecycle, one signed event at a time");
  for (const [i, { label, event: e }] of story.entries()) {
    const res = await post(e);
    info(label);
    equal([res.status, res.body.outcome], [200, "applied"], e.type);
    equal(await snapshot("org_stripe"), expected[i]!, "entitlements");
  }
  equal(await ent.resolveLink("stripe", "cus_org_stripe"), "org_stripe", "cus_… linked to org");

  step("Stripe retries: a duplicate delivery changes nothing");
  const again = await post(story[3]!.event);
  equal(again.body.outcome, "duplicate", "same event id → duplicate");
  equal((await snapshot("org_stripe")).plans, ["free"], "still canceled");

  step("Out-of-order delivery: an older event is stale");
  const now = Math.floor(Date.now() / 1000);
  const ooo = { id: "sub_org_ooo", customer: "cus_org_ooo", org: "org_ooo", start: now } as const;
  const fresh = subscription({ ...ooo, status: "active", items: [{ price: PRICES.business }] });
  const older = subscription({ ...ooo, status: "active", items: [{ price: PRICES.pro }] });
  // Stripe orders by the event's `created`: the Business event (t+10) arrives first.
  await post(event("evt_ooo_new", "customer.subscription.updated", now + 10, fresh));
  const late = await post(event("evt_ooo_old", "customer.subscription.updated", now + 5, older));
  equal(late.body.outcome, "stale", "the late Pro event is ignored");
  equal((await snapshot("org_ooo")).plans, ["business:active"], "still on Business");

  step("Grandfathering: the legacy price lands on Pro v1");
  await post(
    event(
      "evt_legacy",
      "customer.subscription.created",
      now,
      subscription({
        id: "sub_org_old",
        customer: "cus_org_old",
        org: "org_old",
        status: "active",
        start: now,
        items: [{ price: PRICES.proLegacy }],
      }),
    ),
  );
  const legacy = await ent.entitlements("org_old");
  equal(
    [legacy.plans[0]?.plan, legacy.plans[0]?.version, legacy.features.seats?.limit],
    ["pro", 1, 5],
    "pro v1 keeps v1's 5 seats",
  );

  step("Security: a bad signature or a stale timestamp is rejected (400)");
  const forged = await post(story[1]!.event, { secret: "whsec_attacker" });
  equal(forged.status, 400, "wrong secret");
  const replayed = await post(event("evt_old_ts", "customer.subscription.updated", now, fresh), {
    timestamp: now - 3_600,
  });
  equal(replayed.status, 400, "timestamp outside the 300 s tolerance");
  const activity = await call<unknown[]>(
    panel.fetch,
    "GET",
    "/billing/api/customers/org_stripe/activity",
  );
  info(`the admin activity feed has ${activity.body.length} entries for org_stripe`);

  await ent.close();
});

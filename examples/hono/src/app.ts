/**
 * The Hono app: the entitlements panel at /billing (admin UI + customer portal
 * + HTTP API + billing webhooks), a guarded route that meters `api_calls`, a
 * plan-gated route, and a route minting portal tokens. `index.ts` serves it;
 * `demo.ts` drives it in-process through `app.fetch`.
 */
import { Hono } from "hono";
import {
  createEntitlements,
  createPortalToken,
  type EntitlementsStorage,
} from "@xtandard/entitlements";
import { entitlementsPanel, requireEntitlement } from "@xtandard/entitlements/hono";
import { createKvCounterStore } from "@xtandard/entitlements/counters/kv";
import { createMemoryStorage } from "@xtandard/entitlements/storage/memory";
import { catalog } from "../../shared/catalog.ts";
import { renderDemoPage } from "../../shared/page.ts";
import { seedDemoCustomers } from "../../shared/seed.ts";

/** Signs portal tokens. Any strong random string in production. */
export const PORTAL_SECRET = process.env.PORTAL_SECRET ?? "dev-portal-secret-change-me";

/** Build the app over `storage` (default: in memory) and seed the demo customers. */
export async function createApp(options: { storage?: EntitlementsStorage } = {}) {
  // One store for everything: customer state, and usage counted with compare-and-swap
  // on that same store (fine for one node; see postgres-redis/ for Redis counters).
  const storage = options.storage ?? createMemoryStorage();
  // One engine for the panel and your own routes: one snapshot cache, one set of hooks.
  const ent = createEntitlements({ catalog, storage, counters: createKvCounterStore(storage) });
  await seedDemoCustomers(ent);

  // Your auth goes here; the examples take the signed-in org from a header.
  const orgOf = (c: { req: { header(name: string): string | undefined } }) =>
    c.req.header("x-org-id");

  const app = new Hono();

  app.get("/", (c) => c.html(renderDemoPage({ framework: "Hono", panelPath: "/billing" })));

  // Admin UI, customer portal, JSON API (+ OpenAPI) and POST /billing/webhooks/:provider.
  app.route(
    "/billing",
    entitlementsPanel({
      entitlements: ent,
      basePath: "/billing",
      title: "Acme billing",
      portal: { secret: PORTAL_SECRET },
    }),
  );

  // Metered: each call consumes one `api_calls` atomically — a refusal never counts.
  // Denied → 402 { error, reason, unlockedBy, … } when an upgrade would help.
  app.post(
    "/api/generate",
    requireEntitlement(ent, "api_calls", {
      customer: orgOf,
      consume: true,
      idempotencyKey: (c) => c.req.header("idempotency-key"),
    }),
    (c) => c.json({ ok: true, remaining: c.var.entitlement.remaining }),
  );

  // Plan-gated (boolean): checked, not consumed.
  app.post("/api/export", requireEntitlement(ent, "export_pdf", { customer: orgOf }), (c) =>
    c.json({ ok: true, url: "/exports/report.pdf" }),
  );

  // Mint a short-lived portal token for the signed-in org (after YOUR auth).
  app.get("/api/portal-token", async (c) => {
    const org = orgOf(c);
    if (!org) return c.json({ error: "sign in first" }, 401);
    const token = await createPortalToken(PORTAL_SECRET, org, { expiresIn: "15m" });
    return c.json({ token, url: `/billing/#token=${token}` });
  });

  return { app, ent };
}

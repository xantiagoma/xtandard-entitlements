/**
 * The Elysia (1.x) app: the **typed** panel plugin at /billing (every route
 * declared, so Eden treaty infers the whole HTTP API), `beforeHandle` guards on
 * a metered and a plan-gated route, and a portal-token route. `index.ts`
 * listens; `demo.ts` drives it with `app.handle` and an Eden client.
 */
import { Elysia } from "elysia";
import {
  createEntitlements,
  createPortalToken,
  type CheckResult,
  type EntitlementsStorage,
} from "@xtandard/entitlements";
import { entitlementsElysia, requireEntitlement } from "@xtandard/entitlements/elysia";
import { createKvCounterStore } from "@xtandard/entitlements/counters/kv";
import { createMemoryStorage } from "@xtandard/entitlements/storage/memory";
import { catalog } from "../../shared/catalog.ts";
import { renderDemoPage } from "../../shared/page.ts";
import { seedDemoCustomers } from "../../shared/seed.ts";

/** Signs portal tokens. Any strong random string in production. */
export const PORTAL_SECRET = process.env.PORTAL_SECRET ?? "dev-portal-secret-change-me";

// Your auth goes here; the examples take the signed-in org from a header.
const orgOf = ({ request }: { request: Request }) => request.headers.get("x-org-id");

/** The decision the guard attached to the context. */
const decisionOf = (ctx: unknown) => (ctx as { entitlement: CheckResult }).entitlement;

/** Build the app over `storage` (default: in memory) and seed the demo customers. */
export async function createApp(options: { storage?: EntitlementsStorage } = {}) {
  // One store for everything: customer state, and usage counted with compare-and-swap
  // on that same store (fine for one node; see postgres-redis/ for Redis counters).
  const storage = options.storage ?? createMemoryStorage();
  const ent = createEntitlements({ catalog, storage, counters: createKvCounterStore(storage) });
  await seedDemoCustomers(ent);

  const app = new Elysia()
    .get(
      "/",
      () =>
        new Response(renderDemoPage({ framework: "Elysia", panelPath: "/billing" }), {
          headers: { "content-type": "text/html; charset=utf-8" },
        }),
    )
    // Typed plugin: admin UI, portal, JSON API and webhooks under /billing; the
    // engine is decorated onto the context as `entitlements`.
    .use(
      entitlementsElysia({
        prefix: "/billing",
        entitlements: ent,
        title: "Acme billing",
        portal: { secret: PORTAL_SECRET },
      }),
    )
    // Metered: consume one `api_calls` per call (402 + unlockedBy when exhausted).
    .post("/api/generate", (ctx) => ({ ok: true, remaining: decisionOf(ctx).remaining }), {
      beforeHandle: requireEntitlement(ent, "api_calls", {
        customer: orgOf,
        consume: true,
        idempotencyKey: ({ request }) => request.headers.get("idempotency-key"),
      }),
    })
    // Plan-gated (boolean): checked, not consumed.
    .post("/api/export", () => ({ ok: true, url: "/exports/report.pdf" }), {
      beforeHandle: requireEntitlement(ent, "export_pdf", { customer: orgOf }),
    })
    // Mint a short-lived portal token for the signed-in org (after YOUR auth).
    .get("/api/portal-token", async ({ request, status }) => {
      const org = orgOf({ request });
      if (!org) return status(401, { error: "sign in first" });
      const token = await createPortalToken(PORTAL_SECRET, org, { expiresIn: "15m" });
      return { token, url: `/billing/#token=${token}` };
    });

  return { app, ent };
}

/** The app's type, for an Eden treaty client: `treaty<App>("localhost:3000")`. */
export type App = Awaited<ReturnType<typeof createApp>>["app"];

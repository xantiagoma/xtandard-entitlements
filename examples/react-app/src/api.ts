/**
 * The example's server: the panel at /billing/* (admin UI, customer portal,
 * JSON API) over the shared catalog and demo customers, plus the three routes
 * the React app calls —
 *
 * - `GET  /token`         → `{ token }`: a portal token for the signed-in org
 *                           (`EntitlementsProvider` and `<CustomerPortal>` use it);
 * - `POST /api/generate`  → consumes one `api_calls` (402 + `unlockedBy` when exhausted);
 * - `POST /api/upgrade`   → `{ plan }`: switches the org's plan — the demo's stand-in for
 *                           your billing provider's checkout.
 *
 * The "signed-in org" is the `x-org-id` header, a stand-in for your own auth.
 * `routes` feeds `Bun.serve` (server.ts); `fetch` (the same routes behind one
 * function) lets demo.ts drive it in-process.
 */
import {
  createEntitlements,
  createPortalToken,
  type EntitlementsStorage,
} from "@xtandard/entitlements";
import { entitlementsPanel, requireEntitlement } from "@xtandard/entitlements/bun";
import { createKvCounterStore } from "@xtandard/entitlements/counters/kv";
import { createMemoryStorage } from "@xtandard/entitlements/storage/memory";
import { catalog } from "../../shared/catalog.ts";
import { seedDemoCustomers } from "../../shared/seed.ts";

/** Signs portal tokens. Any strong random string in production. */
export const PORTAL_SECRET = process.env.PORTAL_SECRET ?? "dev-portal-secret-change-me";

// Your auth goes here; the example takes the signed-in org from a header.
const orgOf = (req: Request) => req.headers.get("x-org-id");

/** Build the routes over `storage` (default: in memory) and seed the demo customers. */
export async function createApi(options: { storage?: EntitlementsStorage } = {}) {
  const storage = options.storage ?? createMemoryStorage();
  const ent = createEntitlements({ catalog, storage, counters: createKvCounterStore(storage) });
  await seedDemoCustomers(ent);

  const panel = entitlementsPanel({
    entitlements: ent,
    basePath: "/billing",
    title: "Acme billing",
    portal: { secret: PORTAL_SECRET },
  });

  // Metered: the server is the enforcement; the React gates only decide what to show.
  const metered = requireEntitlement(ent, "api_calls", { customer: orgOf, consume: true });

  const routes = {
    "/billing": panel.fetch,
    "/billing/*": panel.fetch,
    // Mint a short-lived portal token for the signed-in org (after YOUR auth).
    "/token": async (req: Request) => {
      const org = orgOf(req);
      if (!org) return Response.json({ error: "sign in first" }, { status: 401 });
      const token = await createPortalToken(PORTAL_SECRET, org, { expiresIn: "15m" });
      return Response.json({ token });
    },
    "/api/generate": {
      POST: metered(async (_req, decision) =>
        Response.json({ ok: true, remaining: decision.remaining }),
      ),
    },
    // Demo only: a real app sends the customer to checkout (`useEntitlements().checkout`)
    // and the billing webhook changes the plan — see examples/stripe-webhooks.
    "/api/upgrade": {
      POST: async (req: Request) => {
        const org = orgOf(req);
        if (!org) return Response.json({ error: "sign in first" }, { status: 401 });
        const { plan } = (await req.json()) as { plan?: string };
        if (!plan || !(plan in catalog.plans)) {
          return Response.json({ error: `unknown plan "${plan ?? ""}"` }, { status: 400 });
        }
        await ent.subscribe(org, { plan });
        return Response.json({ ok: true, plan });
      },
    },
  };

  /** The same routes as one fetch function (for in-process calls). */
  async function fetch(req: Request): Promise<Response> {
    const { pathname } = new URL(req.url);
    if (pathname === "/billing" || pathname.startsWith("/billing/")) return panel.fetch(req);
    const route = routes[pathname as keyof typeof routes];
    if (!route) return new Response("Not Found", { status: 404 });
    if (typeof route === "function") return route(req);
    const byMethod = route as Record<string, (r: Request) => Promise<Response>>;
    return byMethod[req.method]?.(req) ?? new Response("Method Not Allowed", { status: 405 });
  }

  return { routes, fetch, ent };
}

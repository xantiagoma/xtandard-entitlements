/**
 * The Bun app: `Bun.serve` routes with the panel at /billing/*, guarded
 * handlers (`requireEntitlement(...)(handler)` — the handler receives the
 * allowing decision) and a portal-token route. `routes` feeds `Bun.serve` in
 * `index.ts`; `fetch` (the same routes behind one function) lets `demo.ts`
 * drive it in-process.
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
import { renderDemoPage } from "../../shared/page.ts";
import { seedDemoCustomers } from "../../shared/seed.ts";

/** Signs portal tokens. Any strong random string in production. */
export const PORTAL_SECRET = process.env.PORTAL_SECRET ?? "dev-portal-secret-change-me";

// Your auth goes here; the examples take the signed-in org from a header.
const orgOf = (req: Request) => req.headers.get("x-org-id");

/** Build the routes over `storage` (default: in memory) and seed the demo customers. */
export async function createApp(options: { storage?: EntitlementsStorage } = {}) {
  // One store for everything: customer state, and usage counted with compare-and-swap
  // on that same store (fine for one node; see postgres-redis/ for Redis counters).
  const storage = options.storage ?? createMemoryStorage();
  const ent = createEntitlements({ catalog, storage, counters: createKvCounterStore(storage) });
  await seedDemoCustomers(ent);

  const panel = entitlementsPanel({
    entitlements: ent,
    basePath: "/billing",
    title: "Acme billing",
    portal: { secret: PORTAL_SECRET },
  });

  // Metered: consume one `api_calls` per call (402 + unlockedBy when exhausted).
  const metered = requireEntitlement(ent, "api_calls", {
    customer: orgOf,
    consume: true,
    idempotencyKey: (req) => req.headers.get("idempotency-key"),
  });
  // Plan-gated (boolean): checked, not consumed.
  const pdfOnly = requireEntitlement(ent, "export_pdf", { customer: orgOf });

  const routes = {
    "/": () =>
      new Response(renderDemoPage({ framework: "Bun.serve", panelPath: "/billing" }), {
        headers: { "content-type": "text/html; charset=utf-8" },
      }),
    "/billing": panel.fetch,
    "/billing/*": panel.fetch,
    "/api/generate": {
      POST: metered(async (_req, decision) =>
        Response.json({ ok: true, remaining: decision.remaining }),
      ),
    },
    "/api/export": {
      POST: pdfOnly(async () => Response.json({ ok: true, url: "/exports/report.pdf" })),
    },
    // Mint a short-lived portal token for the signed-in org (after YOUR auth).
    "/api/portal-token": async (req: Request) => {
      const org = orgOf(req);
      if (!org) return Response.json({ error: "sign in first" }, { status: 401 });
      const token = await createPortalToken(PORTAL_SECRET, org, { expiresIn: "15m" });
      return Response.json({ token, url: `/billing/#token=${token}` });
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

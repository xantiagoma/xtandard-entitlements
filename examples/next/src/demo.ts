/**
 * Non-interactive demo: no Next.js server — App Router route handlers are
 * plain `(Request, context) => Response` functions, so this script imports
 * them, routes requests to them like Next would, runs the shared scenario,
 * and calls the server action directly. Exits 0 when every step holds.
 *
 *   bun run demo     # or, from the repo root: bun run examples:next --demo
 *
 * For the real thing: `bun run dev` (next dev) and open http://localhost:3000.
 */
import { generate } from "../app/actions.ts";
import * as exportRoute from "../app/api/export/route.ts";
import * as generateRoute from "../app/api/generate/route.ts";
import * as portalTokenRoute from "../app/api/portal-token/route.ts";
import * as billingRoute from "../app/billing/[[...path]]/route.ts";
import { equal, runDemo, step } from "../../shared/demo-kit.ts";
import { runAdapterScenario } from "../../shared/scenario.ts";
import { ent } from "../lib/billing.ts";

/** What Next passes as the second argument of a route handler. */
const context = (params: Record<string, string | string[]> = {}) => ({
  params: Promise.resolve(params),
});

/** A miniature App Router: path + method → the exported handler. */
async function router(request: Request): Promise<Response> {
  const { pathname } = new URL(request.url);
  const method = request.method as "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  if (pathname === "/billing" || pathname.startsWith("/billing/")) {
    const path = pathname.split("/").slice(2).filter(Boolean);
    return billingRoute[method](request, context({ path }));
  }
  if (pathname === "/api/generate" && method === "POST") {
    return generateRoute.POST(request, context());
  }
  if (pathname === "/api/export" && method === "POST") return exportRoute.POST(request, context());
  if (pathname === "/api/portal-token" && method === "GET") return portalTokenRoute.GET(request);
  return new Response("Not Found", { status: 404 });
}

runDemo("Next.js (App Router) × @xtandard/entitlements", async () => {
  await runAdapterScenario(router);

  step("A server action meters the same feature, in-process");
  const form = new FormData();
  form.set("org", "org_globex");
  const state = await generate(null, form);
  equal([state?.allowed, state?.remaining], [true, null], "business: unlimited API calls");
  form.set("org", "org_free");
  equal((await generate(null, form))?.remaining, 498, "free: drawn from the grant");

  await ent.close();
});

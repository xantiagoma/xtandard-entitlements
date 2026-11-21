/**
 * The Express app: the panel at /billing (mounted **before** `express.json()`
 * — billing webhook signatures are computed over the raw body), guards on a
 * metered and a plan-gated route, and a portal-token route. `index.ts`
 * listens; `demo.ts` listens on a free port and drives it over HTTP.
 */
import express, { type Request } from "express";
import {
  createEntitlements,
  createPortalToken,
  type EntitlementsStorage,
} from "@xtandard/entitlements";
import {
  entitlementsPanel,
  requireEntitlement,
  type EntitlementRequest,
} from "@xtandard/entitlements/express";
import { createKvCounterStore } from "@xtandard/entitlements/counters/kv";
import { createMemoryStorage } from "@xtandard/entitlements/storage/memory";
import { catalog } from "../../shared/catalog.ts";
import { renderDemoPage } from "../../shared/page.ts";
import { seedDemoCustomers } from "../../shared/seed.ts";

/** Signs portal tokens. Any strong random string in production. */
export const PORTAL_SECRET = process.env.PORTAL_SECRET ?? "dev-portal-secret-change-me";

// Your auth goes here; the examples take the signed-in org from a header.
const orgOf = (req: Request) => req.get("x-org-id");

/** Build the app over `storage` (default: in memory) and seed the demo customers. */
export async function createApp(options: { storage?: EntitlementsStorage } = {}) {
  // One store for everything: customer state, and usage counted with compare-and-swap
  // on that same store (fine for one node; see postgres-redis/ for Redis counters).
  const storage = options.storage ?? createMemoryStorage();
  const ent = createEntitlements({ catalog, storage, counters: createKvCounterStore(storage) });
  await seedDemoCustomers(ent);

  const app = express();

  // 1. The panel first: it reads the raw request body itself.
  app.use(
    "/billing",
    entitlementsPanel({
      entitlements: ent,
      basePath: "/billing",
      title: "Acme billing",
      portal: { secret: PORTAL_SECRET },
    }),
  );
  // 2. Then your body parser and routes.
  app.use(express.json());

  app.get("/", (_req, res) => {
    res.type("html").send(renderDemoPage({ framework: "Express", panelPath: "/billing" }));
  });

  // Metered: consume one `api_calls` per call (402 + unlockedBy when exhausted).
  app.post(
    "/api/generate",
    requireEntitlement(ent, "api_calls", {
      customer: orgOf,
      consume: true,
      idempotencyKey: (req) => req.get("idempotency-key"),
    }),
    (req, res) => {
      res.json({ ok: true, remaining: (req as EntitlementRequest).entitlement?.remaining });
    },
  );

  // Plan-gated (boolean): checked, not consumed.
  app.post(
    "/api/export",
    requireEntitlement(ent, "export_pdf", { customer: orgOf }),
    (_req, res) => {
      res.json({ ok: true, url: "/exports/report.pdf" });
    },
  );

  // Mint a short-lived portal token for the signed-in org (after YOUR auth).
  app.get("/api/portal-token", async (req, res) => {
    const org = orgOf(req);
    if (!org) {
      res.status(401).json({ error: "sign in first" });
      return;
    }
    const token = await createPortalToken(PORTAL_SECRET, org, { expiresIn: "15m" });
    res.json({ token, url: `/billing/#token=${token}` });
  });

  return { app, ent };
}

/**
 * One panel (and so one engine) per process. Next.js re-evaluates modules on
 * every hot reload in dev, so the instance is kept on `globalThis` — never
 * build the panel per request.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { createEntitlements } from "@xtandard/entitlements";
import { entitlementsPanel } from "@xtandard/entitlements/next";
import { createMemoryStorage } from "@xtandard/entitlements/storage/memory";
import { catalog } from "../../shared/catalog.ts";
import { seedDemoCustomers } from "../../shared/seed.ts";

/** Signs portal tokens. Any strong random string in production. */
export const PORTAL_SECRET = process.env.PORTAL_SECRET ?? "dev-portal-secret-change-me";

// Bundlers rewrite `import.meta.url`, so tell the panel where the built admin UI is:
// the repo's dist/ui in this checkout, the installed package's once copied out.
const uiDir = [
  join(process.cwd(), "../../dist/ui"),
  join(process.cwd(), "node_modules/@xtandard/entitlements/dist/ui"),
].find((dir) => existsSync(dir));

function createBilling() {
  // Memory storage keeps the example self-contained; use postgres / redis / … in production.
  const engine = createEntitlements({ catalog, storage: createMemoryStorage() });
  const panel = entitlementsPanel({
    entitlements: engine,
    basePath: "/billing", // = the catch-all route's mount: app/billing/[[...path]]
    title: "Acme billing",
    portal: { secret: PORTAL_SECRET },
    ...(uiDir ? { uiDir } : {}),
  });
  return { panel, engine, ready: seedDemoCustomers(engine) };
}

const g = globalThis as { __acmeBilling?: ReturnType<typeof createBilling> };
const instance = (g.__acmeBilling ??= createBilling());

/** The panel: admin UI, customer portal, HTTP API and billing webhooks. */
export const billing = instance.panel;
/** The engine — `check` / `consume` from your own routes and server actions. */
export const ent = instance.engine;
/** Resolves once the demo customers are seeded. */
export const ready = instance.ready;

/** The signed-in org. Your auth goes here; the example reads the `x-org-id` header. */
export async function orgOf(request: Request): Promise<string | null> {
  await ready;
  return request.headers.get("x-org-id");
}

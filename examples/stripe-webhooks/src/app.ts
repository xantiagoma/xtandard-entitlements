/**
 * The panel with Stripe billing: `createBilling(engine, { providers: [stripe] })`
 * is passed to the panel, which then answers `POST /billing/webhooks/stripe`
 * (signature-verified, idempotent, order-safe), the admin "Reconcile" button and
 * the portal's checkout / manage link-outs. `index.ts` serves it; `demo.ts`
 * posts signed events to it in-process.
 */
import { createEntitlements, type EntitlementsStorage } from "@xtandard/entitlements";
import { createBilling } from "@xtandard/entitlements/billing";
import { createStripeProvider } from "@xtandard/entitlements/billing/stripe";
import { entitlementsPanel } from "@xtandard/entitlements/bun";
import { createMemoryStorage } from "@xtandard/entitlements/storage/memory";
import { catalog } from "../../shared/catalog.ts";
import { WEBHOOK_SECRET } from "./stripe-events.ts";

/** Build the panel over `storage` (default: in memory). */
export function createApp(options: { storage?: EntitlementsStorage } = {}) {
  const ent = createEntitlements({ catalog, storage: options.storage ?? createMemoryStorage() });

  const billing = createBilling(ent, {
    providers: [
      createStripeProvider({
        // Only webhooks are exercised here; the secret key enables reconcile + link-outs.
        ...(process.env.STRIPE_SECRET_KEY ? { secretKey: process.env.STRIPE_SECRET_KEY } : {}),
        webhookSecret: WEBHOOK_SECRET,
      }),
    ],
    // Prices the catalog does not map are reported here (default: a warning).
    onUnmapped: (e) => console.warn(`   ! unmapped: ${e.reason}`),
  });

  const panel = entitlementsPanel({
    entitlements: ent,
    billing,
    basePath: "/billing",
    title: "Acme billing (Stripe)",
  });
  return { panel, ent, billing };
}

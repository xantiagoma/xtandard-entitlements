/**
 * Stripe webhooks × @xtandard/entitlements — serve the panel with Stripe billing.
 *
 *   bun run start                       # honors PORT; defaults to 3000
 *   bun run send http://localhost:3000  # in another terminal: replay a signed lifecycle
 *
 * Then open /billing → Customers → org_stripe: the plan follows the events.
 * With the Stripe CLI instead: `stripe listen --forward-to localhost:3000/billing/webhooks/stripe`
 * and set STRIPE_WEBHOOK_SECRET to the `whsec_…` it prints.
 */
import { createFileStorage } from "@xtandard/entitlements/storage/file";
import { createApp } from "./app.ts";

const { panel } = createApp({ storage: createFileStorage({ dir: "./.entitlements" }) });

const server = Bun.serve({
  port: Number(process.env.PORT) || 3000,
  routes: { "/billing": panel.fetch, "/billing/*": panel.fetch },
  fetch: () => new Response(null, { status: 302, headers: { location: "/billing/" } }),
});
console.log(
  `Panel on ${server.url}billing — webhooks at POST ${server.url}billing/webhooks/stripe`,
);

/**
 * Replay a signed Stripe lifecycle against a running panel (see index.ts).
 *
 *   bun run send [baseUrl] [org]     # defaults: http://localhost:3000 org_stripe
 *
 * Pauses a second between events so you can watch the customer change in the UI.
 */
import { lifecycle, signedRequest } from "./stripe-events.ts";

const base = (process.argv[2] ?? `http://localhost:${process.env.PORT ?? 3000}`).replace(/\/$/, "");
const org = process.argv[3] ?? "org_stripe";

for (const { label, event } of lifecycle(org)) {
  const res = await fetch(await signedRequest(`${base}/billing/webhooks/stripe`, event));
  console.log(`${res.status} ${label} → ${JSON.stringify(await res.json())}`);
  await Bun.sleep(1_000);
}
console.log(`\nOpen ${base}/billing and look at customer ${org}.`);

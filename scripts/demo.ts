/**
 * One-command demo: the real panel over an in-memory engine seeded with the
 * demo dataset (scripts/seed-demo.ts — ~30 customers, trials, past-due,
 * grants, overrides, 30 days of usage) and a fake billing provider, so the
 * admin, the customer portal and the React embeds all have data.
 *
 *   bun run build            # once: the UI bundle + embeds
 *   bun run demo             # → http://localhost:7789
 *   PORT=3000 bun run demo
 *
 * Nothing is persisted. Ctrl-C stops it.
 *
 * @module
 */

process.env.PORT ??= "7789";
process.env.TITLE ??= "Acme Billing";

const base = `http://localhost:${process.env.PORT}`;
await import("../e2e/server.ts");

const res = await fetch(`${base}/e2e/portal-token?customer=alpine-ski`);
const { token } = (await res.json()) as { token: string };
console.log(`
  Admin            ${base}/
  Customer portal  ${base}/#token=${token}
  Portal preview   ${base}/portal?customer=fabrikam
  React embeds     ${base}/e2e/embed?view=dashboard · ?view=portal · ?view=gates
`);

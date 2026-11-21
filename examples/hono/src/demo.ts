/**
 * Non-interactive demo: build the Hono app in memory and drive it through
 * `app.fetch` — no port, no network. Exits 0 when every step holds.
 *
 *   bun run demo     # or, from the repo root: bun run examples:hono --demo
 */
import { runDemo } from "../../shared/demo-kit.ts";
import { runAdapterScenario } from "../../shared/scenario.ts";
import { createApp } from "./app.ts";

runDemo("Hono × @xtandard/entitlements", async () => {
  const { app, ent } = await createApp();
  await runAdapterScenario(app.fetch);
  await ent.close();
});

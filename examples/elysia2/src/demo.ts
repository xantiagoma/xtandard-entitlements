/**
 * Non-interactive demo: build the Elysia 2 app in memory, run the shared
 * scenario through `app.handle`, then call the panel's API with a typed Eden
 * treaty client — no port, no network. Exits 0 when every step holds.
 *
 *   bun run demo     # or, from the repo root: bun run examples:elysia2 --demo
 */
import { treaty } from "@elysia/eden";
import type { CheckResult } from "@xtandard/entitlements";
import { equal, runDemo, step } from "../../shared/demo-kit.ts";
import { runAdapterScenario } from "../../shared/scenario.ts";
import { createApp } from "./app.ts";

runDemo("Elysia 2 × @xtandard/entitlements", async () => {
  const { app, ent } = await createApp();
  await runAdapterScenario((request) => app.handle(request));

  step("Eden treaty: the panel's routes are typed end to end");
  // Paths, params and bodies are inferred from the plugin's route declarations.
  const billing = treaty(app).billing!;
  const checked = await billing.api.v1.check.post({
    customer: "org_globex",
    feature: "sso",
  });
  // Handlers delegate to the panel's web Response, so `data` is typed loosely.
  equal((checked.data as unknown as CheckResult).allowed, true, "business plan includes SSO");
  const sub = await billing.api.customers({ id: "org_free" }).subscriptions.post({ plan: "pro" });
  equal(sub.response.status, 201, "subscribe org_free to Pro through the typed client");
  equal((await ent.check("org_free", "export_pdf")).allowed, true, "export_pdf now allowed");

  await ent.close();
});

/**
 * Non-interactive demo: build the routes in memory, run the shared scenario
 * in-process, then once more through a real `Bun.serve` on a free port.
 * Exits 0 when every step holds.
 *
 *   bun run demo     # or, from the repo root: bun run examples:bun --demo
 */
import { call, equal, runDemo, step } from "../../shared/demo-kit.ts";
import { runAdapterScenario } from "../../shared/scenario.ts";
import { createApp } from "./app.ts";

runDemo("Bun.serve × @xtandard/entitlements", async () => {
  const { fetch, ent } = await createApp();
  await runAdapterScenario(fetch);

  step("The same routes behind Bun.serve (port 0 = any free port)");
  const fresh = await createApp();
  const server = Bun.serve({
    port: 0,
    routes: fresh.routes,
    fetch: () => new Response(null, { status: 404 }),
  });
  try {
    const remote = (req: Request) => {
      const url = new URL(req.url);
      return globalThis.fetch(new Request(new URL(url.pathname + url.search, server.url), req));
    };
    const res = await call<{ remaining: number }>(remote, "POST", "/api/generate", {
      headers: { "x-org-id": "org_acme" },
    });
    equal([res.status, res.body.remaining], [200, 87_999], "metered over HTTP");
    equal((await call(remote, "GET", "/billing/healthcheck")).status, 200, "panel route");
  } finally {
    await server.stop(true);
    await fresh.ent.close();
    await ent.close();
  }
});

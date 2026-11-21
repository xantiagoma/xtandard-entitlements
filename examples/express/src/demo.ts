/**
 * Non-interactive demo: start the Express app on a free port and run the
 * shared scenario over real HTTP (the adapter bridges Node req/res to fetch
 * semantics). Exits 0 when every step holds.
 *
 *   bun run demo     # or, from the repo root: bun run examples:express --demo
 */
import type { AddressInfo } from "node:net";
import { runDemo } from "../../shared/demo-kit.ts";
import { runAdapterScenario } from "../../shared/scenario.ts";
import { createApp } from "./app.ts";

runDemo("Express × @xtandard/entitlements", async () => {
  const { app, ent } = await createApp();
  const server = await new Promise<ReturnType<typeof app.listen>>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    // Same scenario as the other adapters, but over the wire.
    await runAdapterScenario((request) => {
      const url = new URL(request.url);
      return fetch(new Request(base + url.pathname + url.search, request));
    });
  } finally {
    server.close();
    await ent.close();
  }
});

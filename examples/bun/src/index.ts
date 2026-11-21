/**
 * Bun.serve × @xtandard/entitlements — serve the routes (see app.ts).
 *
 *   bun run start        # honors PORT; defaults to 3000
 *
 * - GET  /                  → demo page: pick an org, call the guarded routes, open its portal
 * - POST /api/generate      → consumes 1 `api_calls` (402 when the plan's limit is reached)
 * - POST /api/export        → requires `export_pdf` (Pro and up)
 * - GET  /api/portal-token  → mints a portal token for the `x-org-id` org
 * - GET  /billing           → admin UI · /billing/api/* JSON API · /billing/#token=… portal
 *
 * State lives in ./.entitlements (file storage) so it survives restarts.
 */
import { createFileStorage } from "@xtandard/entitlements/storage/file";
import { createApp } from "./app.ts";

const { routes } = await createApp({ storage: createFileStorage({ dir: "./.entitlements" }) });

const server = Bun.serve({
  port: Number(process.env.PORT) || 3000,
  routes,
  fetch: () => new Response("Not Found", { status: 404 }),
});
console.log(`Bun.serve listening on ${server.url} (app at /, panel at /billing)`);

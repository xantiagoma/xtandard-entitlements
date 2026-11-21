/**
 * Express × @xtandard/entitlements — serve the app (see app.ts).
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

const { app } = await createApp({ storage: createFileStorage({ dir: "./.entitlements" }) });

const port = Number(process.env.PORT) || 3000;
app.listen(port, () => {
  console.log(`Express listening on http://localhost:${port} (app at /, panel at /billing)`);
});

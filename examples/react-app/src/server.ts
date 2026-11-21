/**
 * The API half of the example on `Bun.serve` (see api.ts). `bun run start`
 * runs it next to Vite; run it alone with `bun run server` (PORT, default 3000).
 *
 * State lives in ./.entitlements (file storage) so it survives restarts.
 */
import { createFileStorage } from "@xtandard/entitlements/storage/file";
import { createApi } from "./api.ts";

const { routes } = await createApi({ storage: createFileStorage({ dir: "./.entitlements" }) });

const server = Bun.serve({
  port: Number(process.env.PORT) || 3000,
  routes,
  fetch: () => new Response("Not Found", { status: 404 }),
});
console.log(`API listening on ${server.url} (panel at /billing)`);

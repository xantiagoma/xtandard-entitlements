/**
 * One command for the whole example: the API server (server.ts) on a free
 * port, then the Vite dev server for the React pages, proxying /billing,
 * /token and /api to it (vite.config.ts reads API_URL).
 *
 *   bun run start        # → http://localhost:5190 (Vite honors PORT)
 *   # or from the repo root: bun run examples:react-app
 *
 * Ctrl-C stops both.
 */
import { getPort } from "get-port-please";

const VITE_PORT = process.env.PORT ?? "5190";
const API_PORT = await getPort({ port: 3000, portRange: [3000, 3200] });
const API_URL = `http://localhost:${API_PORT}`;

const api = Bun.spawn(["bun", "src/server.ts"], {
  env: { ...process.env, PORT: String(API_PORT) },
  stdout: "inherit",
  stderr: "inherit",
});

let vite: ReturnType<typeof Bun.spawn> | undefined;
const shutdown = () => {
  vite?.kill();
  api.kill();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

// Wait for the panel's healthcheck before starting Vite.
const started = Date.now();
while (Date.now() - started < 15_000) {
  const up = await fetch(`${API_URL}/billing/healthcheck`).then(
    (res) => res.ok,
    () => false,
  );
  if (up) break;
  await Bun.sleep(200);
}

console.log(`\n▶ React app → http://localhost:${VITE_PORT}  (API + panel on ${API_URL}/billing)\n`);
vite = Bun.spawn(["bunx", "vite", "--port", VITE_PORT, "--strictPort"], {
  env: { ...process.env, API_URL },
  stdout: "inherit",
  stderr: "inherit",
});
await vite.exited;
shutdown();

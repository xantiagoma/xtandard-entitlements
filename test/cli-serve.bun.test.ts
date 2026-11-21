/**
 * Integration test for the CLI `serve` command and the standalone app. Each
 * boots in a subprocess (the never-resolving `run(["serve"])` would hang the
 * test), then the test probes the healthcheck, basic-auth enforcement, the
 * runtime API and portal tokens. Spawned via Bun, so it runs under `bun test`.
 *
 *   bun test test/cli-serve.bun.test.ts
 */
import { afterAll, expect, test } from "bun:test";
import { createPortalToken } from "../src/portal.ts";

const SERVE_PORT = 4513;
const STANDALONE_PORT = 4514;
const BASE = `http://localhost:${SERVE_PORT}/billing`;

const serveProc = Bun.spawn(
  [
    "bun",
    "-e",
    "import('./src/cli.ts').then((m) => m.run(['serve', '--catalog', 'test/fixtures.ts']))",
  ],
  {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: String(SERVE_PORT),
      BASE_PATH: "/billing",
      AUTH_MODE: "basic",
      AUTH_USERNAME: "admin",
      AUTH_PASSWORD: "secret",
      STORAGE_DRIVER: "memory",
      PORTAL_SECRET: "portal-secret",
    },
    stdout: "pipe",
    stderr: "pipe",
  },
);

const standaloneProc = Bun.spawn(["bun", "run", "apps/standalone/src/index.ts"], {
  cwd: process.cwd(),
  env: { ...process.env, PORT: String(STANDALONE_PORT), CATALOG_PATH: "", STORAGE_DRIVER: "" },
  stdout: "pipe",
  stderr: "pipe",
});

afterAll(() => {
  serveProc.kill();
  standaloneProc.kill();
});

async function waitForServer(url: string, timeoutMs = 20_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      // not up yet
    }
    await Bun.sleep(250);
  }
  throw new Error(`${url} did not become ready in time`);
}

const admin = { authorization: `Basic ${btoa("admin:secret")}` };

test("serve boots under BASE_PATH, answers the healthcheck and enforces basic auth", async () => {
  await waitForServer(`${BASE}/healthcheck`);
  expect(await (await fetch(`${BASE}/healthcheck`)).json()).toEqual({ ok: true });
  expect((await fetch(`${BASE}/config`)).status).toBe(200);
  expect((await fetch(`${BASE}/api/pricing`)).status).toBe(200);

  expect((await fetch(`${BASE}/api/customers`)).status).toBe(401);
  const wrong = { authorization: `Basic ${btoa("admin:wrong")}` };
  expect((await fetch(`${BASE}/api/customers`, { headers: wrong })).status).toBe(401);
  expect((await fetch(`${BASE}/api/customers`, { headers: admin })).status).toBe(200);
});

test("serve meters through the runtime API and honors portal tokens", async () => {
  await waitForServer(`${BASE}/healthcheck`);
  const consumed = await fetch(`${BASE}/api/v1/consume`, {
    method: "POST",
    headers: { ...admin, "content-type": "application/json" },
    body: JSON.stringify({ customer: "org_1", feature: "api_calls", amount: 7 }),
  });
  expect(((await consumed.json()) as { used: number }).used).toBe(7);

  const token = await createPortalToken("portal-secret", "org_1");
  const me = await fetch(`${BASE}/api/portal/me`, {
    headers: { authorization: `Bearer ${token}` },
  });
  expect(me.status).toBe(200);
  const view = (await me.json()) as {
    profile: { id: string };
    features: Record<string, { used?: number }>;
  };
  expect(view.profile.id).toBe("org_1");
  expect(view.features.api_calls!.used).toBe(7);
});

test("the standalone app serves the example catalog on memory storage", async () => {
  const base = `http://localhost:${STANDALONE_PORT}`;
  await waitForServer(`${base}/healthcheck`);
  const pricing = (await (await fetch(`${base}/api/pricing`)).json()) as {
    plans: Array<{ key: string }>;
  };
  expect(pricing.plans.map((p) => p.key)).toEqual(["free", "pro", "business"]);
  const config = (await (await fetch(`${base}/config`)).json()) as { mode: string };
  expect(config.mode).toBe("admin");
});

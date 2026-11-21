/**
 * README screenshots of the real UI against the seeded demo, light and dark:
 * docs/assets/ui-{overview,catalog,customers,customer,portal,embed}-{light,dark}.png.
 *
 *   bun run build && bun run screenshots
 *
 * Boots the e2e server (panel + demo seed + fake billing) on a spare port,
 * drives Chromium with Playwright, then stops the server. `BASE_URL=…` targets
 * an already-running one instead (e.g. `bun run demo`).
 *
 * @module
 */

import { chromium, type Page } from "playwright";

const PORT = process.env.PORT ?? "3499";
const BASE = process.env.BASE_URL?.replace(/\/$/, "") ?? `http://localhost:${PORT}`;
const OUT = new URL("../docs/assets/", import.meta.url);

const server = process.env.BASE_URL
  ? null
  : Bun.spawn(["bun", new URL("../e2e/server.ts", import.meta.url).pathname], {
      env: { ...process.env, PORT },
      stdout: "ignore",
      stderr: "inherit",
    });

async function waitForServer(timeoutMs = 30_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      if ((await fetch(`${BASE}/healthcheck`)).ok) return;
    } catch {
      // not up yet
    }
    await Bun.sleep(200);
  }
  throw new Error(`e2e server did not start on ${BASE}`);
}

const token = async (customer: string) =>
  (
    (await (await fetch(`${BASE}/e2e/portal-token?customer=${customer}`)).json()) as {
      token: string;
    }
  ).token;

interface Shot {
  name: string;
  /** Path, or a function of the theme (the embed host takes the theme in its URL). */
  path: (theme: "light" | "dark") => Promise<string> | string;
  /** Wait for this text before capturing. */
  ready: string;
  fullPage?: boolean;
}

const SHOTS: Shot[] = [
  { name: "overview", path: () => "/", ready: "Recent activity" },
  { name: "catalog", path: () => "/catalog", ready: "Pricing preview", fullPage: true },
  { name: "customers", path: () => "/customers", ready: "Adventure Works" },
  { name: "customer", path: () => "/customers/fabrikam", ready: "Daily usage", fullPage: true },
  {
    name: "portal",
    path: async () => `/#token=${await token("alpine-ski")}`,
    ready: "Compare plans",
    fullPage: true,
  },
  {
    name: "embed",
    path: (theme) =>
      `/e2e/embed?view=gates&customer=coho-winery${theme === "dark" ? "&host=class" : ""}`,
    ready: "Upgrade to Pro to use PDF export.",
    fullPage: true,
  },
];

async function capture(page: Page, shot: Shot, theme: "light" | "dark"): Promise<void> {
  await page.goto(BASE + (await shot.path(theme)));
  await page.getByText(shot.ready).first().waitFor();
  // Let charts measure, meters animate and fonts settle.
  await page.waitForTimeout(900);
  const file = new URL(`ui-${shot.name}-${theme}.png`, OUT);
  await page.screenshot({ path: file.pathname, fullPage: shot.fullPage ?? false });
  console.log(`  ${file.pathname.split("/docs/")[1]}`);
}

try {
  await waitForServer();
  const browser = await chromium.launch();
  for (const theme of ["light", "dark"] as const) {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 860 },
      deviceScaleFactor: 2,
      colorScheme: theme,
    });
    const page = await context.newPage();
    for (const shot of SHOTS) await capture(page, shot, theme);
    await context.close();
  }
  await browser.close();
} finally {
  server?.kill();
}

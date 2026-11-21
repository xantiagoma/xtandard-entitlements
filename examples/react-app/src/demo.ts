/**
 * Non-interactive demo: the server in-process, the React workspace rendered
 * with react-dom/server from the data the provider would load, and both pages
 * built with Vite. Exits 0 when every step holds.
 *
 *   bun run demo     # or, from the repo root: bun run examples:react-app --demo
 */
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import React from "react";
import { renderToString } from "react-dom/server";
import type { EntitlementsData } from "@xtandard/entitlements/react";
import { call, equal, info, ok, runDemo, step } from "../../shared/demo-kit.ts";
import { createApi } from "./api.ts";
import { Workspace } from "./app.tsx";
import { EntitlementsProvider } from "./entitlements.ts";

const ORG = "org_free";

runDemo("React app × @xtandard/entitlements", async () => {
  const { fetch, ent } = await createApi();
  const as = (org: string) => ({ headers: { "x-org-id": org } });

  /** What `<EntitlementsProvider baseUrl="/billing" token>` loads: GET /billing/api/portal/me. */
  const load = async (token: string) => {
    const res = await call<EntitlementsData>(fetch, "GET", "/billing/api/portal/me", {
      headers: { authorization: `Bearer ${token}` },
    });
    equal(res.status, 200, "GET /billing/api/portal/me with the token");
    return res.body;
  };
  /** The workspace's markup once that data has loaded (React's text separators dropped). */
  const render = (data: EntitlementsData) =>
    renderToString(
      React.createElement(EntitlementsProvider, { initial: data }, [
        React.createElement(Workspace, { key: "w", org: ORG }),
      ]),
    ).replaceAll("<!-- -->", "");

  try {
    step("The server mints a portal token for the signed-in org");
    equal((await call(fetch, "GET", "/token")).status, 401, "no session → 401");
    const minted = await call<{ token: string }>(fetch, "GET", "/token", as(ORG));
    equal(minted.status, 200, "GET /token as org_free");
    ok(minted.body.token.startsWith("entpt_"), "a portal token (entpt_…)");
    const { token } = minted.body;
    const scoped = await call(fetch, "GET", "/billing/api/customers", {
      headers: { authorization: `Bearer ${token}` },
    });
    equal(scoped.status, 403, "the token cannot reach admin routes");

    step("Free plan: meters, an open metered gate, a closed plan gate with an upgrade prompt");
    let html = render(await load(token));
    ok(html.includes("Hello, Freebird Labs"), "useCustomer() → the customer's name");
    ok(
      html.includes(
        'aria-label="API calls" aria-valuemin="0" aria-valuemax="1000" aria-valuenow="250"',
      ),
      "api_calls meter: 250 / 1000",
    );
    ok(html.includes(">Generate</button>"), "<Gate feature=api_calls> renders the action");
    ok(html.includes("Upgrade to Pro to use PDF export."), "<UpgradePrompt feature=export_pdf>");
    ok(html.includes("Uploads up to 10 MB"), "useEntitlement(max_upload_mb)");
    ok(/data-plan="free"[^>]*data-current="true"/.test(html), "<PricingTable> marks Free current");

    step("The server consumes; refresh() reloads what the meters show");
    const generated = await call<{ remaining: number }>(fetch, "POST", "/api/generate", as(ORG));
    equal([generated.status, generated.body.remaining], [200, 749], "POST /api/generate");
    ok(render(await load(token)).includes('aria-valuenow="251"'), "meter now at 251");

    step("At the limit the server refuses, and the gate swaps in the upgrade prompt");
    await ent.setUsage(ORG, "api_calls", 1_000);
    const refused = await call<{ unlockedBy: string[] }>(fetch, "POST", "/api/generate", as(ORG));
    equal([refused.status, refused.body.unlockedBy[0]], [402, "pro"], "402 + unlockedBy");
    html = render(await load(token));
    ok(!html.includes(">Generate</button>"), "<Gate> hides the action");
    ok(html.includes("reached your API calls limit. Upgrade to Pro for more."), "limit prompt");

    step("Upgrading (the demo's stand-in for checkout) opens the gates");
    const upgraded = await call(fetch, "POST", "/api/upgrade", {
      ...as(ORG),
      body: { plan: "pro" },
    });
    equal(upgraded.status, 200, "POST /api/upgrade { plan: pro }");
    html = render(await load(token));
    ok(html.includes(">Export PDF</button>"), "<Gate feature=export_pdf> renders the action");
    ok(html.includes('aria-valuemax="100000"'), "api_calls meter: Pro's 100 000");
    ok(html.includes("Uploads up to 500 MB"), "max_upload_mb is Pro's 500");
    equal(
      (await call(fetch, "POST", "/api/generate", as(ORG))).status,
      200,
      "the call goes through",
    );
  } finally {
    await ent.close();
  }

  step("Vite builds both pages: the gated workspace and the embedded <CustomerPortal>");
  await bundle();
});

/** Build the two pages into a temp dir and check the embed's stylesheet stays scoped. */
async function bundle(): Promise<void> {
  const { build } = await import("vite");
  const root = join(import.meta.dir, "..");
  const outDir = mkdtempSync(join(tmpdir(), "react-app-"));
  try {
    await build({ root, logLevel: "warn", build: { outDir, emptyOutDir: true } });
    ok(existsSync(join(outDir, "index.html")), "index.html (hooks + components)");
    ok(existsSync(join(outDir, "portal.html")), "portal.html (the embed)");
    const assets = readdirSync(join(outDir, "assets"));
    const css = assets
      .filter((f) => f.startsWith("portal-") && f.endsWith(".css"))
      .map((f) => readFileSync(join(outDir, "assets", f), "utf8"))
      .join("\n");
    ok(css.includes(".xtandard-entitlements"), "the portal's styles are scoped");
    // In the repo, the same leak check the package build runs on dist/react.css.
    const scoper = join(root, "../../scripts/scope-embed-css.ts");
    if (existsSync(scoper)) {
      const { findUnscopedLeaks } = (await import(scoper)) as {
        findUnscopedLeaks: (css: string) => string[];
      };
      equal(findUnscopedLeaks(css), [], "no unscoped preflight rules leak into the host");
    }
    info("assets:", assets);
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
}

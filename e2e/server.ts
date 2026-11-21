/**
 * The Playwright e2e server (also behind `bun run demo` and the screenshots):
 * the real panel (`createFetchHandler`) over an in-memory engine seeded with
 * the demo dataset (scripts/seed-demo.ts), plus a fake billing provider so the
 * portal's checkout / manage link-outs have somewhere to go. Run under Bun:
 *
 *   bun e2e/server.ts            # PORT=3411 by default
 *
 * Test-only routes (outside the panel):
 *   GET /healthcheck                         → 200 (readiness probe; the panel's own)
 *   GET /e2e/portal-token?customer=&scope=   → { token } (scope=read → view-only portal)
 *   GET /e2e/checkout?customer=&plan=        → the fake provider's checkout page
 *   GET /e2e/billing-portal?customer=        → the fake provider's billing portal page
 *   GET /e2e/embed?view=&theme=&host=        → a host page mounting the built React
 *                                              embeds / hooks (view: dashboard | portal | gates;
 *                                              host: class | attr | none)
 */

import { createFetchHandler, createPortalToken } from "../src/index.ts";
import type { EntitlementsBilling } from "../src/billing/contract.ts";
import { createDemoEngine } from "../scripts/seed-demo.ts";

const PORT = Number(process.env.PORT ?? 3411);
const PORTAL_SECRET = process.env.PORTAL_SECRET ?? "e2e-portal-secret";
const ROOT = new URL("..", import.meta.url);

const { ent } = await createDemoEngine();

/** A billing provider that links out to local fake pages and records calls. */
const billing: EntitlementsBilling = {
  providers: ["fake"],
  canCheckout: true,
  canManage: true,
  async handleWebhook() {
    return { outcome: "ignored", events: 0 };
  },
  async apply() {
    return "ignored";
  },
  async reconcile() {
    return [];
  },
  async createCheckout(customer, input) {
    const q = new URLSearchParams({ customer, plan: input.plan });
    return { url: `/e2e/checkout?${q}` };
  },
  async createPortalSession(customer) {
    return { url: `/e2e/billing-portal?${new URLSearchParams({ customer })}` };
  },
};

const { fetch: panelFetch } = createFetchHandler({
  entitlements: ent,
  title: process.env.TITLE ?? "Acme Billing",
  portal: { secret: PORTAL_SECRET },
  billing,
  uiDir: new URL("dist/ui", ROOT).pathname,
});

const html = (body: string, status = 200): Response =>
  new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8" } });

const fakePage = (title: string, detail: string) =>
  html(`<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head>
<body style="font-family:system-ui;padding:3rem"><h1>${title}</h1><p>${detail}</p></body></html>`);

// React host page. Host styles mimic a themed app (its own text/background per
// theme) so a panel that leaks or inherits the host's colors shows up.
const EMBED_HOST_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>embed host</title>
    <link rel="stylesheet" href="/e2e/react.css" />
    <link rel="stylesheet" href="/e2e/react-components.css" />
    <style>
      body { margin: 0; font-family: ui-sans-serif, system-ui, sans-serif; background: #ffffff; color: #111111; }
      html.dark body, html[data-theme="dark"] body { background: #0b0c0e; color: #f4f4f5; }
      .host-bar { display: flex; align-items: center; gap: 12px; padding: 14px 24px; border-bottom: 1px solid rgb(127 127 127 / 0.2); font-weight: 600; }
      .host-main { padding: 0; }
      .gates { max-width: 980px; margin: 0 auto; padding: 32px 24px; display: grid; gap: 24px; }
      .gates h2 { margin: 0 0 4px; font-size: 18px; }
      .gates .muted { opacity: 0.65; font-size: 14px; margin: 0 0 12px; }
      .gates .row { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 20px; }
      .gates .card { border: 1px solid rgb(127 127 127 / 0.25); border-radius: 12px; padding: 18px; }
      .gates button.cta { padding: 8px 14px; border-radius: 8px; border: 0; background: #111; color: #fff; font: inherit; }
      html.dark .gates button.cta, html[data-theme="dark"] .gates button.cta { background: #f4f4f5; color: #111; }
    </style>
  </head>
  <body>
    <div class="host-bar">Your app</div>
    <div id="host-root" class="host-main"></div>
    <script type="module" src="/e2e/embed.js"></script>
  </body>
</html>`;

let embedBundle: Promise<string> | undefined;
const buildEmbedHost = async (): Promise<string> => {
  const result = await Bun.build({
    entrypoints: [new URL("./embed-host.tsx", import.meta.url).pathname],
    target: "browser",
    define: { "process.env.NODE_ENV": '"production"' },
  });
  if (!result.success) throw new AggregateError(result.logs, "embed host bundle failed");
  return result.outputs[0]!.text();
};

const distFile = (name: string, type: string) =>
  new Response(Bun.file(new URL(`dist/${name}`, ROOT)), { headers: { "content-type": type } });

Bun.serve({
  port: PORT,
  async fetch(request) {
    const url = new URL(request.url);
    switch (url.pathname) {
      case "/e2e/portal-token": {
        const customer = url.searchParams.get("customer") ?? "fabrikam";
        const readOnly = url.searchParams.get("scope") === "read";
        const token = await createPortalToken(PORTAL_SECRET, customer, {
          expiresIn: "1h",
          ...(readOnly ? { scope: ["portal:read"] as const } : {}),
        });
        return Response.json({ token });
      }
      case "/e2e/checkout":
        return fakePage(
          "Fake checkout",
          `Checkout for ${url.searchParams.get("customer")} → plan ${url.searchParams.get("plan")}`,
        );
      case "/e2e/billing-portal":
        return fakePage("Fake billing portal", `Billing for ${url.searchParams.get("customer")}`);
      case "/e2e/embed": {
        const host = url.searchParams.get("host");
        const markup =
          host === "attr"
            ? EMBED_HOST_HTML.replace('<html lang="en">', '<html lang="en" data-theme="dark">')
            : host === "class"
              ? EMBED_HOST_HTML.replace('<html lang="en">', '<html lang="en" class="dark">')
              : EMBED_HOST_HTML;
        return html(markup);
      }
      case "/e2e/embed.js":
        embedBundle ??= buildEmbedHost();
        return new Response(await embedBundle, {
          headers: { "content-type": "text/javascript; charset=utf-8" },
        });
      case "/e2e/react.css":
        return distFile("react.css", "text/css; charset=utf-8");
      case "/e2e/react-components.css":
        return distFile("react-components.css", "text/css; charset=utf-8");
    }
    return panelFetch(request);
  },
});

console.log(`e2e server listening on http://localhost:${PORT}`);

/**
 * The demo page every server example serves at `/`: pick a customer, hit the
 * guarded routes, watch the decisions (and the 402s) come back, and open that
 * customer's portal with a freshly minted token. The "signed-in org" is the
 * `x-org-id` header — a stand-in for your own authentication.
 */
import { DEMO_CUSTOMERS } from "./seed.ts";

/** Render the page. `panelPath` is where the panel is mounted (e.g. `/billing`). */
export function renderDemoPage(options: { framework: string; panelPath: string }): string {
  const { framework, panelPath } = options;
  const orgs = DEMO_CUSTOMERS.map((id) => `<option value="${id}">${id}</option>`).join("");
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>Acme app — @xtandard/entitlements × ${framework}</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 44rem; margin: 3rem auto; padding: 0 1rem; line-height: 1.5; }
    select, button { font-size: 1rem; padding: 0.45rem 0.75rem; margin: 0.15rem 0.25rem 0.15rem 0; }
    pre { background: #f4f4f5; padding: 1rem; overflow-x: auto; min-height: 4rem; }
    code { background: #f4f4f5; padding: 0 0.25rem; }
  </style>
</head>
<body>
  <h1>Acme app <small>(${framework})</small></h1>
  <p>Signed in as <select id="org">${orgs}</select> — sent as the <code>x-org-id</code> header.</p>
  <p>
    <button data-call="POST /api/generate">Generate (consumes 1 API call)</button>
    <button data-call="POST /api/export">Export PDF (Pro+)</button>
    <button id="portal">Open my billing portal</button>
  </p>
  <pre id="out">(click a button)</pre>
  <p>Admin panel: <a href="${panelPath}/" target="_blank">${panelPath}</a> · pricing JSON:
    <a href="${panelPath}/api/pricing" target="_blank">${panelPath}/api/pricing</a></p>
  <script>
    const out = document.getElementById("out");
    const org = () => document.getElementById("org").value;
    for (const b of document.querySelectorAll("[data-call]")) {
      b.addEventListener("click", async () => {
        const [method, path] = b.dataset.call.split(" ");
        const res = await fetch(path, { method, headers: { "x-org-id": org() } });
        out.textContent = res.status + "\\n" + JSON.stringify(await res.json(), null, 2);
      });
    }
    document.getElementById("portal").addEventListener("click", async () => {
      const res = await fetch("/api/portal-token", { headers: { "x-org-id": org() } });
      const { url } = await res.json();
      window.open(url, "_blank");
    });
  </script>
</body>
</html>`;
}

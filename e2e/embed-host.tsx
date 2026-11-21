/**
 * A minimal host app for the React e2e (e2e/embed.spec.ts) and the embed
 * screenshots, bundled on demand by e2e/server.ts. Mounts the **built**
 * artifacts consumers install — `dist/react-embed.js` + the scoped
 * `dist/react.css`, and the hooks package `dist/entry-react.mjs` +
 * `dist/react-components.css` — not the sources.
 *
 * Query params: `view` = `dashboard` (default) | `portal` | `gates`; `theme` →
 * the embed's `theme` prop; `customer` → whose portal token to mint.
 *
 * @module
 */

import React from "react";
import { createRoot } from "react-dom/client";
// @ts-expect-error — built artifact (types live in dist/types-react).
import { CustomerPortal, EntitlementsDashboard } from "../dist/react-embed.js";
// @ts-expect-error — built artifact (types live in dist/entry-react.d.mts).
import * as Ent from "../dist/entry-react.mjs";
import type * as EntTypes from "../src/react/index.tsx";
import type { EmbedTheme } from "../src/react-embed.tsx";

const R = Ent as typeof EntTypes;
const params = new URLSearchParams(location.search);
const view = params.get("view") ?? "dashboard";
const theme = (params.get("theme") ?? "inherit") as EmbedTheme;
const customer = params.get("customer") ?? "fabrikam";

async function token(): Promise<string> {
  const res = await fetch(`/e2e/portal-token?customer=${encodeURIComponent(customer)}`);
  return ((await res.json()) as { token: string }).token;
}

function Gates() {
  const { useCustomer, useEntitlement } = R;
  const me = useCustomer();
  const pdf = useEntitlement("export_pdf");
  return (
    <div className="gates">
      <div>
        <h2>Hello, {me.name ?? "…"}</h2>
        <p className="muted">
          You're on <strong>{me.planName ?? "…"}</strong>
          {me.status ? ` (${me.status})` : ""}. Everything below is rendered by{" "}
          <code>@xtandard/entitlements/react</code>.
        </p>
      </div>
      <div className="row">
        <div className="card">
          <R.UsageMeter feature="api_calls" />
        </div>
        <div className="card">
          <R.UsageMeter feature="ai_credits" />
        </div>
        <div className="card">
          <R.UsageMeter feature="seats" />
        </div>
      </div>
      <div className="row">
        <div className="card">
          <h2>Reports</h2>
          <p className="muted">PDF export is {pdf.allowed ? "on" : "off"} for your plan.</p>
          <R.Gate feature="export_pdf" fallback={<R.UpgradePrompt feature="export_pdf" />}>
            <button type="button" className="cta">
              Export PDF
            </button>
          </R.Gate>
        </div>
        <div className="card">
          <h2>Single sign-on</h2>
          <p className="muted">SAML SSO for your identity provider.</p>
          <R.Gate feature="sso" fallback={<R.UpgradePrompt feature="sso" />}>
            <button type="button" className="cta">
              Configure SAML
            </button>
          </R.Gate>
        </div>
      </div>
      <R.PricingTable onSelect={(plan: string) => console.log("select", plan)} />
    </div>
  );
}

function Host() {
  const [t, setT] = React.useState<string>();
  React.useEffect(() => {
    if (view !== "dashboard") void token().then(setT);
  }, []);
  if (view === "dashboard") {
    return <EntitlementsDashboard apiBaseUrl={location.origin} routing="memory" theme={theme} />;
  }
  if (!t) return null;
  if (view === "portal") {
    return <CustomerPortal apiBaseUrl={location.origin} token={t} routing="memory" theme={theme} />;
  }
  return (
    <R.EntitlementsProvider baseUrl={location.origin} token={t}>
      <Gates />
    </R.EntitlementsProvider>
  );
}

createRoot(document.getElementById("host-root")!).render(<Host />);

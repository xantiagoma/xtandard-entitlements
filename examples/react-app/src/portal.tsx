/**
 * Page 2 (portal.html) — your billing settings page, embedding the whole
 * customer portal (`<CustomerPortal>` from `@xtandard/entitlements/react/embed`):
 * plan, usage, included features, plan comparison and billing link-outs, for
 * the token's customer only. Its stylesheet is scoped under
 * `.xtandard-entitlements`, so it leaves the host's styles alone; `theme="inherit"`
 * follows the host (here, the OS colour scheme).
 */
import React from "react";
import { createRoot } from "react-dom/client";
import { CustomerPortal } from "@xtandard/entitlements/react/embed";
import "@xtandard/entitlements/react/styles.css";
import "./styles.css";
import { HostBar, currentOrg, fetchPortalToken } from "./host.tsx";

function BillingPage({ org }: { org: string }) {
  const [token, setToken] = React.useState<string>();
  const [error, setError] = React.useState<string>();
  React.useEffect(() => {
    fetchPortalToken(org).then(setToken, (e: unknown) => setError(String(e)));
  }, [org]);
  return (
    <>
      <HostBar org={org} page="billing" />
      {error ? <p role="alert">{error}</p> : null}
      {token ? <CustomerPortal apiBaseUrl="/billing" token={token} theme="inherit" /> : null}
    </>
  );
}

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <BillingPage org={currentOrg()} />
  </React.StrictMode>,
);

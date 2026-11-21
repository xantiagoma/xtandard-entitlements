/**
 * Page 1 — your product UI, gated with `@xtandard/entitlements/react`:
 * usage meters, a metered action behind `<Gate>`, a plan-gated feature with an
 * `<UpgradePrompt>`, a value read with `useEntitlement`, and the pricing table.
 *
 * Client-side gates are UX: they decide what to *show*. The server enforces
 * (`requireEntitlement` on POST /api/generate in api.ts).
 */
import React from "react";
import { fetchPortalToken } from "./host.tsx";
import {
  EntitlementsProvider,
  Gate,
  PricingTable,
  UpgradePrompt,
  UsageMeter,
  useCustomer,
  useEntitlement,
  useEntitlements,
} from "./entitlements.ts";

/** Load `org`'s entitlements with a portal token from your server, then render the workspace. */
export function App({ org }: { org: string }) {
  // A function token is called on every load, so a refresh never uses an expired one.
  const token = React.useCallback(() => fetchPortalToken(org), [org]);
  return (
    <EntitlementsProvider key={org} baseUrl="/billing" token={token}>
      <Workspace org={org} />
    </EntitlementsProvider>
  );
}

/** POST JSON to the example server as `org`. */
function post(path: string, org: string, body?: unknown): Promise<Response> {
  return fetch(path, {
    method: "POST",
    headers: { "x-org-id": org, "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
}

/** Everything below the provider: hooks and components read the loaded data. */
export function Workspace({ org }: { org: string }) {
  const me = useCustomer();
  const { refresh, checkout } = useEntitlements();
  const upload = useEntitlement("max_upload_mb");
  const [message, setMessage] = React.useState<string>();

  // Checkout when a billing provider is wired (`canCheckout`); otherwise the demo route.
  const upgrade = async (plan: string) => {
    if (me.canCheckout && checkout) return checkout(plan);
    await post("/api/upgrade", org, { plan });
    await refresh();
  };

  const generate = async () => {
    const res = await post("/api/generate", org);
    const body = (await res.json()) as { remaining?: number | null; error?: string };
    setMessage(
      res.ok
        ? `Generated. ${body.remaining ?? "Unlimited"} API calls left.`
        : `Refused by the server (${res.status}): ${body.error ?? "not allowed"}`,
    );
    await refresh(); // the provider doesn't count locally: reload after the server consumed
  };

  if (me.loading) return <main className="workspace">Loading…</main>;
  return (
    <main className="workspace">
      <header>
        <h1>Hello, {me.name ?? org}</h1>
        <p className="muted">
          You're on <strong>{me.planName}</strong>
          {me.status ? ` (${me.status})` : ""}.
        </p>
      </header>

      <section className="row">
        <div className="card">
          <UsageMeter feature="api_calls" />
        </div>
        <div className="card">
          <UsageMeter feature="ai_credits" />
        </div>
        <div className="card">
          <UsageMeter feature="seats" />
        </div>
      </section>

      <section className="row">
        <div className="card">
          <h2>Generate</h2>
          <p className="muted">Each call consumes one API call on the server.</p>
          <Gate
            feature="api_calls"
            fallback={<UpgradePrompt feature="api_calls" onUpgrade={(p) => void upgrade(p)} />}
          >
            <button type="button" className="cta" onClick={() => void generate()}>
              Generate
            </button>
          </Gate>
          {message ? <p role="status">{message}</p> : null}
        </div>
        <div className="card">
          <h2>Reports</h2>
          <p className="muted">Uploads up to {upload.value} MB on your plan.</p>
          <Gate
            feature="export_pdf"
            fallback={<UpgradePrompt feature="export_pdf" onUpgrade={(p) => void upgrade(p)} />}
          >
            <button type="button" className="cta">
              Export PDF
            </button>
          </Gate>
        </div>
      </section>

      <PricingTable onSelect={(plan) => void upgrade(plan)} />
    </main>
  );
}

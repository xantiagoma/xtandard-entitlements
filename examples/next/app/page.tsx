import { DEMO_CUSTOMERS } from "../../shared/seed.ts";
import { ent, ready } from "../lib/billing.ts";
import { GenerateForm } from "./generate-form.tsx";

// Reads live usage on every request.
export const dynamic = "force-dynamic";

/** A server component: every demo customer's plan and API-call usage, straight from the engine. */
export default async function Home() {
  await ready;
  const rows = await Promise.all(
    DEMO_CUSTOMERS.map(async (org) => {
      const e = await ent.entitlements(org);
      const calls = e.features.api_calls;
      return { org, plan: e.plans.map((p) => `${p.plan} v${p.version}`).join(", "), calls };
    }),
  );
  return (
    <main
      style={{ fontFamily: "system-ui", maxWidth: 720, margin: "3rem auto", padding: "0 1rem" }}
    >
      <h1>Acme app (Next.js)</h1>
      <table cellPadding={6}>
        <thead>
          <tr>
            <th align="left">Org</th>
            <th align="left">Plan</th>
            <th align="left">API calls</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.org}>
              <td>{r.org}</td>
              <td>{r.plan}</td>
              <td>
                {r.calls?.used ?? 0} / {r.calls?.limit ?? "∞"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <GenerateForm orgs={DEMO_CUSTOMERS} />
      <p>
        Admin panel: <a href="/billing">/billing</a> · route handlers:{" "}
        <code>POST /api/generate</code>, <code>POST /api/export</code>,{" "}
        <code>GET /api/portal-token</code> (send <code>x-org-id</code>).
      </p>
    </main>
  );
}

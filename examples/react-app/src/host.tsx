/**
 * The host app's chrome, shared by both pages: who is signed in (`?org=`, a
 * stand-in for your session), how a page gets a portal token from the server,
 * and the top bar (org picker + links between the two pages).
 */
import React from "react";
import { DEMO_CUSTOMERS } from "../../shared/seed.ts";

/** The signed-in org: `?org=…`, default `org_free`. */
export function currentOrg(): string {
  return new URLSearchParams(location.search).get("org") ?? "org_free";
}

/** Ask your server for a portal token for `org` (it mints one after its own auth). */
export async function fetchPortalToken(org: string): Promise<string> {
  const res = await fetch("/token", { headers: { "x-org-id": org } });
  if (!res.ok) throw new Error(`GET /token → HTTP ${res.status}`);
  return ((await res.json()) as { token: string }).token;
}

/** A top bar: the org picker and links to the two pages. */
export function HostBar({ org, page }: { org: string; page: "app" | "billing" }) {
  const go = (next: string) => {
    location.search = `?org=${encodeURIComponent(next)}`;
  };
  return (
    <nav className="host-bar">
      <strong>Acme</strong>
      <a href={`/?org=${org}`} aria-current={page === "app" ? "page" : undefined}>
        Workspace
      </a>
      <a href={`/portal.html?org=${org}`} aria-current={page === "billing" ? "page" : undefined}>
        Billing
      </a>
      <label className="host-org">
        Signed in as{" "}
        <select value={org} onChange={(e) => go(e.target.value)}>
          {DEMO_CUSTOMERS.map((id) => (
            <option key={id} value={id}>
              {id}
            </option>
          ))}
        </select>
      </label>
    </nav>
  );
}

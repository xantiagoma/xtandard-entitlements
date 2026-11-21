# React app × @xtandard/entitlements

A Vite React app gated on the customer's plan, against a small `Bun.serve` API that mounts the
panel. Two pages:

- **Workspace** ([`index.html`](./index.html) → [`src/app.tsx`](./src/app.tsx)) —
  `@xtandard/entitlements/react`: `EntitlementsProvider` loads the signed-in org's entitlements
  with a portal token from the server; `<UsageMeter>` for API calls, AI credits and seats; a
  metered action and PDF export behind `<Gate>` with an `<UpgradePrompt>` fallback;
  `useEntitlement("max_upload_mb").value`; `<PricingTable>`. Typed by the catalog via
  `createEntitlementsReact<Catalog>()` ([`src/entitlements.ts`](./src/entitlements.ts)).
- **Billing** ([`portal.html`](./portal.html) → [`src/portal.tsx`](./src/portal.tsx)) — the whole
  customer portal as `<CustomerPortal>` from `@xtandard/entitlements/react/embed` (with
  `@xtandard/entitlements/react/styles.css`, scoped so it leaves the host's styles alone).

The API ([`src/api.ts`](./src/api.ts)) is the panel at `/billing/*` over the shared catalog and demo
customers, plus:

- **`GET /token`** — a 15-minute portal token for the signed-in org (the `x-org-id` header stands in
  for your auth). The provider takes it as a function, so every load gets a fresh one.
- **`POST /api/generate`** — `requireEntitlement(ent, "api_calls", { consume: true })`: the
  enforcement. The page calls it, then `refresh()`es the provider (it never counts locally).
- **`POST /api/upgrade`** — switches the plan; the demo's stand-in for checkout. With a billing
  provider wired, `useEntitlements().checkout(plan)` links out instead (the page uses it whenever
  `useCustomer().canCheckout`).

Client-side gates are UX — they decide what to show; the server decides what happens.

## Run it

```bash
bun run examples:react-app          # from the repo root → http://localhost:5190
bun run examples:react-app --demo   # non-interactive demo; exits 0
```

`bun run start` ([`src/start.ts`](./src/start.ts)) starts the API on a free port and Vite with
`/billing`, `/token` and `/api` proxied to it. Pick an org in the top bar (`?org=`). Build once at
the root (`bun run build`) to also see the admin UI at `/billing`.

In this repo, [`vite.config.ts`](./vite.config.ts) points the `@xtandard/entitlements/react*` imports
at `src/` and builds the embed's stylesheet from source; copied out, it uses the installed package
as is: copy `../shared` along, swap the dependency for the published version, `bun install`, then
`bun run start` / `bun run demo`.

## The demo

[`src/demo.ts`](./src/demo.ts) drives the API in-process and renders the workspace with
`react-dom/server` from what the provider loads (`GET /billing/api/portal/me`): a token scoped to
one customer, a free org's meters and upgrade prompt, a consumed call showing up after a reload, a
refused call (`402`) swapping the action for the limit prompt, and an upgrade opening the gates.
Then it builds both pages with Vite and checks the portal's stylesheet is scoped.

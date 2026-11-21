# Hono × @xtandard/entitlements

The panel mounted in a Hono app, a metered route, a plan-gated route and a portal-token route —
the whole integration surface in one file ([`src/app.ts`](./src/app.ts)).

## What's here

- **`GET /billing`** — `entitlementsPanel({ entitlements, basePath: "/billing", portal })`: the
  admin UI, the customer portal, the JSON API (with OpenAPI at `/billing/api/openapi.json`) and
  the billing webhook route, composed with `app.route("/billing", panel)`.
- **`POST /api/generate`** — `requireEntitlement(ent, "api_calls", { consume: true })`: one atomic
  consume per call; a refused call answers `402 { reason: "limit_reached", unlockedBy, … }` and
  never counts. Honors an `idempotency-key` header.
- **`POST /api/export`** — `requireEntitlement(ent, "export_pdf")`: a plan gate (check only).
- **`GET /api/portal-token`** — `createPortalToken(secret, org)`, returning `/billing/#token=…`.
- **`GET /`** — a page to pick a demo customer (the `x-org-id` header stands in for your auth),
  call the routes and open that customer's portal.

The catalog and the seeded demo customers are shared by every example
([`../shared/catalog.ts`](../shared/catalog.ts), [`../shared/seed.ts`](../shared/seed.ts)).

## Run it

From the repo root (runs from source, picks a free port):

```bash
bun run examples:hono          # → http://localhost:3000 (panel at /billing)
bun run examples:hono --demo   # the end-to-end demo, in-process via app.fetch; exits 0
```

The admin UI is served from the built bundle — run `bun run build` once at the root to see it (the
API works without it). Copied out of the repo: `bun install`, then `bun run start` / `bun run demo`
(and copy `../shared` along).

## The demo

[`src/demo.ts`](./src/demo.ts) builds the app in memory and runs the shared scenario
([`../shared/scenario.ts`](../shared/scenario.ts)): `402` for a free customer on a Pro feature,
`401` without a customer, the 1 001st call of a 1 000-call plan refused (and not counted), an
idempotent retry metered once, an operator grant unblocking the customer, and a portal token that
reads `/api/portal/me` but gets `403` on admin routes.

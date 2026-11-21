# Express × @xtandard/entitlements

The panel, guards and a portal-token route in an Express 5 app ([`src/app.ts`](./src/app.ts)).

## What's here

- **`app.use("/billing", entitlementsPanel({ entitlements, basePath: "/billing", portal }))`** —
  admin UI, customer portal, JSON API and billing webhooks. Mounted **before** `express.json()`:
  the adapter reads the raw body itself, and billing webhook signatures are computed over it. (If a
  parser already consumed the stream, admin routes still work; provider signatures will not.)
- **`POST /api/generate`** — `requireEntitlement(ent, "api_calls", { consume: true })`: one atomic
  consume per call, `402` with `unlockedBy` once the plan's limit is reached. The decision is on
  `req.entitlement` (and `res.locals.entitlement`).
- **`POST /api/export`** — `requireEntitlement(ent, "export_pdf")`: a plan gate.
- **`GET /api/portal-token`** — mints a portal token and returns `/billing/#token=…`.
- **`GET /`** — the demo page (pick an org; the `x-org-id` header stands in for your auth).

## Run it

```bash
bun run examples:express          # from the repo root → http://localhost:3000 (panel at /billing)
bun run examples:express --demo   # end-to-end demo over real HTTP on a free port; exits 0
```

Build once at the root (`bun run build`) to see the admin UI. Copied out: `bun install` (or
`npm i`), then `bun run start` / `bun run demo` (copy `../shared` along).

## The demo

[`src/demo.ts`](./src/demo.ts) listens on port 0 and runs the shared scenario
([`../shared/scenario.ts`](../shared/scenario.ts)) over the wire: 402 / 401 / limit reached and
not counted / idempotent retry / operator grant / a portal token scoped to one customer.

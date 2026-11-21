# Elysia × @xtandard/entitlements

The **typed** panel plugin in an Elysia 1.x app: every panel route is declared, so an Eden treaty
client gets the whole HTTP API typed end to end — plus `beforeHandle` guards on your own routes.
For Elysia 2 see [`../elysia2`](../elysia2).

## What's here ([`src/app.ts`](./src/app.ts))

- **`.use(entitlementsElysia({ prefix: "/billing", entitlements, portal }))`** — admin UI,
  customer portal, JSON API and billing webhooks (the webhook route is declared `parse: "none"`, so
  provider signatures verify over the raw body). The engine is decorated onto the context as
  `entitlements`.
- **`POST /api/generate`** — `beforeHandle: requireEntitlement(ent, "api_calls", { consume: true })`:
  one atomic consume per call, `402` with `unlockedBy` when the plan's limit is reached.
- **`POST /api/export`** — `beforeHandle: requireEntitlement(ent, "export_pdf")`: a plan gate.
- **`GET /api/portal-token`** — mints a portal token and returns `/billing/#token=…`.
- **`GET /`** — the demo page (pick an org; the `x-org-id` header stands in for your auth).

The simplest alternative to the typed plugin is the opaque mount:
`new Elysia().mount("/billing", entitlementsPanel({ entitlements, basePath: "/billing" }))`.

## Run it

```bash
bun run examples:elysia          # from the repo root → http://localhost:3000 (panel at /billing)
bun run examples:elysia --demo   # end-to-end demo via app.handle + an Eden client; exits 0
```

Build once at the root (`bun run build`) to see the admin UI. Copied out: `bun install`, then
`bun run start` / `bun run demo` (copy `../shared` along).

## The demo

[`src/demo.ts`](./src/demo.ts) runs the shared scenario ([`../shared/scenario.ts`](../shared/scenario.ts):
402 / 401 / limit reached and not counted / idempotent retry / operator grant / scoped portal
token), then calls `client.billing.api.v1.check.post(…)` and
`client.billing.api.customers({ id }).subscriptions.post(…)` through `treaty(app)`.

# Elysia 2 × @xtandard/entitlements

The **typed** panel plugin in an Elysia **2** app (`@xtandard/entitlements/elysia2`): every panel route is declared, so an Eden treaty
client gets the whole HTTP API typed end to end — plus `beforeHandle` guards on your own routes.
Elysia 2 routes take `(path, hook, handler)`; Elysia 1 is in [`../elysia`](../elysia).

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
bun run examples:elysia2          # from the repo root → http://localhost:3000 (panel at /billing)
bun run examples:elysia2 --demo   # end-to-end demo via app.handle + an Eden client (`@elysia/eden`); exits 0
```

Build once at the root (`bun run build`) to see the admin UI. Copied out: `bun install`, then
`bun run start` / `bun run demo` (copy `../shared` along).

## The demo

[`src/demo.ts`](./src/demo.ts) runs the shared scenario ([`../shared/scenario.ts`](../shared/scenario.ts):
402 / 401 / limit reached and not counted / idempotent retry / operator grant / scoped portal
token), then calls `client.billing.api.v1.check.post(…)` and
`client.billing.api.customers({ id }).subscriptions.post(…)` through `treaty(app)`.

## Elysia 2 in this repo

The repo develops on Elysia 1, with Elysia 2 installed as the `elysia-v2` alias.
[`tsconfig.json`](./tsconfig.json) maps `elysia` to it, and the runner passes that file as
`bun --tsconfig-override=tsconfig.json`, so the example **and** the adapter source both load Elysia 2
(Bun 1.3 then prints a harmless "Internal error: directory mismatch" line on exit). `bun run
typecheck:examples` checks this example against it with `tsc -p examples/elysia2/tsconfig.json`.
Copied out, delete `tsconfig.json` and `bun install` — package.json pins `elysia@2.0.0-rc.0`.

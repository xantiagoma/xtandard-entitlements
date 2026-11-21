# Bun.serve × @xtandard/entitlements

No framework: `Bun.serve` routes, the panel's web-standard `fetch`, and guards that wrap a handler
and hand it the decision ([`src/app.ts`](./src/app.ts)).

## What's here

- **`"/billing/*": panel.fetch`** — `entitlementsPanel({ entitlements, basePath: "/billing", portal })`
  is already a `(Request) => Response`: admin UI, customer portal, JSON API, billing webhooks.
- **`POST /api/generate`** — `requireEntitlement(ent, "api_calls", { consume: true })(handler)`:
  the handler gets `(request, decision)`; a refused call answers `402` with `unlockedBy` and never
  counts.
- **`POST /api/export`** — `requireEntitlement(ent, "export_pdf", …)(handler)`: a plan gate.
- **`GET /api/portal-token`** — mints a portal token and returns `/billing/#token=…`.
- **`GET /`** — the demo page (pick an org; the `x-org-id` header stands in for your auth).

## Run it

```bash
bun run examples:bun          # from the repo root → http://localhost:3000 (panel at /billing)
bun run examples:bun --demo   # end-to-end demo, in-process and then via Bun.serve; exits 0
```

Build once at the root (`bun run build`) to see the admin UI. Copied out: `bun install`, then
`bun run start` / `bun run demo` (copy `../shared` along).

## The demo

[`src/demo.ts`](./src/demo.ts) runs the shared scenario ([`../shared/scenario.ts`](../shared/scenario.ts))
against the routes in-process, then serves them with `Bun.serve({ port: 0, routes })` and meters a
call over HTTP.

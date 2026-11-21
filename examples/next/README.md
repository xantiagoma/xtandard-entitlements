# Next.js (App Router) × @xtandard/entitlements

The panel as a catch-all route, guarded route handlers, a server action and a server component
reading usage — no `next` import from the library ([`lib/billing.ts`](./lib/billing.ts)).

## What's here

- **[`lib/billing.ts`](./lib/billing.ts)** — one `entitlementsPanel({ entitlements, basePath:
"/billing", portal })` per process, kept on `globalThis` so dev hot reloads don't build a second
  engine. Pins `uiDir`: bundlers rewrite `import.meta.url`, so the panel is told where the built
  admin UI lives.
- **[`app/billing/[[...path]]/route.ts`](./app/billing/[[...path]]/route.ts)** —
  `export const { GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS } = toNextHandler(billing)`: admin UI,
  customer portal, JSON API and billing webhooks.
- **[`app/api/generate/route.ts`](./app/api/generate/route.ts)** —
  `withEntitlement(handler, { engine, feature: "api_calls", consume: true, customer })`: the
  handler receives `{ entitlement }`; denials answer `402` / `403` JSON, `401` without a customer.
- **[`app/api/export/route.ts`](./app/api/export/route.ts)** — the same guard as a plan gate.
- **[`app/api/portal-token/route.ts`](./app/api/portal-token/route.ts)** — mints a portal token.
- **[`app/actions.ts`](./app/actions.ts)** — a server action calling `ent.consume(…)` directly,
  used by a `useActionState` form; **[`app/page.tsx`](./app/page.tsx)** — a server component
  listing every demo customer's plan and usage.

The signed-in org is the `x-org-id` header (route handlers) or a form field (server action) — your
session in a real app.

## Run it

```bash
bun run examples:next          # from the repo root: installs next on first use, then next dev
bun run examples:next --demo   # calls the route handlers + server action under Bun; exits 0
```

In this repo, [`tsconfig.json`](./tsconfig.json) `paths` point the package at its source and
[`next.config.mjs`](./next.config.mjs) widens Turbopack's root to the repository, so `next dev`
needs no build of the library (only `bun run build` for the admin UI bundle). Copied out: delete
those `paths` and `turbopack.root`, copy `../shared` along, `bun install`, `bun run dev`.

## The demo

App Router route handlers are plain `(Request, context) => Response` functions, so
[`src/demo.ts`](./src/demo.ts) imports them, routes requests to them, runs the shared scenario
([`../shared/scenario.ts`](../shared/scenario.ts)) and calls the server action directly.

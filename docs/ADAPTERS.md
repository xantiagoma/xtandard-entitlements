# Adapters

One panel, six mounts, and a guard for each. Every adapter wraps `createFetchHandler` and exposes
the same extras: `.engine` (the `createEntitlements` engine — call `check` / `consume` from your own
routes), `.openapi()` (merge into your own docs) and `.close()` (stops the optional sweep timer).

All adapters take the same `EntitlementsPanelOptions`: either a prebuilt engine
(`entitlements: ent`) or the engine options themselves (`catalog`, `storage`, `counters`, `hooks`,
`cache`, `fallback`, …), plus the panel options (`basePath`, `auth`, `authorization`, `portal`,
`billing`, `readonly`, `title`, `logoUrl`, `cors`, `uiDir`, `sweepInterval`).

| Framework | Import                           | Panel                                  | Guard                                     |
| --------- | -------------------------------- | -------------------------------------- | ----------------------------------------- |
| Bun       | `@xtandard/entitlements/bun`     | `entitlementsPanel()` → `fetch`        | `requireEntitlement(…)(handler)`          |
| Hono      | `@xtandard/entitlements/hono`    | `entitlementsPanel()` → Hono sub-app   | `requireEntitlement(…)` middleware        |
| Express   | `@xtandard/entitlements/express` | `entitlementsPanel()` → `app.use`      | `requireEntitlement(…)` middleware        |
| Elysia 1  | `@xtandard/entitlements/elysia`  | `entitlementsPanel()` / typed plugin   | `requireEntitlement(…)` as `beforeHandle` |
| Elysia 2  | `@xtandard/entitlements/elysia2` | same, built against Elysia 2           | same                                      |
| Next.js   | `@xtandard/entitlements/next`    | `toNextHandler(panel)` → route exports | `withEntitlement(handler, …)`             |

## Guards (`requireEntitlement`)

Every guard takes the engine, a feature key (typed by your catalog) and:

```ts
interface RequireEntitlementOptions<Ctx> {
  customer: (ctx: Ctx) => string | null | undefined | Promise<…>; // your user / org id
  amount?: number | ((ctx: Ctx) => number | Promise<number>); // default 1
  consume?: boolean; // true → atomically consume (a refusal never counts); default: check only
  idempotencyKey?: (ctx: Ctx) => string | null | undefined; // for consume
  onDenied?: (result: CheckResult, ctx: Ctx) => Response | Promise<Response>; // custom upsell
}
```

Denials are answered from the decision (ADR 0009): **`402 Payment Required`** when an upgrade would
allow the request (`denial: "payment_required"`), **`403 Forbidden`** otherwise, and **`401`** when
`customer` resolves to nothing. The body is `{ error, ...CheckResult }` — `reason`, `unlockedBy`,
`limit`, `remaining`, `resetsAt`, … — so a client renders "Upgrade to Pro" from data. An allowed
request carries its decision to the handler (`c.var.entitlement`, `req.entitlement`,
`ctx.entitlement`, `context.entitlement`, or the handler's second argument on Bun).

The framework-agnostic core (`evaluateGuard`, `denialOf`, `denialResponse`) is exported from the
root for custom integrations.

## Bun

```ts
import { entitlementsPanel, requireEntitlement } from "@xtandard/entitlements/bun";

const billing = entitlementsPanel({ catalog, storage, counters, basePath: "/billing" });
const exportPdf = requireEntitlement(billing.engine, "export_pdf", {
  customer: (req) => req.headers.get("x-org-id"),
});

Bun.serve({
  port: 3000,
  routes: {
    "/billing/*": billing.fetch,
    "/api/export": exportPdf(async (req, decision) => Response.json({ ok: true })),
  },
});
```

## Hono

```ts
import { Hono } from "hono";
import { entitlementsPanel, requireEntitlement } from "@xtandard/entitlements/hono";

const billing = entitlementsPanel({ catalog, basePath: "/billing" });
const app = new Hono();
app.route("/billing", billing);
app.post(
  "/api/generate",
  requireEntitlement(billing.engine, "ai_credits", {
    customer: (c) => c.get("orgId"),
    amount: 10,
    consume: true,
  }),
  (c) => c.json({ remaining: c.var.entitlement.remaining }),
);
```

## Express

```ts
import express from "express";
import { entitlementsPanel, requireEntitlement } from "@xtandard/entitlements/express";

const app = express();
const billing = entitlementsPanel({ catalog, basePath: "/billing" });
app.use("/billing", billing); // BEFORE express.json()/body-parser
app.use(express.json());
app.post(
  "/api/export",
  requireEntitlement(billing.engine, "export_pdf", { customer: (req) => req.user?.orgId }),
  (req, res) => res.json({ ok: true, decision: req.entitlement }),
);
```

The panel bridges Node `req`/`res` to fetch semantics and buffers request bodies. Mount it before
any body parser: billing webhook signatures are computed over the **raw** body. If a parser already
consumed the stream the adapter re-serializes `req.body` — admin routes still work, provider
signatures will not. The guard sets `req.entitlement` and `res.locals.entitlement`.

## Elysia

```ts
import { Elysia } from "elysia";
import { entitlementsPanel } from "@xtandard/entitlements/elysia";

new Elysia().mount("/billing", entitlementsPanel({ catalog, basePath: "/billing" })).listen(3000);
```

For end-to-end typed clients (Eden), use the typed plugin — it declares every route with its params
and body schema, decorates the engine onto the context as `entitlements`, and keeps the billing
webhook route unparsed (`parse: "none"`) so signatures verify:

```ts
import { createEntitlements } from "@xtandard/entitlements";
import { entitlementsElysia, requireEntitlement } from "@xtandard/entitlements/elysia";

const engine = createEntitlements({ catalog, storage, counters });
const app = new Elysia()
  .use(entitlementsElysia({ prefix: "/billing", entitlements: engine }))
  .post("/api/export", ({ entitlements }) => entitlements.consume("org_1", "exports"), {
    beforeHandle: requireEntitlement(engine, "export_pdf", {
      customer: ({ request }) => request.headers.get("x-org-id"),
    }),
  })
  .listen(3000);
export type App = typeof app; // treaty<App>: client.billing.api.v1.consume.post({ … })
```

### Elysia 2 — `@xtandard/entitlements/elysia2`

Elysia 2 changed the route signature to `(path, hook, handler)` and the `Elysia` class generics, so
a plugin's `.d.ts` built against one major doesn't type-check (or feed Eden) on the other.
`@xtandard/entitlements/elysia2` is the same surface built and typed against Elysia 2:

| Elysia | Import from                      | Eden client      |
| ------ | -------------------------------- | ---------------- |
| 1.x    | `@xtandard/entitlements/elysia`  | `@elysiajs/eden` |
| 2.x    | `@xtandard/entitlements/elysia2` | `@elysia/eden`   |

`entitlementsPanel` (the `.mount()` handler) and the `requireEntitlement` `beforeHandle` guard are
version-agnostic; only the typed `entitlementsElysia` plugin is tied to a major.

## Next.js (App Router)

```ts
// lib/billing.ts
import { entitlementsPanel } from "@xtandard/entitlements/next";
export const billing = entitlementsPanel({ catalog, storage, counters, basePath: "/billing" });

// app/billing/[[...path]]/route.ts — admin UI, portal, HTTP API, webhooks
import { toNextHandler } from "@xtandard/entitlements/next";
import { billing } from "@/lib/billing";
export const { GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS } = toNextHandler(billing);

// app/api/export/route.ts — a guarded route handler
import { withEntitlement } from "@xtandard/entitlements/next";
export const POST = withEntitlement(
  async (request, { entitlement }) => Response.json({ remaining: entitlement.remaining }),
  {
    engine: billing.engine,
    feature: "exports",
    consume: true,
    customer: async () => (await auth())?.orgId,
  },
);
```

Route handlers run on the Node.js runtime (the panel serves static files from `dist/ui`). Keep one
engine per process — define the panel in a module and import it, don't build it per request.

Bundlers rewrite `import.meta.url` (Next's Turbopack and webpack do), so the panel cannot find its
bundled UI next to its own module there. Pass the directory explicitly:

```ts
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const pkg = dirname(createRequire(import.meta.url).resolve("@xtandard/entitlements/package.json"));
export const billing = entitlementsPanel({
  catalog,
  storage,
  counters,
  basePath: "/billing",
  uiDir: join(pkg, "dist/ui"),
});
```

(`examples/next` does this.)

## Sharing one engine

The panel and your own routes should share **one** engine (one snapshot cache, one set of hooks):
build it with `createEntitlements` and pass `entitlements: engine` to the adapter, or use the
adapter's `.engine`.

```ts
const engine = createEntitlements({ catalog, storage, counters, hooks });
app.route("/billing", entitlementsPanel({ entitlements: engine, basePath: "/billing" }));
app.post("/api/run", requireEntitlement(engine, "api_calls", { customer, consume: true }), run);
```

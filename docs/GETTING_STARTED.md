# Getting Started

From `bun add` to a gated, metered route, an admin panel, a customer portal and billing webhooks in
about ten minutes. Every snippet below is lifted from a runnable example in
[`examples/`](../examples/README.md) — run one with `bun run examples:hono --demo`.

## 1. Install

```sh
bun add @xtandard/entitlements   # or npm i / pnpm add
```

Framework adapters, storage drivers and billing providers are subpaths of the same package; their
peers (`hono`, `redis`, `pg`, …) are optional — install the ones you use.

## 2. Declare the catalog

Your pricing model, in code. `@xtandard/entitlements/catalog` has zero dependencies, so the same
file feeds your server, your React app and your public pricing page
([`examples/shared/catalog.ts`](../examples/shared/catalog.ts), trimmed):

```ts
import { defineCatalog, feature } from "@xtandard/entitlements/catalog";

/** Stripe price ids the catalog maps (the stripe-webhooks demo sends these). */
export const PRICES = {
  pro: "price_pro_monthly",
  proLegacy: "price_pro_legacy",
  business: "price_business_monthly",
  extraSeats: "price_extra_seats",
} as const;

export const catalog = defineCatalog({
  features: {
    seats: feature.capacity({ name: "Seats", unit: "seat" }),
    api_calls: feature.metered({ name: "API calls", unit: "call", reset: "month" }),
    ai_credits: feature.credits({ name: "AI credits", unit: "credit", reset: "billing_period" }),
    export_pdf: feature.boolean({ name: "PDF export" }),
    max_upload_mb: feature.value({ name: "Max upload (MB)", default: 10 }),
  },
  plans: {
    free: {
      name: "Free",
      default: true,
      price: { amount: 0, currency: "usd", interval: "month" },
      features: { seats: 3, api_calls: 1_000, ai_credits: 100 },
    },
    pro: {
      name: "Pro",
      version: 2,
      highlight: true,
      trial: { days: 14 },
      price: { amount: 2900, currency: "usd", interval: "month" },
      providers: { stripe: [PRICES.pro] },
      features: {
        seats: 10,
        api_calls: { limit: 100_000, overage: "allow" },
        ai_credits: 5_000,
        export_pdf: true,
        max_upload_mb: 500,
      },
      previous: {
        // Grandfathered: subscribers on the legacy price keep v1's limits.
        1: {
          providers: { stripe: [PRICES.proLegacy] },
          features: { seats: 5, api_calls: 50_000, ai_credits: 1_000, export_pdf: true },
        },
      },
    },
  },
  addons: {
    extra_seats: {
      name: "+5 seats",
      quantity: true,
      price: { amount: 2500, currency: "usd", interval: "month", label: "per pack" },
      providers: { stripe: [PRICES.extraSeats] },
      features: { seats: { add: 5 } },
    },
  },
});
```

`defineCatalog` validates everything up front and infers the keys: `ent.check(org, "exprot_pdf")` is
a type error. Five feature kinds, versions, add-ons and trials: [Catalog](./CATALOG.md).

## 3. Create the engine

```ts
import { createEntitlements } from "@xtandard/entitlements";
import { createKvCounterStore } from "@xtandard/entitlements/counters/kv";
import { createFileStorage } from "@xtandard/entitlements/storage/file";

// One store for everything: customer state, and usage counted with compare-and-swap
// on that same store (fine for one node; see postgres-redis/ for Redis counters).
const storage = createFileStorage({ dir: "./.entitlements" });
const ent = createEntitlements({ catalog, storage, counters: createKvCounterStore(storage) });
```

Two ports: **state storage** (customers, subscriptions, grants) and **counters** (usage). Start
with memory or a file; move to Postgres state + Redis counters without touching anything else —
[`examples/postgres-redis`](../examples/postgres-redis), [Storage](./STORAGE.md).

Customers are your own ids (a user, an org, a workspace). Everyone starts on the default plan;
subscriptions arrive from your billing provider (step 8), the admin panel, or code:

```ts
await ent.subscribe("org_acme", { plan: "pro" });
await ent.subscribe("org_acme", { plan: "extra_seats", quantity: 1 });
await ent.startTrial("org_trial", "pro");
```

## 4. Gate a route

Every adapter has a `requireEntitlement` guard. A plan gate checks; a denial answers
**`402 Payment Required`** when an upgrade would allow it (`403` otherwise, `401` without a
customer) with the decision as the body — `reason`, `unlockedBy` (cheapest plans first), `limit`,
`remaining` — so the client renders "Upgrade to Pro" from data
([`examples/hono/src/app.ts`](../examples/hono/src/app.ts)):

```ts
import { requireEntitlement } from "@xtandard/entitlements/hono";

// Plan-gated (boolean): checked, not consumed.
app.post("/api/export", requireEntitlement(ent, "export_pdf", { customer: orgOf }), (c) =>
  c.json({ ok: true, url: "/exports/report.pdf" }),
);
```

```json
// POST /api/export as a free customer → 402
{
  "error": "Not entitled to \"export_pdf\" (not_in_plan)",
  "allowed": false,
  "reason": "not_in_plan",
  "denial": "payment_required",
  "unlockedBy": ["pro", "business"]
}
```

The same guard exists for Elysia (`beforeHandle`), Express, Bun and Next.js (`withEntitlement`) —
[Adapters](./ADAPTERS.md).

## 5. Meter usage

`consume: true` turns the guard into one atomic consume per request; a refused request **never
counts**, and an `idempotency-key` makes retries safe:

```ts
// Metered: each call consumes one `api_calls` atomically — a refusal never counts.
// Denied → 402 { error, reason, unlockedBy, … } when an upgrade would help.
app.post(
  "/api/generate",
  requireEntitlement(ent, "api_calls", {
    customer: orgOf,
    consume: true,
    idempotencyKey: (c) => c.req.header("idempotency-key"),
  }),
  (c) => c.json({ ok: true, remaining: c.var.entitlement.remaining }),
);
```

Or call the engine anywhere — denials are data, not exceptions:

```ts
const decision = await ent.consume("org_acme", "api_calls", 1, { idempotencyKey: req.id });
if (!decision.allowed) return upgrade(decision); // reason, denial, unlockedBy, remaining, resetsAt
```

Work whose cost is only known afterwards (LLM tokens) reserves an upper bound and settles the
actual usage ([`examples/ai-credits`](../examples/ai-credits/src/demo.ts)):

```ts
const r = await ent.reserve(org, "gpt_tokens", maxTokens, { ttl: "5m" });
if (!r.allowed) return { refused: r };
try {
  const answer = await callModel(prompt, actualTokens);
  await ent.settle(r.reservation!.id, answer.usage.totalTokens);
  return { answer };
} catch (error) {
  await ent.cancelReservation(r.reservation!.id); // the call failed: give everything back
  throw error;
}
```

Grants, overrides, overage, thresholds and failure modes: [Metering](./METERING.md).

## 6. Mount the panel

One line per framework serves the admin UI, the customer portal, the JSON API (with OpenAPI at
`/billing/api/openapi.json`) and the billing webhook route:

```ts
import { entitlementsPanel } from "@xtandard/entitlements/hono";

// Admin UI, customer portal, JSON API (+ OpenAPI) and POST /billing/webhooks/:provider.
app.route(
  "/billing",
  entitlementsPanel({
    entitlements: ent,
    basePath: "/billing",
    title: "Acme billing",
    portal: { secret: PORTAL_SECRET },
  }),
);
```

Pass the same engine (`entitlements: ent`) you meter with: one snapshot cache, one set of hooks.
The panel is open by default — lock it down with [Auth](./AUTH.md) and
[Authorization](./AUTHORIZATION.md) before it leaves your laptop.

## 7. Give customers a portal

After your own authentication, mint a short-lived portal token and send the customer to the panel
with it; it only ever sees its own plan, usage and upgrade options:

```ts
import { createPortalToken } from "@xtandard/entitlements";

// Mint a short-lived portal token for the signed-in org (after YOUR auth).
app.get("/api/portal-token", async (c) => {
  const org = orgOf(c);
  if (!org) return c.json({ error: "sign in first" }, 401);
  const token = await createPortalToken(PORTAL_SECRET, org, { expiresIn: "15m" });
  return c.json({ token, url: `/billing/#token=${token}` });
});
```

With the token, `GET /billing/api/portal/me` answers that customer's view; admin routes answer
`403`. Scopes, revocation and embedding: [Portal](./PORTAL.md).

## 8. Sync plans from billing webhooks

Your billing provider stays the system of record for money; give the panel a billing intake and
point the provider's webhook at `POST /billing/webhooks/<provider>`
([`examples/stripe-webhooks/src/app.ts`](../examples/stripe-webhooks/src/app.ts)):

```ts
import { createBilling } from "@xtandard/entitlements/billing";
import { createStripeProvider } from "@xtandard/entitlements/billing/stripe";

const billing = createBilling(ent, {
  providers: [
    createStripeProvider({
      // Only webhooks are exercised here; the secret key enables reconcile + link-outs.
      ...(process.env.STRIPE_SECRET_KEY ? { secretKey: process.env.STRIPE_SECRET_KEY } : {}),
      webhookSecret: WEBHOOK_SECRET,
    }),
  ],
});

const panel = entitlementsPanel({
  entitlements: ent,
  billing,
  basePath: "/billing",
  title: "Acme billing (Stripe)",
});
```

The catalog's `providers` map prices to plans (and legacy prices to old plan versions). Webhooks
are signature-verified, idempotent and order-safe; a customer is resolved from
`client_reference_id` / `metadata.customerId` and linked on first sight. The example replays a
whole subscription lifecycle with locally signed events — `bun run examples:stripe-webhooks --demo`.
Polar, Paddle, Lemon Squeezy and better-auth: [Billing](./BILLING.md).

## 9. Gate your React UI

`@xtandard/entitlements/react` reads the portal API with a portal token: hooks and small components
for showing usage and hiding what a plan doesn't include
([`examples/react-app`](../examples/react-app), a Vite app — `bun run examples:react-app`).
Client-side gates are UX — the server guard from step 4 is the enforcement.

Your server mints the token after its own auth ([`src/api.ts`](../examples/react-app/src/api.ts)):

```ts
// Mint a short-lived portal token for the signed-in org (after YOUR auth).
"/token": async (req: Request) => {
  const org = orgOf(req);
  if (!org) return Response.json({ error: "sign in first" }, { status: 401 });
  const token = await createPortalToken(PORTAL_SECRET, org, { expiresIn: "15m" });
  return Response.json({ token });
},
```

The provider loads that customer's entitlements once; a function `token` is called on every load, so
a refresh never uses an expired one. Hooks and components typed by your catalog
([`src/entitlements.ts`](../examples/react-app/src/entitlements.ts)):

```ts
import { createEntitlementsReact } from "@xtandard/entitlements/react";
import type { Catalog } from "../../shared/catalog.ts";

export const {
  EntitlementsProvider,
  Gate,
  PricingTable,
  UpgradePrompt,
  UsageMeter,
  useCustomer,
  useEntitlement,
  useEntitlements,
} = createEntitlementsReact<Catalog>();
```

Then gate the UI ([`src/app.tsx`](../examples/react-app/src/app.tsx), trimmed):

```tsx
import "@xtandard/entitlements/react/components.css"; // optional default styles

export function App({ org }: { org: string }) {
  const token = React.useCallback(() => fetchPortalToken(org), [org]);
  return (
    <EntitlementsProvider key={org} baseUrl="/billing" token={token}>
      <Workspace org={org} />
    </EntitlementsProvider>
  );
}

export function Workspace({ org }: { org: string }) {
  const me = useCustomer();
  const { refresh, checkout } = useEntitlements();
  const upload = useEntitlement("max_upload_mb"); // .value: number

  // Checkout when a billing provider is wired (`canCheckout`); otherwise the demo route.
  const upgrade = async (plan: string) => {
    if (me.canCheckout && checkout) return checkout(plan);
    await post("/api/upgrade", org, { plan });
    await refresh();
  };

  const generate = async () => {
    await post("/api/generate", org); // the server consumes (and refuses with 402 at the limit)
    await refresh(); // the provider doesn't count locally: reload after the server consumed
  };

  return (
    <main>
      <UsageMeter feature="api_calls" />
      <Gate
        feature="api_calls"
        fallback={<UpgradePrompt feature="api_calls" onUpgrade={(p) => void upgrade(p)} />}
      >
        <button onClick={() => void generate()}>Generate</button>
      </Gate>
      <p>Uploads up to {upload.value} MB on your plan.</p>
      <Gate
        feature="export_pdf"
        fallback={<UpgradePrompt feature="export_pdf" onUpgrade={(p) => void upgrade(p)} />}
      >
        <button>Export PDF</button>
      </Gate>
      <PricingTable onSelect={(plan) => void upgrade(plan)} />
    </main>
  );
}
```

For a billing settings page, embed the whole customer portal instead
([`src/portal.tsx`](../examples/react-app/src/portal.tsx)) — its stylesheet is scoped under
`.xtandard-entitlements`, so it leaves your styles alone:

```tsx
import { CustomerPortal } from "@xtandard/entitlements/react/embed";
import "@xtandard/entitlements/react/styles.css";

function BillingPage({ org }: { org: string }) {
  const [token, setToken] = React.useState<string>();
  React.useEffect(() => {
    void fetchPortalToken(org).then(setToken);
  }, [org]);
  return token ? <CustomerPortal apiBaseUrl="/billing" token={token} theme="inherit" /> : null;
}
```

SSR / RSC (`initial`), every prop and the admin `<EntitlementsDashboard>`: [UI](./UI.md).

## Where to next

| Goal                                             | Where                                                                                 |
| ------------------------------------------------ | ------------------------------------------------------------------------------------- |
| Your framework                                   | [Adapters](./ADAPTERS.md) · examples for Hono, Elysia 1/2, Express, Bun, Next.js      |
| Real databases, split Postgres + Redis planes    | [Storage](./STORAGE.md) · [`examples/postgres-redis`](../examples/postgres-redis)     |
| Hooks, components and embeds in a React app      | [UI](./UI.md) · [`examples/react-app`](../examples/react-app)                         |
| Credits, reserve / settle, thresholds            | [Metering](./METERING.md) · [`examples/ai-credits`](../examples/ai-credits)           |
| Rollouts that also respect plans (OpenFeature)   | [OpenFeature](./OPENFEATURE.md) · [`examples/flags-bridge`](../examples/flags-bridge) |
| Audit trail, outbound webhooks on plan changes   | [Ecosystem](./ECOSYSTEM.md) · [Hooks](./HOOKS.md)                                     |
| Services in other languages                      | [HTTP API](./HTTP_API.md)                                                             |
| Docker / standalone server / CLI                 | [Deployment](./DEPLOYMENT.md)                                                         |
| Testing your integration (test clock, in-memory) | [Testing](./TESTING.md)                                                               |

# HTTP API

The panel's JSON API, mounted under the panel's `basePath` (e.g. `/billing`). The admin UI, the
customer portal and the React hooks/embeds use it; so can services in other languages (it is also
served as OpenAPI 3.1 at `{basePath}/api/openapi.json`). Every route goes through authentication,
then authorization with the action/resource listed (see [Authorization](./AUTHORIZATION.md));
portal-token principals are force-scoped to their customer and to the portal actions (see
[Portal](./PORTAL.md)).

Errors are JSON `{ "error": string, ...extra }`: `400` bad JSON / input
(`EntitlementsValidationError`, `{ issues }` for schema errors), `401` unauthenticated or bad portal
token, `403` denied (authorization, portal scope, `HookDeniedError` with its status), `404`
(`NotFoundError`), `409` conflict, `423` readonly (`ReadonlyError`). **Denials are not errors**: the
runtime routes answer `200` with a `CheckResult` whose `allowed` is `false`.

Types are the ones exported from `@xtandard/entitlements` (`src/schema.ts`, `src/catalog.ts`,
`src/engine.ts`).

## Routes

### Public

| Method & path                      | Response                                                 |
| ---------------------------------- | -------------------------------------------------------- |
| `GET /config` (also `/api/config`) | `PanelConfig` (below)                                    |
| `GET /api/openapi.json`            | OpenAPI 3.1                                              |
| `GET /api/pricing`                 | `PricingTable` (CORS `*`; hidden plans excluded)         |
| `GET /healthcheck`                 | `{ ok: true }`                                           |
| `POST /webhooks/:provider`         | billing intake (signature-verified, no auth) — see below |

### Admin

| Method & path                                          | Action               | Resource                                 | Body → Response                                                          |
| ------------------------------------------------------ | -------------------- | ---------------------------------------- | ------------------------------------------------------------------------ |
| `GET /api/catalog`                                     | `catalog:read`       | `{ type: "catalog" }`                    | → `CatalogView` (below)                                                  |
| `GET /api/overview`                                    | `customer:read`      | `{ type: "customer" }`                   | → `Overview` (below)                                                     |
| `GET /api/customers?search&limit&after`                | `customer:read`      | `{ type: "customer" }`                   | → `{ customers: CustomerSummary[], next? }`                              |
| `GET /api/customers/:id`                               | `customer:read`      | `{ type: "customer", customer }`         | → `{ state: CustomerState \| null, entitlements: CustomerEntitlements }` |
| `PATCH /api/customers/:id`                             | `customer:update`    | `{ type: "customer", customer }`         | `{ name?, email?, metadata? }` → `CustomerState`                         |
| `DELETE /api/customers/:id`                            | `customer:delete`    | `{ type: "customer", customer }`         | → `204`                                                                  |
| `POST /api/customers/:id/subscriptions`                | `subscription:write` | `{ type: "subscription", customer }`     | `SubscribeInput` → `201 Subscription`                                    |
| `PATCH /api/customers/:id/subscriptions/:sid`          | `subscription:write` | `{ type: "subscription", customer, id }` | `Partial<SubscriptionInput>` → `Subscription`                            |
| `POST /api/customers/:id/subscriptions/:sid/cancel`    | `subscription:write` | `{ type: "subscription", customer, id }` | `{ atPeriodEnd? }` → `Subscription`                                      |
| `DELETE /api/customers/:id/subscriptions/:sid`         | `subscription:write` | `{ type: "subscription", customer, id }` | → `204`                                                                  |
| `POST /api/customers/:id/trials`                       | `subscription:write` | `{ type: "subscription", customer }`     | `{ plan, days?, force? }` → `201 Subscription`                           |
| `POST /api/customers/:id/grants`                       | `grant:write`        | `{ type: "grant", customer }`            | `GrantInput` → `201 Grant`                                               |
| `DELETE /api/customers/:id/grants/:gid`                | `grant:write`        | `{ type: "grant", customer, id }`        | → `204`                                                                  |
| `POST /api/customers/:id/overrides`                    | `override:write`     | `{ type: "override", customer }`         | `OverrideInput` → `201 Override`                                         |
| `DELETE /api/customers/:id/overrides/:oid`             | `override:write`     | `{ type: "override", customer, id }`     | → `204`                                                                  |
| `PUT /api/customers/:id/usage/:feature`                | `usage:write`        | `{ type: "usage", customer, feature }`   | `{ value }` → `CheckResult`                                              |
| `DELETE /api/customers/:id/usage/:feature`             | `usage:write`        | `{ type: "usage", customer, feature }`   | → `204` (resets the current period)                                      |
| `GET /api/customers/:id/usage/:feature/series?days=30` | `usage:read`         | `{ type: "usage", customer, feature }`   | → `Array<{ date, value }>`                                               |
| `GET /api/customers/:id/activity?limit`                | `activity:read`      | `{ type: "activity", customer }`         | → `ActivityEntry[]`                                                      |
| `GET /api/activity?limit`                              | `activity:read`      | `{ type: "activity" }`                   | → `ActivityEntry[]`                                                      |
| `POST /api/plans/:plan/migrate`                        | `subscription:write` | `{ type: "subscription", plan }`         | `{ toVersion?, customer? = "*" }` → `{ migrated }`                       |
| `POST /api/reservations/sweep`                         | `usage:write`        | `{ type: "usage" }`                      | → `{ released }`                                                         |
| `POST /api/customers/:id/reconcile`                    | `subscription:write` | `{ type: "subscription", customer }`     | `{ provider? }` → `ReconcileResult` (billing configured)                 |

### Runtime (server-to-server)

For services that can't embed the library. Same engine, same semantics; `200` with a
`CheckResult` even when denied.

| Method & path                        | Action            | Body → Response                                                   |
| ------------------------------------ | ----------------- | ----------------------------------------------------------------- |
| `POST /api/v1/check`                 | `runtime:check`   | `{ customer, feature, amount? }` → `CheckResult`                  |
| `POST /api/v1/consume`               | `runtime:consume` | `{ customer, feature, amount?, idempotencyKey? }` → `CheckResult` |
| `POST /api/v1/release`               | `runtime:consume` | `{ customer, feature, amount? }` → `CheckResult`                  |
| `POST /api/v1/reserve`               | `runtime:consume` | `{ customer, feature, amount, ttl? }` → `ReserveResult`           |
| `POST /api/v1/settle`                | `runtime:consume` | `{ reservationId, actual, overage? }` → `CheckResult`             |
| `GET /api/v1/entitlements/:customer` | `runtime:check`   | → `CustomerEntitlements`                                          |

Resource for runtime actions: `{ type: "runtime", customer, feature? }`.

### Portal (portal token: `Authorization: Bearer entpt_…`)

| Method & path               | Action            | Body → Response                                                                |
| --------------------------- | ----------------- | ------------------------------------------------------------------------------ |
| `GET /api/portal/me`        | `portal:read`     | → `PortalView` (below)                                                         |
| `POST /api/portal/checkout` | `portal:checkout` | `{ plan, quantity?, successUrl?, cancelUrl? }` → `{ url }` (provider link-out) |
| `POST /api/portal/manage`   | `portal:manage`   | `{ returnUrl? }` → `{ url }` (provider billing portal)                         |

Admin principals may call the portal routes with `?customer=<id>` (admin preview of a portal).

## Shapes

```ts
interface PanelConfig {
  title: string;
  logoUrl?: string;
  basePath: string;
  readonly: boolean;
  mode: "admin" | "portal";
  principal: { id: string; name?: string; email?: string } | null;
  billingProviders: string[]; // configured provider ids (for reconcile / link-outs)
}

interface CatalogView {
  features: NormalizedFeature[]; // in declaration order
  plans: NormalizedPlan[]; // every version, current first per plan, in plan order
  addons: NormalizedAddon[];
  pricing: PricingTable;
}

interface Overview {
  customers: number;
  byPlan: Record<string, number>; // entitled plan key → customers (defaults included)
  statuses: Record<SubscriptionStatus, number>;
  trialsEndingSoon: Array<{ customer: string; plan: string; trialEndsAt: string }>; // next 7 days
  recentActivity: ActivityEntry[]; // newest first, max 20
}

interface PortalView extends CustomerEntitlements {
  profile: { id: string; name?: string; email?: string };
  pricing: PricingTable;
  canCheckout: boolean; // a billing provider with createCheckout is configured
  canManage: boolean; // … with createPortalSession
}
```

## Billing intake

`POST {basePath}/webhooks/:provider` is answered by the configured billing intake
(`billing: createBilling(...)` panel option, see [Billing](./BILLING.md)): `200 { received: true,
outcome }` when processed or ignored (`outcome` = `"applied" | "duplicate" | "ignored" | "stale"`),
`400 { error }` for a bad signature or payload, `404` for an unknown provider. No authentication —
the provider signature is the credential.

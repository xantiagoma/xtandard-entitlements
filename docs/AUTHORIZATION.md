# Authorization

May this principal do this? Evaluated per request against an **action** + **resource** pair (see
the route table in [HTTP_API.md](./HTTP_API.md)); three providers ship.

## Actions and resources

```ts
type EntitlementsAction =
  | "catalog:read"
  | "customer:read"
  | "customer:update"
  | "customer:delete"
  | "subscription:write" // plans, add-ons, trials, cancel, migrate, reconcile
  | "grant:write"
  | "override:write"
  | "usage:read"
  | "usage:write" // set / reset usage, reservation sweep
  | "activity:read"
  | "runtime:check" // POST /api/v1/check, GET /api/v1/entitlements/:customer
  | "runtime:consume" // POST /api/v1/consume | release | reserve | settle
  | "portal:read"
  | "portal:checkout"
  | "portal:manage";

type EntitlementsResource =
  | { type: "catalog" }
  | { type: "customer"; customer?: string }
  | { type: "subscription"; customer?: string; id?: string; plan?: string }
  | { type: "grant"; customer: string; id?: string }
  | { type: "override"; customer: string; id?: string }
  | { type: "usage"; customer?: string; feature?: string }
  | { type: "activity"; customer?: string }
  | { type: "runtime"; customer?: string; feature?: string }
  | { type: "portal"; customer: string };
```

Resources carry scope (`customer`, `feature`, ids) so a provider can answer per-tenant questions,
not just per-verb ones. `customer` is absent on collection routes (list customers, global activity,
reservation sweep, a `migrate` across all customers). For `POST /api/v1/settle` the panel looks the
reservation up so the resource carries its `customer` and `feature`.

`ALL_ACTIONS`, `MUTATING_ACTIONS` / `isMutatingAction` and `PORTAL_ACTIONS` are exported for
custom policies. **Mutating** = the control-plane writes (`customer:update`, `customer:delete`,
`subscription:write`, `grant:write`, `override:write`, `usage:write`); a `readonly` panel answers
them `423`. Metering (`runtime:consume`) and the portal link-outs are not mutations — readonly
freezes the control plane, not your product.

## Bundled providers

### `@xtandard/entitlements/authorization/none` (default)

Everything allowed. Pair only with real auth or a private network.

### `@xtandard/entitlements/authorization/roles`

```ts
import { rolesAuthorization } from "@xtandard/entitlements/authorization/roles";

const authorization = rolesAuthorization(); // DEFAULT_ROLE_POLICY
```

Maps `principal.roles` through a policy:

| Role              | Grants                                                                                                             |
| ----------------- | ------------------------------------------------------------------------------------------------------------------ |
| `viewer`          | `catalog:read`, `customer:read`, `usage:read`, `activity:read`                                                     |
| `support`         | viewer + `customer:update`, `grant:write`, `override:write`, `usage:write` — comp, raise, correct; no plan changes |
| `billing-admin`   | viewer + `customer:update`, `subscription:write`, `grant:write` — plans, trials, migrations, reconcile             |
| `admin`           | `"*"` — everything, incl. `customer:delete` and admin portal previews                                              |
| `runtime-service` | `catalog:read`, `runtime:check`, `runtime:consume` — service accounts calling `/api/v1/*`                          |

The presets are exported (`VIEWER_ACTIONS`, `SUPPORT_ACTIONS`, `BILLING_ADMIN_ACTIONS`,
`RUNTIME_SERVICE_ACTIONS`, `READ_ACTIONS`). Supply your own `policy` to rename roles or narrow
grants; unknown roles grant nothing; a principal needs at least one granting role per action.
`readonly: true` denies every mutating action regardless of role.

```ts
rolesAuthorization({
  policy: {
    success: ["customer:read", "usage:read", "grant:write"],
    finance: ["customer:read", "subscription:write", "activity:read"],
    admin: "*",
  },
});
```

### `@xtandard/entitlements/authorization/delegated`

```ts
import { delegatedAuthorization } from "@xtandard/entitlements/authorization/delegated";

const authorization = delegatedAuthorization({
  async authorize({ principal, action, resource }) {
    return myPolicyEngine.check(principal?.id, action, resource); // boolean
  },
});
```

Bridge to whatever your app uses (Casbin, OPA, Cedar, hand-rolled ACLs) — e.g. let account
managers touch only their own customers by checking `resource.customer`.

## Portal principals bypass all of this — on purpose

A request authenticated by a portal token is authorized by the token alone: its customer only, the
portal routes only, the token's `scope` only. Your authorization provider is **never consulted**
for it. Defense in depth: a bug in host policy code can't widen a customer's portal into another
customer or into the admin API. See ADR 0010 and [PORTAL.md](./PORTAL.md).

Admin principals may call the portal routes too, with `?customer=<id>` (a preview of that
customer's portal); those calls go through your provider with the portal actions and
`{ type: "portal", customer }`.

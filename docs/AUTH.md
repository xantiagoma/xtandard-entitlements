# Auth

Who is making this request? Authentication is a pluggable provider on the panel; three ship, and
the contract is one function if you need your own. (Whether they _may_ do it is authorization —
[AUTHORIZATION.md](./AUTHORIZATION.md). Portal tokens are a third, separate lane —
[PORTAL.md](./PORTAL.md).)

## The contract

```ts
interface Principal {
  id: string;
  email?: string;
  name?: string;
  roles?: string[];
  metadata?: unknown;
}

interface AuthProvider {
  /** The principal, or `null` for "no valid credentials" (→ 401). Throwing → 500. */
  authenticate(request: Request): Promise<Principal | null>;
  /** Optional: the 401 response to send (e.g. with `WWW-Authenticate`). */
  challenge?(request: Request): Response | undefined;
}
```

Return a `Principal` to admit, `null` for "not authenticated" (the panel answers the provider's
`challenge` or a plain `401 { error: "Unauthorized" }`). A provider that **throws** is a backend
failure (IdP down) and surfaces as `500`, never a misleading `401`.

The principal becomes the **actor** of every control-plane change it makes
(`{ id, name, email, type: "user" }` on grants, overrides and activity entries).

## Bundled providers

### `@xtandard/entitlements/auth/none` (default)

```ts
import { noAuth, ANONYMOUS_PRINCIPAL } from "@xtandard/entitlements/auth/none";
```

Everyone is `anonymous`. The default so the five-minute quickstart works — put anything
internet-reachable behind real auth.

### `@xtandard/entitlements/auth/basic`

```ts
import { basicAuth, hashPassword } from "@xtandard/entitlements/auth/basic";

const auth = basicAuth({
  realm: "Billing admin",
  users: [
    { username: "ops", passwordHash: await hashPassword("s3cret"), roles: ["admin"] },
    { username: "support", passwordHash: process.env.SUPPORT_HASH!, roles: ["support"] },
  ],
});
```

HTTP Basic with scrypt password hashes (`scrypt$<salt>$<hash>`, never plaintext at rest),
timing-safe verification, a custom `passwordVerifier` escape hatch, and a proper
`WWW-Authenticate` challenge. The CLI / standalone image use it with `AUTH_MODE=basic` +
`AUTH_USERNAME` / `AUTH_PASSWORD_HASH` (+ `AUTH_ROLE`, default `admin`).

Generate a hash:

```sh
bun -e 'import("@xtandard/entitlements/auth/basic").then(async (m) => console.log(await m.hashPassword(process.argv[1])))' 's3cret'
```

### `@xtandard/entitlements/auth/delegated`

```ts
import { delegatedAuth } from "@xtandard/entitlements/auth/delegated";

const auth = delegatedAuth({
  async authenticate(request) {
    const session = await myApp.getSession(request); // your cookie / JWT / IdP
    return session ? { id: session.userId, email: session.email, roles: session.roles } : null;
  },
});
```

The integration point for the auth your app already has — the panel never sees credentials, only
your resolved principal. For service-to-service calls to the runtime API (`/api/v1/*`), resolve an
API key to a principal with the `runtime-service` role.

## Wiring

```ts
entitlementsPanel({
  catalog,
  auth, // AuthProvider
  authorization, // see AUTHORIZATION.md
  portal: { secret }, // optional third lane, see PORTAL.md
});
```

Order of evaluation per request:

1. **Public routes skip auth**: `/healthcheck`, `/api/openapi.json`, `/api/pricing`, the static UI,
   and `POST /webhooks/:provider` (the provider signature is the credential).
2. A presented `Authorization: Bearer entpt_…` token (when `portal` is configured) wins — and, if
   invalid or expired, fails closed with `401 { code: "PORTAL_TOKEN" }`; it never falls back to
   host auth.
3. Otherwise your `auth` provider runs.

`/config` is public too but _does_ authenticate softly: it reports `authenticated`, the
`principal` and `mode: "admin" | "portal"` so the SPA can render the right chrome.

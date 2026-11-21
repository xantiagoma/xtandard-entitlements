/**
 * Portal tokens — the credential behind the customer portal (ADR 0010).
 *
 * A portal token is a compact HMAC-signed grant scoping its bearer to exactly
 * **one customer** and to the portal actions (`portal:read`, `portal:checkout`,
 * `portal:manage` — or a narrower `scope`) for a limited time. The host mints
 * tokens server-side with {@link createPortalToken} after its own login (the
 * portal secret never reaches a browser) and hands them to its frontend; the
 * panel verifies them with {@link verifyPortalToken} (`portal: { secret }`
 * panel option) and force-scopes every request to the token's customer — the
 * host's authorization provider is not consulted for portal principals.
 *
 * Wire format:
 *
 * ```txt
 * entpt_<base64url(JSON { customer, scope, exp })>.<base64url(HMAC-SHA256(secret, payloadPart))>
 * ```
 *
 * The mechanics are `@xtandard/kit/tokens` (Web Crypto only). The secret is an
 * **arbitrary string**, fed to the HMAC as raw UTF-8 bytes; pass a list of
 * secrets to rotate (the first signs, any verifies). Revocation before expiry =
 * rotate the secret and drop the old one.
 *
 * @module
 */

import { createScopedTokens, type TokenSecret } from "@xtandard/kit/tokens";
import { PORTAL_ACTIONS } from "./authorization/contract.ts";
import type { Duration } from "./duration.ts";

/** Prefix of every portal token. */
export const PORTAL_TOKEN_PREFIX = "entpt_";

const DEFAULT_EXPIRES_IN: Duration = "1h";

/** A portal action a token may grant. */
export type PortalAction = "portal:read" | "portal:checkout" | "portal:manage";

const isPortalAction = (value: unknown): value is PortalAction =>
  typeof value === "string" && (PORTAL_ACTIONS as readonly string[]).includes(value);

/** The portal token mechanics: `entpt_` prefix, 1-hour default lifetime, `{ customer, scope }`. */
const portalTokens = createScopedTokens<{ customer: string; scope: PortalAction[] }>({
  prefix: PORTAL_TOKEN_PREFIX,
  ttl: DEFAULT_EXPIRES_IN,
  label: "portal token",
  errorName: "PortalTokenError",
  validateClaims: (payload) => {
    if (typeof payload.customer !== "string" || payload.customer.length === 0) {
      throw new Error("missing customer");
    }
    const scope = payload.scope;
    if (!Array.isArray(scope) || scope.length === 0 || !scope.every(isPortalAction)) {
      throw new Error("invalid scope");
    }
    return { customer: payload.customer, scope };
  },
});

/**
 * Thrown by {@link verifyPortalToken} (and {@link createPortalToken} for bad
 * input) — malformed, bad signature, expired, or an invalid scope. Maps to
 * HTTP 401 at the API layer.
 */
export const PortalTokenError = portalTokens.TokenError;
/** An invalid, expired or unmintable portal token (see the {@link PortalTokenError} class). */
export type PortalTokenError = InstanceType<typeof PortalTokenError>;

/** Options for {@link createPortalToken}. */
export interface PortalTokenOptions {
  /** Token lifetime. Default `"1h"`. */
  expiresIn?: Duration;
  /**
   * The portal actions granted. Default: all three. `["portal:read"]` makes a
   * view-only portal (no upgrade / manage-billing link-outs).
   */
  scope?: readonly PortalAction[];
  /** Clock override (unix ms) — tests. Default `Date.now()`. */
  now?: number;
}

/** What a verified token grants. */
export interface PortalTokenClaims {
  /** The customer the token is scoped to. */
  customer: string;
  /** The granted portal actions. */
  scope: PortalAction[];
  /** Expiry, unix epoch milliseconds. */
  expiresAt: number;
}

/**
 * Mint a portal token for `customer`, valid for `expiresIn` (default 1 hour).
 * Call this **server-side**, after your own authentication — anyone holding
 * the portal secret can mint tokens for any customer.
 *
 * @example
 * ```ts
 * import { createPortalToken } from "@xtandard/entitlements";
 *
 * // In the host app's session-guarded route:
 * const token = await createPortalToken(process.env.PORTAL_SECRET!, session.orgId, {
 *   expiresIn: "1h",
 * });
 * // Hand `token` to the frontend for <CustomerPortal token={token} />.
 * ```
 */
export async function createPortalToken(
  secret: TokenSecret,
  customer: string,
  options: PortalTokenOptions = {},
): Promise<string> {
  if (typeof secret === "string" ? !secret : secret.length === 0 || secret.some((x) => !x)) {
    throw new PortalTokenError("A portal secret is required");
  }
  if (typeof customer !== "string" || customer.length === 0) {
    throw new PortalTokenError("A portal token needs a customer id");
  }
  const scope = [...(options.scope ?? (PORTAL_ACTIONS as readonly PortalAction[]))];
  if (scope.length === 0 || !scope.every(isPortalAction)) {
    throw new PortalTokenError(
      `Invalid portal scope: expected some of ${PORTAL_ACTIONS.join(", ")}`,
    );
  }
  return portalTokens.create(
    secret,
    { customer, scope: [...new Set(scope)] },
    {
      ...(options.expiresIn !== undefined ? { expiresIn: options.expiresIn } : {}),
      ...(options.now !== undefined ? { now: options.now } : {}),
    },
  );
}

/**
 * Verify a portal token: format, signature (constant time), then claims and
 * expiry. Returns the granted customer and scope; throws
 * {@link PortalTokenError} otherwise.
 *
 * @example
 * ```ts
 * import { verifyPortalToken } from "@xtandard/entitlements";
 *
 * const { customer, scope } = await verifyPortalToken(secret, token);
 * ```
 */
export async function verifyPortalToken(
  secret: TokenSecret,
  token: string,
  options: { now?: number } = {},
): Promise<PortalTokenClaims> {
  const { claims, expiresAt } = await portalTokens.verify(secret, token, options);
  return { customer: claims.customer, scope: claims.scope, expiresAt };
}

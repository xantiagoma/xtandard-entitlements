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
 * entpt_<base64url(JSON { customer, exp, scope })>.<base64url(HMAC-SHA256(secret, payloadPart))>
 * ```
 *
 * Zero dependencies (Web Crypto only). The secret is an **arbitrary string**,
 * fed to the HMAC as raw UTF-8 bytes. Revocation before expiry = rotate the
 * secret.
 *
 * @module
 */

import { PORTAL_ACTIONS } from "./authorization/contract.ts";
import { durationToMs, type Duration } from "./duration.ts";

/** Prefix of every portal token. */
export const PORTAL_TOKEN_PREFIX = "entpt_";

const DEFAULT_EXPIRES_IN: Duration = "1h";

/** A portal action a token may grant. */
export type PortalAction = "portal:read" | "portal:checkout" | "portal:manage";

/**
 * Thrown by {@link verifyPortalToken} (and {@link createPortalToken} for bad
 * input) — malformed, bad signature, expired, or an invalid scope. Maps to
 * HTTP 401 at the API layer.
 */
export class PortalTokenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PortalTokenError";
  }
}

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

/** The on-the-wire payload (compact keys). */
interface WireClaims {
  customer: string;
  exp: number;
  scope: string[];
}

const isPortalAction = (value: unknown): value is PortalAction =>
  typeof value === "string" && (PORTAL_ACTIONS as readonly string[]).includes(value);

const base64urlEncode = (bytes: Uint8Array): string => {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

const base64urlDecode = (value: string): Uint8Array => {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
};

/** HMAC-SHA256 keyed by the raw UTF-8 bytes of the (arbitrary-string) secret. */
async function hmac(secret: string, content: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret) as BufferSource,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const digest = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(content));
  return new Uint8Array(digest);
}

/** Constant-time byte comparison (XOR accumulate — no early exit on content). */
function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= (a[i] as number) ^ (b[i] as number);
  return diff === 0;
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
  secret: string,
  customer: string,
  options: PortalTokenOptions = {},
): Promise<string> {
  if (!secret) throw new PortalTokenError("A portal secret is required");
  if (typeof customer !== "string" || customer.length === 0) {
    throw new PortalTokenError("A portal token needs a customer id");
  }
  const scope = [...(options.scope ?? (PORTAL_ACTIONS as readonly PortalAction[]))];
  if (scope.length === 0 || !scope.every(isPortalAction)) {
    throw new PortalTokenError(
      `Invalid portal scope: expected some of ${PORTAL_ACTIONS.join(", ")}`,
    );
  }
  const expiresInMs = durationToMs(options.expiresIn ?? DEFAULT_EXPIRES_IN);
  const claims: WireClaims = {
    customer,
    exp: (options.now ?? Date.now()) + expiresInMs,
    scope: [...new Set(scope)],
  };
  const payloadPart = base64urlEncode(new TextEncoder().encode(JSON.stringify(claims)));
  const signature = base64urlEncode(await hmac(secret, payloadPart));
  return `${PORTAL_TOKEN_PREFIX}${payloadPart}.${signature}`;
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
  secret: string,
  token: string,
  options: { now?: number } = {},
): Promise<PortalTokenClaims> {
  if (!token.startsWith(PORTAL_TOKEN_PREFIX)) {
    throw new PortalTokenError(`Invalid portal token: missing ${PORTAL_TOKEN_PREFIX} prefix`);
  }
  const parts = token.slice(PORTAL_TOKEN_PREFIX.length).split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new PortalTokenError("Invalid portal token: malformed");
  }
  const [payloadPart, signaturePart] = parts as [string, string];

  // Signature first: never interpret unauthenticated claims.
  let candidate: Uint8Array;
  try {
    candidate = base64urlDecode(signaturePart);
  } catch {
    throw new PortalTokenError("Invalid portal token: malformed signature");
  }
  const expected = await hmac(secret, payloadPart);
  if (!timingSafeEqual(expected, candidate)) {
    throw new PortalTokenError("Invalid portal token: signature mismatch");
  }

  let claims: Partial<WireClaims>;
  try {
    claims = JSON.parse(new TextDecoder().decode(base64urlDecode(payloadPart))) as WireClaims;
  } catch {
    throw new PortalTokenError("Invalid portal token: malformed payload");
  }
  if (typeof claims.customer !== "string" || claims.customer.length === 0) {
    throw new PortalTokenError("Invalid portal token: missing customer");
  }
  if (typeof claims.exp !== "number" || !Number.isFinite(claims.exp)) {
    throw new PortalTokenError("Invalid portal token: missing expiry");
  }
  if (
    !Array.isArray(claims.scope) ||
    claims.scope.length === 0 ||
    !claims.scope.every(isPortalAction)
  ) {
    throw new PortalTokenError("Invalid portal token: invalid scope");
  }
  if ((options.now ?? Date.now()) >= claims.exp) {
    throw new PortalTokenError("Portal token has expired");
  }
  return { customer: claims.customer, scope: claims.scope, expiresAt: claims.exp };
}

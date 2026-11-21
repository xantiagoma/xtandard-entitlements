/**
 * Shared, zero-dependency plumbing for billing providers (ADR 0007): Web
 * Crypto HMAC-SHA256, constant-time comparison, timestamp tolerance, header
 * lookup and a tiny `fetch` wrapper for provider REST APIs. Runs anywhere
 * Web Crypto and `fetch` exist (Node ≥ 20, Bun, Deno, edge runtimes).
 *
 * @module
 */

import { BillingVerificationError } from "./contract.ts";

const encoder = new TextEncoder();

/** A `fetch`-compatible function (injectable for tests). */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** HMAC-SHA256 of `message` with `key` (a UTF-8 string or raw bytes). */
export async function hmacSha256(key: string | Uint8Array, message: string): Promise<Uint8Array> {
  const raw = typeof key === "string" ? encoder.encode(key) : key;
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    raw as BufferSource,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", cryptoKey, encoder.encode(message)));
}

/** SHA-256 of a string, hex-encoded. */
export async function sha256Hex(message: string): Promise<string> {
  return toHex(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(message))));
}

/** Lowercase hex encoding. */
export function toHex(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

/** Standard base64 encoding. */
export function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

/** Standard base64 decoding; `null` when the input is not base64. */
export function fromBase64(value: string): Uint8Array | null {
  try {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}

/** Constant-time string comparison (XOR accumulate; no early exit on content). */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** True when any candidate equals any expected value (every pair compared in constant time). */
export function anyMatch(candidates: readonly string[], expected: readonly string[]): boolean {
  let ok = false;
  for (const c of candidates) for (const e of expected) if (timingSafeEqual(c, e)) ok = true;
  return ok;
}

/** Normalize a secret option (one secret or several during rotation). */
export function secretList(secret: string | readonly string[], provider: string): string[] {
  const list = (typeof secret === "string" ? [secret] : [...secret]).filter((s) => s.length > 0);
  if (list.length === 0) throw new Error(`${provider}: a webhook secret is required`);
  return list;
}

/** Read a required header or throw {@link BillingVerificationError}. */
export function requireHeader(request: Request, name: string): string {
  const value = request.headers.get(name);
  if (!value) throw new BillingVerificationError(`Missing ${name} header`);
  return value;
}

/**
 * Reject timestamps (unix seconds) further than `toleranceSeconds` from now, in
 * either direction. A tolerance `<= 0` disables the check.
 */
export function assertTimestamp(timestamp: number, nowMs: number, toleranceSeconds: number): void {
  if (!Number.isFinite(timestamp))
    throw new BillingVerificationError("Invalid signature timestamp");
  if (toleranceSeconds <= 0) return;
  if (Math.abs(nowMs / 1000 - timestamp) > toleranceSeconds) {
    throw new BillingVerificationError("Signature timestamp outside the tolerance window");
  }
}

/** Parse a verified body as JSON, or throw {@link BillingVerificationError}. */
export function parseJson<T>(body: string): T {
  try {
    const value = JSON.parse(body) as unknown;
    if (typeof value !== "object" || value === null) throw new Error("not an object");
    return value as T;
  } catch {
    throw new BillingVerificationError("Webhook body is not a JSON object");
  }
}

/** Unix seconds → ISO-8601 (`undefined` for null / missing). */
export const fromUnix = (seconds: number | null | undefined): string | undefined =>
  typeof seconds === "number" && Number.isFinite(seconds)
    ? new Date(seconds * 1000).toISOString()
    : undefined;

/** A nullable string → `string | undefined`. */
export const opt = (value: string | null | undefined): string | undefined =>
  typeof value === "string" && value.length > 0 ? value : undefined;

/** A provider REST call failed (non-2xx or unusable response). Carries the HTTP status. */
export class BillingApiError extends Error {
  /** HTTP status returned by the provider (`0` when the response was unusable). */
  readonly status: number;
  /** Parsed response body, when there was one. */
  readonly body: unknown;
  constructor(message: string, status: number, body?: unknown) {
    super(message);
    this.name = "BillingApiError";
    this.status = status;
    this.body = body;
  }
}

/** Options shared by every provider's REST client. */
export interface ProviderHttpOptions {
  /** `fetch` implementation (tests, proxies). Default: global `fetch`. */
  fetch?: FetchLike;
  /** Override the API base URL (sandbox / mock servers). */
  apiBase?: string;
}

/** Issue a request and parse a JSON response; throws {@link BillingApiError} on non-2xx. */
export async function requestJson<T>(
  provider: string,
  fetchImpl: FetchLike,
  url: string,
  init: RequestInit,
): Promise<T> {
  const response = await fetchImpl(url, init);
  const text = await response.text();
  let body: unknown = undefined;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  if (!response.ok) {
    throw new BillingApiError(
      `${provider} API ${init.method ?? "GET"} ${new URL(url).pathname} failed with ${response.status}`,
      response.status,
      body,
    );
  }
  return body as T;
}

/** `fetch` resolved lazily so tests and polyfills installed after import still apply. */
export const defaultFetch: FetchLike = (input, init) => fetch(input, init);

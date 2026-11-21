/**
 * Internal helpers shared by the state-storage and counter drivers: identifier
 * validation, literal-prefix matching for SQL (`LIKE … ESCAPE '!'`, SQLite
 * `GLOB`), Redis `MATCH` and MongoDB regexes, and canonical JSON (sorted object
 * keys) so drivers can compare-and-swap with a plain equality check.
 *
 * Not a public subpath — drivers import it directly.
 *
 * @module
 */

/** Identifiers we are willing to interpolate into DDL/queries unquoted. */
export const SAFE_IDENTIFIER = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

/** Throw unless `name` is a safe SQL identifier; returns it for chaining. */
export function assertIdentifier(name: string, what = "table"): string {
  if (!SAFE_IDENTIFIER.test(name)) {
    throw new Error(
      `Invalid ${what} name ${JSON.stringify(name)}: must match ${SAFE_IDENTIFIER.source}`,
    );
  }
  return name;
}

/**
 * Escape a literal prefix for `LIKE … ESCAPE '!'`. `!` (not `\`) because a
 * backslash inside a string literal is itself an escape on MySQL, so
 * `ESCAPE '\'` is a syntax error there; `!` means the same on every dialect.
 */
export const escapeLike = (literal: string): string => literal.replace(/[!%_]/g, (c) => `!${c}`);

/**
 * Escape a literal prefix for SQLite `GLOB` (case-sensitive, unlike SQLite's
 * `LIKE`, which folds ASCII case). `*`, `?` and `[` are wrapped in a one-char
 * class; `]` outside a class is already literal.
 */
export const escapeGlob = (literal: string): string => literal.replace(/[*?[]/g, (c) => `[${c}]`);

/** Escape a literal prefix for a Redis `SCAN … MATCH` glob. */
export const escapeRedisGlob = (literal: string): string =>
  literal.replace(/[*?[\]\\]/g, (c) => `\\${c}`);

/** Escape a literal string for embedding in a regular expression. */
export const escapeRegex = (literal: string): string =>
  literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * A JSON-equivalent copy of `value` with object keys sorted recursively, so
 * two structurally equal values serialize identically. Values pass through
 * `JSON.stringify` semantics first (`undefined` members dropped, `toJSON`
 * honoured).
 */
export function canonical<T>(value: T): T {
  if (value === undefined) return value;
  return sortKeys(JSON.parse(JSON.stringify(value)) as unknown) as T;
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value === null || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    out[key] = sortKeys((value as Record<string, unknown>)[key]);
  }
  return out;
}

/** `JSON.stringify` of the {@link canonical} form — equal values ⇒ equal strings. */
export const canonicalJson = (value: unknown): string => JSON.stringify(canonical(value));

/** Structural equality for JSON-shaped values (key order ignored). */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a as object);
  const kb = Object.keys(b as object);
  if (ka.length !== kb.length) return false;
  return ka.every(
    (k) =>
      Object.prototype.hasOwnProperty.call(b, k) &&
      deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]),
  );
}

/**
 * Normalise a JSON column value. `pg`, `pglite` and Drizzle usually return
 * `json`/`jsonb` already parsed; a string is parsed defensively so every
 * driver works.
 */
export function parseJsonValue<T>(value: unknown): T {
  if (typeof value === "string") {
    try {
      return JSON.parse(value) as T;
    } catch {
      return value as T;
    }
  }
  return value as T;
}

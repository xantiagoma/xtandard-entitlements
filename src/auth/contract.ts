/**
 * Authentication contract. Answers: "Who is this request from?"
 *
 * `@xtandard/entitlements` ships `none`/`basic`/`delegated` implementations, but any
 * object satisfying {@link AuthProvider} works — bring your own.
 *
 * The contract lives in `@xtandard/kit/auth`.
 *
 * @module
 */

export type { AuthProvider, Principal } from "@xtandard/kit/auth";

# ADR 0009 — Decisions Carry Reasons; 402 (Upsell) vs 403 (Forbidden); `unlockedBy`

**Status:** Accepted ★

---

## Context

byo-oss and Schematic return `{ allowed, reason, balance, unlockedBy }` so UIs can show an upsell
instead of an error. `@12-apps/entitlements` distinguishes **402 Payment Required** (a paid plan would
allow it) from **403 Forbidden** (no plan would, or an operator disabled it). Framework guards need to
pick a status code without re-deriving the reason.

## Decision

Every `check`/`consume`/`reserve` returns a `CheckResult` (see `src/schema.ts`):

- `allowed`, `reason` (a closed union: `included`, `within_limit`, `overage_allowed`,
  `limit_reached`, `not_in_plan`, `disabled_by_override`, `granted_by_override`,
  `subscription_inactive`, `unknown_feature`, `fallback`), and for denials
  `denial: "payment_required" | "forbidden"`.
- `payment_required` when some catalog plan or add-on (current versions) would allow the request —
  those plan keys are in `unlockedBy`, cheapest first. `forbidden` otherwise (no plan includes it,
  disabled by override, unknown feature).
- Usage fields: `limit` (`null` = unlimited), `used`, `remaining`, `overage`, `resetsAt`, plus
  `value` for value features and `stale` / `buffered` provenance flags.
- `consume` never throws for a denial; it throws only for programmer errors (unknown feature when
  `strict: true`, negative amounts). `ent.require(...)` / `consumeOrThrow` throw
  `EntitlementDeniedError` carrying the result, which adapters' `requireEntitlement` guards turn into
  `402`/`403` JSON (`{ error, reason, feature, unlockedBy, … }`).

## Consequences

- UIs render "Upgrade to Pro" from data, not from string matching.
- The reason union is part of the public API; adding a reason is a minor (0.x) change.

# ADR 0008 — Flags Bridge: OpenFeature Provider + Evaluation-Context Enricher

**Status:** Accepted ★

---

## Context

Schematic's pitch is "feature flags tied to billing plans". In the xtandard family the flag layer
already exists (`@xtandard/flags`, OpenFeature-compatible, flat evaluation contexts:
`context[attribute]`). Teams want one gate for "is the rollout on for this user?" **and** "does their
plan include it?", without wiring two systems in every handler.

## Decision

`@xtandard/entitlements/flags` ships three small pieces, none with a runtime dependency on
`@openfeature/server-sdk` or `@xtandard/flags` (types only, literals replicated — the flags pattern):

1. **`entitlementsContext(ent, options)`** → `(customerId) => Promise<Record<string, JsonValue>>`
   producing flat attributes: `plan`, `plans`, `subscription.status`, `entitlement.<feature>`
   (allowed), `entitlement.<feature>.remaining`, `.limit`, `.value`. Merge it into any flags
   evaluation context so rules can target `entitlement.export_pdf == true` or
   `plan in ["pro", "enterprise"]`.
2. **`createEntitlementsHook(ent, { customerKey })`** → an OpenFeature `Hook` whose `before` returns
   the enriched context, so every flag evaluation through _any_ provider (including
   `@xtandard/flags/openfeature`) sees entitlement attributes automatically.
3. **`createEntitlementsProvider(ent)`** → an OpenFeature `Provider` where the flag key is a feature
   key and the targeting key is the customer: boolean → `allowed`, number → `remaining` (metered /
   capacity) or `value`, string/object → `value`. Reasons map to OpenFeature reasons
   (`TARGETING_MATCH`, `DEFAULT`, `STALE`, `ERROR` + `FLAG_NOT_FOUND`).

The enricher reads the memory-first snapshot (ADR 0003); metered attributes cost one batched counter
read and can be disabled (`usage: false`).

## Consequences

- "Rollouts and entitlements share one gate" without coupling the two packages' release cycles.
- The provider lets non-xtandard OpenFeature users adopt entitlements with zero new call sites.

# ADR 0013 — Ecosystem Bridges by Structural Typing, No Runtime Dependencies

**Status:** Accepted ★

---

## Context

Overrides, grants and plan changes are exactly what `@xtandard/audit` exists to record; usage
thresholds ("80 % of quota") and plan changes are natural outbound events for `@xtandard/webhooks`.
Neither sibling should become a dependency of this package (nor vice versa).

## Decision

- `@xtandard/entitlements/bridges/audit` — `auditHooks(audit, { tenant? })` returns `after` hooks
  that call `audit.record({ tenant, action: "entitlements.<event>", actor, targets, metadata })` for
  grant/override/subscription/usage-reset events. The `audit` parameter is a structural type
  (`{ record(input): Promise<unknown> }`), so any compatible recorder works.
- `@xtandard/entitlements/bridges/webhooks` — `webhooksEvents(webhooks, { application? })` returns
  `{ onThreshold, hooks }` that call `webhooks.publish(application, { eventType, payload,
  idempotencyKey })` for `entitlements.usage.threshold`, `entitlements.subscription.changed`,
  `entitlements.trial.started`, … Structural type again (`{ publish(app, input): Promise<unknown> }`).
- Each bridge is tested against the real sibling package as a dev dependency.

## Consequences

- Installing entitlements never pulls audit or webhooks; pairing them is two lines.

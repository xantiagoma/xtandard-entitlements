# Ecosystem Bridges

Overrides, grants and plan changes are exactly what `@xtandard/audit` exists to record; usage thresholds and plan changes are natural outbound events for `@xtandard/webhooks`. Both bridges are **structurally typed** — they import nothing from the sibling packages, so installing entitlements never pulls them in, and any object with a compatible method works (ADR 0013). Both are tested against the real siblings.

---

## Audit — `@xtandard/entitlements/bridges/audit`

`auditHooks(audit, options)` returns `after` hooks that call `audit.record(...)` for every committed control-plane change.

```ts
import { createAudit } from "@xtandard/audit";
import { createEntitlements } from "@xtandard/entitlements";
import { auditHooks } from "@xtandard/entitlements/bridges/audit";

const audit = createAudit({ storage });
const ent = createEntitlements({ catalog, hooks: auditHooks(audit, { tenant: "acme" }) });

await ent.grant("org_42", { feature: "ai_credits", amount: 1_000, reason: "goodwill" }, { actor });
// → audit.record({ tenant: "acme", action: "entitlements.grant.created", actor, targets: [customer, grant, feature], … })
```

| Entitlements event                  | Audit action                                     | Targets                            |
| ----------------------------------- | ------------------------------------------------ | ---------------------------------- |
| `subscription.changed` / `.removed` | `entitlements.subscription.changed` / `…removed` | customer, subscription (plan name) |
| `grant.created` / `.revoked`        | `entitlements.grant.created` / `…revoked`        | customer, grant, feature           |
| `override.created` / `.removed`     | `entitlements.override.created` / `…removed`     | customer, override, feature        |
| `usage.reset` / `usage.set`         | `entitlements.usage.reset` / `…set`              | customer, feature                  |
| `customer.updated` / `.deleted`     | `entitlements.customer.updated` / `…deleted`     | customer                           |

Each record carries `occurredAt` (the change time), the `actor` when one was given (`{ id, type, name, email }` — billing changes use `{ id: "stripe", type: "billing:stripe" }`), a compact `metadata` summary (plan / version / status / quantity / provider and the previous values; grant amount and reason; override fields) and a one-line `description`.

| Option         | Default           | Description                                       |
| -------------- | ----------------- | ------------------------------------------------- |
| `tenant`       | ambient context   | A tenant for every event, or `(event) => tenant`. |
| `actionPrefix` | `"entitlements."` | Prefix of the audit action.                       |
| `events`       | all               | Only these event types.                           |

The structural contract is `{ record(input: { tenant?, action, occurredAt?, actor?, targets?, metadata?, description? }): unknown }`. Recording errors are isolated by the engine's hook runner (`onHookError`) and never fail the mutation.

---

## Webhooks — `@xtandard/entitlements/bridges/webhooks`

`webhooksEvents(webhooks, options)` returns `{ hooks, onThreshold, onUsage? }` that call `webhooks.publish(application, { eventType, payload, timestamp, idempotencyKey })`.

```ts
import { createWebhooksCore } from "@xtandard/webhooks/core";
import { ENTITLEMENTS_EVENT_TYPES, webhooksEvents } from "@xtandard/entitlements/bridges/webhooks";

const webhooks = createWebhooksCore({ storage });
for (const t of ENTITLEMENTS_EVENT_TYPES) await webhooks.upsertEventType(t); // the catalog requires known types

const bridge = webhooksEvents(webhooks); // application = the customer id
const ent = createEntitlements({
  catalog,
  hooks: bridge.hooks,
  onThreshold: bridge.onThreshold,
});
```

| Event type                              | When                                                            | Payload                                                  |
| --------------------------------------- | --------------------------------------------------------------- | -------------------------------------------------------- |
| `entitlements.subscription.changed`     | any subscription create / change                                | `{ customer, subscription, previous? }`                  |
| `entitlements.trial.started`            | a subscription becomes `trialing`                               | same                                                     |
| `entitlements.subscription.canceled`    | a subscription moves to `canceled`                              | same                                                     |
| `entitlements.subscription.removed`     | a subscription is deleted                                       | `{ customer, subscription }`                             |
| `entitlements.grant.created/revoked`    | grants                                                          | `{ customer, grant }`                                    |
| `entitlements.override.created/removed` | overrides                                                       | `{ customer, override }`                                 |
| `entitlements.usage.reset`              | an operator reset usage                                         | `{ customer, feature, at }`                              |
| `entitlements.usage.threshold`          | usage crossed a configured share of the limit (once per period) | the `ThresholdEvent`                                     |
| `entitlements.usage.recorded`           | every usage change (`usage: true` only)                         | `{ customer, feature, amount, source, used, remaining }` |

| Option        | Default           | Description                                                      |
| ------------- | ----------------- | ---------------------------------------------------------------- |
| `application` | the customer id   | A fixed webhooks application key, or `(customer) => key`.        |
| `eventPrefix` | `"entitlements."` | Event type prefix.                                               |
| `usage`       | `false`           | Also return `onUsage`, publishing `entitlements.usage.recorded`. |

Idempotency keys follow `@xtandard/webhooks`' charset (`a-z A-Z 0-9 . _ -`, ≤ 256): thresholds use `<type>.<customer>_<feature>_<period>_<ratio>` (one per period), control-plane events the changed object's id plus a hash of the payload (an identical re-delivery dedupes; two different changes never collide), usage the caller's idempotency key when there is one. Publish failures are isolated (`onHookError` for hooks, `onEventError` for the runtime taps).

The structural contract is `{ publish(application: string, input: { eventType, payload, timestamp?, idempotencyKey? }): Promise<unknown> }`.

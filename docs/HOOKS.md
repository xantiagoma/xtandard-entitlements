# Hooks and events

Two kinds of observers, for two planes ([Architecture](./ARCHITECTURE.md)).

## Control-plane hooks

`hooks` (one hook or an array) run around every state mutation — from your code, the admin UI, the
CLI or a billing webhook:

```ts
import { createEntitlements, HookDeniedError } from "@xtandard/entitlements";

const ent = createEntitlements({
  catalog,
  hooks: {
    before(event) {
      // Throw to deny; the error reaches the caller (the panel answers with its status, default 403).
      if (
        event.type === "grant.create" &&
        event.grant.amount > 10_000 &&
        event.actor?.type !== "admin"
      ) {
        throw new HookDeniedError("grants over 10k need an admin");
      }
    },
    async after(event) {
      // Committed. Side effects only: errors go to onHookError and never undo the change.
      if (event.type === "subscription.changed") await crm.sync(event.customer, event.subscription);
    },
  },
});
```

| `before`                              | `after`                                 | When                                                            |
| ------------------------------------- | --------------------------------------- | --------------------------------------------------------------- |
| `subscription.upsert`                 | `subscription.changed`                  | plan change, trial, cancel, provider webhook, version migration |
| `subscription.remove`                 | `subscription.removed`                  | a subscription deleted from the customer                        |
| `grant.create` / `grant.revoke`       | `grant.created` / `grant.revoked`       | balances added or removed                                       |
| `override.create` / `override.remove` | `override.created` / `override.removed` | comps, raised limits, disables                                  |
| `usage.set` / `usage.reset`           | `usage.set` / `usage.reset`             | admin corrections                                               |
| `customer.update` / `customer.delete` | `customer.updated` / `customer.deleted` | profile changes, deletion                                       |

Every event carries `customer` and `actor` (pass `{ actor }` as the last argument of any control-plane
call; the panel fills it from the authenticated principal). `@xtandard/entitlements/hooks/log` logs
every event; `@xtandard/entitlements/bridges/audit` records them in `@xtandard/audit`
([Ecosystem](./ECOSYSTEM.md)).

## Runtime taps

Not hooks — they never block or deny a decision:

- `onUsage(event)`: every successful consume / reserve / settle / release / `setUsage`, with the
  decision, the amount and any idempotency key or metadata.
- `onThreshold(event)`: usage crossed `threshold × limit` for the period (once per period per
  threshold; claimed in the counter store, so once across instances too).

Listener errors go to `onEventError` (default `console.warn`).

## Activity

The engine also keeps a short activity list per customer and a global one (`ent.activity(customer?)`,
shown in the admin UI); configure with `activity: { perCustomer, global }` or turn it off with
`activity: false`. For a durable, tamper-evident trail use `@xtandard/audit`.

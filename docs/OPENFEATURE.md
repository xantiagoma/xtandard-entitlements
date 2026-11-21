# OpenFeature / Flags Bridge

One gate for "is the rollout on for this customer?" **and** "does their plan include it?" (ADR 0008). `@xtandard/entitlements/flags` ships three small pieces that work with any OpenFeature setup — including `@xtandard/flags` — with **no runtime dependency** on `@openfeature/server-sdk` or `@xtandard/flags` (types only; reason and error-code strings are replicated as literals, the same pattern as `@xtandard/flags/openfeature`).

```bash
bun add @xtandard/entitlements @openfeature/server-sdk
```

---

## Evaluation-context enricher

`entitlementsContext(ent, options)` → `(customerId) => Promise<attributes>` produces **flat** attributes to merge into any flags evaluation context:

| Attribute                         | Value                                                                    |
| --------------------------------- | ------------------------------------------------------------------------ |
| `plan`                            | the base-group plan key (`"free"`, `"pro"`, …)                           |
| `plans`, `addons`                 | every active plan / applied add-on key                                   |
| `subscription.status`             | status of `plan` (`"default"` when it applies as the group default)      |
| `entitlement.<feature>`           | allowed — booleans: on/off; numeric: something left (or overage allowed) |
| `entitlement.<feature>.limit`     | numeric limit (`null` = unlimited)                                       |
| `entitlement.<feature>.used`      | current usage (`usage: true`)                                            |
| `entitlement.<feature>.remaining` | what is left (`null` = unlimited; `usage: true`)                         |
| `entitlement.<feature>.value`     | value features                                                           |
| `entitlements.stale`              | `true` when served from a last-known-good snapshot                       |

```ts
import { entitlementsContext } from "@xtandard/entitlements/flags";

const context = entitlementsContext(ent);
const attrs = await context("org_42");
// { plan: "pro", plans: ["pro"], "entitlement.export_pdf": true, "entitlement.api_calls.remaining": 99_750, … }
```

| Option     | Default          | Description                                                                                     |
| ---------- | ---------------- | ----------------------------------------------------------------------------------------------- |
| `prefix`   | `"entitlement."` | Prefix of per-feature attributes.                                                               |
| `usage`    | `true`           | Include usage (`.used`, `.remaining`, usage-aware allowed) — one batched counter read per call. |
| `features` | all              | Only these features.                                                                            |

With `usage: false` the attributes come from the memory-first snapshot alone (`ent.resolve`) — no storage or counter I/O once the customer is cached (ADR 0003).

---

## Hook: enrich every evaluation

`createEntitlementsHook(ent, options)` returns an OpenFeature `Hook` whose `before` returns the attributes above, so every flag evaluation — through **any** provider — can target them. Attributes already present in the context win; a failed load is reported (`onError`) and the evaluation proceeds without them.

```ts
import { OpenFeature } from "@openfeature/server-sdk";
import { createOpenFeatureProvider } from "@xtandard/flags/openfeature";
import { createEntitlementsHook } from "@xtandard/entitlements/flags";

await OpenFeature.setProviderAndWait(createOpenFeatureProvider({ storage }));
OpenFeature.addHooks(createEntitlementsHook(ent)); // customer = targetingKey

const client = OpenFeature.getClient();
// A flags rule `entitlement.export_pdf equals true` or `plan in ["business", "enterprise"]` now just works:
await client.getBooleanValue("new-export-ui", false, { targetingKey: "org_42" });
```

| Option        | Default        | Description                                                              |
| ------------- | -------------- | ------------------------------------------------------------------------ |
| `customerKey` | `targetingKey` | A context attribute name, or `(context) => customerId`.                  |
| `onError`     | `console.warn` | Called when entitlements cannot be loaded.                               |
| …             |                | Plus every `entitlementsContext` option (`prefix`, `usage`, `features`). |

---

## Provider: entitlements as flags

`createEntitlementsProvider(ent)` is an OpenFeature `Provider` where the **flag key is a feature key** and the **targeting key is the customer** — adopt entitlements with zero new call sites:

```ts
import { createEntitlementsProvider } from "@xtandard/entitlements/flags";

await OpenFeature.setProviderAndWait("entitlements", createEntitlementsProvider(ent));
const gates = OpenFeature.getClient("entitlements");

await gates.getBooleanValue("export_pdf", false, { targetingKey: "org_42" }); // allowed
await gates.getNumberValue("api_calls", 0, { targetingKey: "org_42" }); // remaining
await gates.getStringValue("support", "community", { targetingKey: "org_42" }); // value
await gates.getObjectValue("api_calls", {}, { targetingKey: "org_42" }); // the whole decision
```

| Resolve | Returns                                                                                               |
| ------- | ----------------------------------------------------------------------------------------------------- |
| boolean | `allowed`                                                                                             |
| number  | `remaining` for metered / credits / capacity features (`Infinity` when unlimited), or a numeric value |
| string  | a string value feature's value                                                                        |
| object  | a value feature's value, or the decision `{ allowed, reason, remaining, limit, unlockedBy, … }`       |

`variant` is the decision reason (`"within_limit"`, `"not_in_plan"`, …) and `flagMetadata` carries `allowed`, `reason`, `denial`, `limit`, `used`, `remaining`, `resetsAt`, `unlockedBy` (comma-separated), `stale`.

| Situation                         | OpenFeature result                               |
| --------------------------------- | ------------------------------------------------ |
| decided from the customer's plans | `TARGETING_MATCH`                                |
| served from a stale snapshot      | `STALE`                                          |
| engine fallback (`fallback`)      | `DEFAULT`                                        |
| unknown feature                   | default value, `ERROR` + `FLAG_NOT_FOUND`        |
| missing `targetingKey`            | default value, `ERROR` + `TARGETING_KEY_MISSING` |
| wrong type for the feature        | default value, `ERROR` + `TYPE_MISMATCH`         |
| engine threw                      | default value, `ERROR` + `GENERAL`               |

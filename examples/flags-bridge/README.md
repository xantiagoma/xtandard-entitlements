# Flags bridge × @xtandard/entitlements

One gate for "is the rollout on for this customer?" **and** "does their plan include it?"
([ADR 0008](../../docs/ADR/0008-flags-bridge.md), [OpenFeature guide](../../docs/OPENFEATURE.md)).
A script, no server ([`src/demo.ts`](./src/demo.ts)).

## What's here

- **`createEntitlementsHook(ent)`** — an OpenFeature hook: every evaluation's context gains `plan`,
  `plans`, `subscription.status` and `entitlement.<feature>[.limit|.used|.remaining|.value]`, so
  `@xtandard/flags` rules can target them:

  | Flag             | Rule                                    |
  | ---------------- | --------------------------------------- |
  | `new-export-ui`  | `entitlement.export_pdf equals true`    |
  | `support-widget` | `plan in ["business"]` → `"chat"`       |
  | `trial-banner`   | `subscription.status equals "trialing"` |

- **`createEntitlementsProvider(ent)`** — entitlements _as_ OpenFeature flags: the flag key is a
  feature key, the targeting key the customer. Booleans resolve to `allowed`, numbers to
  `remaining` (or a numeric value feature); `variant` is the decision reason and `flagMetadata`
  carries `unlockedBy`.
- **`entitlementsContext(ent, { usage: false })`** — the same flat attributes for any other flags
  SDK, straight from the memory-first snapshot.

The flags themselves are published to an in-memory `@xtandard/flags` panel
(`@xtandard/flags/testing`) to keep the demo self-contained; in production they live in your flags
panel and the provider reads its runtime storage.

## Run it

```bash
bun run examples:flags-bridge --demo   # from the repo root; exits 0
```

The demo evaluates the three flags for every seeded customer, upgrades one to Business and shows
the flags flip with no flag edit, then reads features through the entitlements provider.

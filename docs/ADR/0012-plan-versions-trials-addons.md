# ADR 0012 — Plan Versions (Grandfathering), Trials, Add-ons and Plan Groups

**Status:** Accepted ★

---

## Context

Changing a plan's limits must not silently change what existing customers bought (Stigg/Autumn
"plan versioning"). Trials, add-ons and "one base plan at a time" are table stakes.

## Decision

- **Versions.** `plan({ version: 2, features, previous: { 1: { features, providers } } })`. A
  subscription pins `version` when created; resolution uses that version's features. Provider price
  ids may be attached per version, so a webhook for an old price lands on the old version. Migration
  is explicit: `ent.migratePlan(customer | "*", plan, toVersion)`.
- **Groups.** Plans belong to a `group` (default `"base"`); a customer has at most one entitled base
  subscription per group (the newest wins, the others are reported as conflicts in the admin). One plan
  per group may be `default: true` — it applies when the group has no entitled subscription.
- **Add-ons.** `addon({ features, quantity: true, requires?: [planKeys] })` stack on top: numeric
  features add `add × quantity`; boolean features enable. An add-on whose `requires` is unmet does not
  apply (reported in the admin).
- **Trials.** `plan({ trial: { days } })`; `ent.startTrial(customer, plan)` creates a `trialing`
  subscription with `trialEndsAt` (provider trials arrive the same way via webhooks). A trial past
  `trialEndsAt` without conversion is not entitled — no cron needed (ADR 0003). One trial per plan per
  customer (`state.trials`), overridable.
- **Merging limits.** For a feature: base plan value, plus add-ons, plus recurring grants; `null`
  (unlimited) dominates; override replaces the merged result.

## Consequences

- Repricing is safe by default; migrating customers is a deliberate act with an audit trail.

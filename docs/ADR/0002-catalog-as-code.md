# ADR 0002 — Catalog as Code: Zero-Dependency, Typed, Shared Everywhere

**Status:** Accepted ★ (new; flags stores its configuration in storage and edits it in the UI)

---

## Context

Every product in the landscape needs one list of _features_, _plans_ and _limits_. Stigg and
Schematic keep it in their dashboards; PayKit and byo-oss keep it in code (`plan()` / `feature()`,
`/catalog` importing nothing). A plan catalog is product logic: it changes with releases, needs code
review, must be type-checked against `check("export_pdf")` call sites, and must render identically on
the server, in the browser and on the public pricing page.

## Decision

The catalog is **TypeScript code**, declared with `defineCatalog({ features, plans, addons })` and the
builders `feature.boolean | metered | capacity | value | credits`, `plan()` and `addon()`, exported from
`@xtandard/entitlements/catalog` with **zero dependencies**.

- Feature keys, plan keys and value types are inferred: `ent.check(customer, "exprot_pdf")` is a type
  error; `check(customer, "max_upload_mb").value` is `number`.
- `defineCatalog` validates the structure at definition time (unknown feature referenced by a plan,
  two default plans in one group, metered feature without a reset, …) and throws `CatalogError` with
  every problem listed.
- `pricingTable(catalog)` returns a JSON-safe, display-ready structure (plans in order, per-feature
  cells, prices, trials) for marketing pages and `<PricingTable>`; the server also serves it at
  `GET {basePath}/api/pricing`.
- The admin UI shows the catalog **read-only**. Per-customer exceptions are _overrides_ and _grants_
  (state), not catalog edits.
- Prices on plans are **display metadata**; the provider stays the source of truth for money (ADR 0015).

## Consequences

- Catalog changes ship through the normal deploy pipeline (diffable, reviewable, testable).
- Changing a live plan's limits is a new plan **version** when existing customers must keep the old
  terms (ADR 0012).
- No UI for creating plans. Acceptable: that is the Stigg/Schematic business we are not copying.

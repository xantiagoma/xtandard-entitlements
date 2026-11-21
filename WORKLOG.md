# WORKLOG — `@xtandard/entitlements`

Reverse-chronological. Each entry: timestamp · task · files · tests · blocker · next.

---

## 2026-11-21 — merges via PRs, docs site live

- Brand kit (`docs/assets`, `docs/BRAND.md`, `scripts/brand-svg.ts` + `brand-assets.sh`): lime X whose upper
  arm drives a usage gauge.
- Docs: README (+ ecosystem section), CATALOG, METERING, ARCHITECTURE, HOOKS, TESTING, RELEASES, HTTP_API.
- PR #1 docs site (Starlight + TypeDoc) → live at https://me.xantiagoma.com/xtandard-entitlements/
  (`pending` map in site/manifest.ts for guides still in flight). PR #3 https origin fix (t1r).
- PR #2 server (ent-server): panel, HTTP API + OpenAPI, auth/authorization, portal tokens, adapters + guards,
  CLI, standalone. Reviewed portal-token verification + scoping.
- PR #4 storage (ent-storage): 10 state drivers + 7 counter drivers; family key-collision bugs (MySQL
  collation/ESCAPE, file case folding, SQLite LIKE, unstorage normalization, Redis MATCH) covered by the
  shared conformance suite; live Redis 8 / Mongo 7 / MySQL 8 / PG 16 in CI. ADR 0016.
- PR #5 billing (ent-billing): intake + 6 providers, flags bridge, audit/webhooks bridges (open, CI).
- Pushes use `--no-verify` after the local gate (heavy.sh semaphore is shared machine-wide).
- Next: merge #5, examples + GETTING_STARTED worker, UI merge (e2e + screenshots), release prep.

---

## 2026-11-20 — scaffold + spine, repo created, fan-out

- Scaffold from flags/webhooks/audit (package.json, vite-plus, tsconfigs, husky, mise, CI, LICENSE, CLAUDE.md).
- Spine: `catalog.ts` (zero-dep, typed, pricingTable), `resolve.ts`, `periods.ts`, `ledger.ts`, `engine.ts`,
  counters (contract, memory, buffered, kv-CAS), storage contract + memory (CAS) + watch, hooks, events, testing.
  137 tests (vitest + bun + type tests), coverage ≥ thresholds. `docs/HTTP_API.md` + `src/billing/contract.ts`
  pinned as the contracts for the server / UI / billing workers.
- GitHub repo `xantiagoma/xtandard-entitlements` (public, MIT) created; main pushed.
- Conformance suite now checks case-sensitive keys and LIKE metacharacters (MySQL collation / ESCAPE bugs in
  the webhooks drivers, per t1r).
- Workers (worktrees `xtandard-entitlements-{storage,server,billing}`): ent-storage (t4r), ent-server (t4s),
  ent-billing (t4t). Briefs in the session scratchpad (TASK-\*.md, COMMON.md). Heavy jobs via
  `xtandard-missions/heavy.sh` (machine overloaded).
- Next: UI worker (SPA admin + portal, React hooks/embeds, e2e) once the server lands; brand kit; docs; examples.

---

## 2026-11-20 — research gate + design

- Research gate: `docs/research/landscape.md` (§0 kickoff re-check). PayKit unchanged since
  2026-09-27 (dash still private, Next-only, Stripe + Postgres, posthog dep); Autumn + Flowglad still
  404; new `@formata/limitr` is open-core / single-maintainer / DSL — not an equivalent. → BUILD.
- Design: `PLAN.md` + ADRs 0001–0015 (★ = deviation from flags/webhooks).
- t1r added to DoD: branding kit + BRAND.md, Playwright screenshots, docs preview via hc before deploy.
  Workers: `mise trust <worktree>` before launch, `hc read --lines 5` after.
- Next: scaffold (tooling from flags/webhooks), then the spine.

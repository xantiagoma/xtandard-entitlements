# WORKLOG — `@xtandard/entitlements`

Reverse-chronological. Each entry: timestamp · task · files · tests · blocker · next.

---

## 2026-11-21 — release-ready

- PR #19 examples/react-app (hooks, gates, pricing table, embedded portal; SSR + build demo) and the
  GETTING_STARTED React section. PR #20 `chore(release): v0.1.0` (version + CHANGELOG; no tag pushed).
- Final gate on main: check, 777 vitest, 62 bun, 23 Playwright e2e, build, publint, pack (520 files,
  1.1 MB), consumer smoke of the tarball (ESM, CJS, bundled UI, Hono adapter, CLI). CI + Pages green.
- READY TO PUBLISH sent to t1r: first publish by hand, then trusted publishing (docs/RELEASES.md).
- Remote branches cleaned; all workers stopped.

---

## 2026-11-21 — billing, examples, UI merged; brand rules

- PR #5 billing + flags bridge + audit/webhooks bridges; PR #9 examples (10 runnable, demos) + GETTING_STARTED
  (ADR 0017); PR #17 admin UI + customer portal + /react + /react/embed, Playwright e2e (CI job added),
  12 light/dark screenshots.
- Engine fixes from the examples worker: #8 billing_period without a base subscription = UTC calendar months
  (never-written customers reset every call); #10 default counters = KV over CAS storage (memory lost usage
  on restart) + Next.js uiDir docs.
- Brand per the user: #11 SVG only on pages (PNG logos deleted), #13/#14 no tile on pages (hero = stacked
  lockups light/dark like audit), #15/#16 horizontal-lockup centring = shared family rule
  (baseline − capHeight/2). #12 audit + links in the ecosystem table.
- Lesson: `gh pr merge --delete-branch` removes the local branch and its worktree metadata; a worker still
  in that worktree is left in a dead directory — relaunch workers on fresh worktrees after merging.
- Next: react-app example (ent-react-app), final gate, v0.1.0 prep, READY TO PUBLISH, final report.

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

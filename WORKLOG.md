# WORKLOG — `@xtandard/entitlements`

Reverse-chronological. Each entry: timestamp · task · files · tests · blocker · next.

---

## 2026-11-20 — research gate + design

- Research gate: `docs/research/landscape.md` (§0 kickoff re-check). PayKit unchanged since
  2026-09-27 (dash still private, Next-only, Stripe + Postgres, posthog dep); Autumn + Flowglad still
  404; new `@formata/limitr` is open-core / single-maintainer / DSL — not an equivalent. → BUILD.
- Design: `PLAN.md` + ADRs 0001–0015 (★ = deviation from flags/webhooks).
- t1r added to DoD: branding kit + BRAND.md, Playwright screenshots, docs preview via hc before deploy.
  Workers: `mise trust <worktree>` before launch, `hc read --lines 5` after.
- Next: scaffold (tooling from flags/webhooks), then the spine.

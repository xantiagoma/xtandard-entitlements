# @xtandard/entitlements

Embeddable entitlements, plans and usage-metering engine (catalog in code, memory-first checks,
atomic counters, any billing provider / storage / framework, admin UI + customer portal). One npm
package with subpath exports (`src/entry-*.ts`, mapped in `package.json` `exports`). Bun for tooling;
`vp` (vite-plus) for build, test, lint and format. Before committing: `bun run format` (oxfmt also
formats `.md`) and `bun run check` (lint + format check + typecheck); `bun run test` is the gate.

- Plan, phases and ADR index: `PLAN.md`; decisions: `docs/ADR/`; progress: `WORKLOG.md`.
  `MISSION.md` is the brief — never edit it.
- Mirrors `xtandard-flags` / `xtandard-webhooks` (layout, naming, drivers, server, UI, docs, CI).
  Record any deviation in an ADR.
- New subpath = four edits: `src/entry-*.ts`, `vite.config.ts` `pack.entry`, `package.json`
  `exports`, `examples/tsconfig.json` `paths`. Each entry file starts with a `@module <subpath>`
  doc comment (the API reference uses it).
- `src/catalog.ts` must stay zero-dependency (browser / edge / marketing pages import it).
- Hot paths (`check`, `consume`) never read state storage when the customer is cached, and a
  refused `consume` must never change a counter (ADR 0005).
- Tests: `test/*.test.ts` (vitest), `test/*.bun.test.ts` (bun:sqlite), `test/*.test-d.ts` (types),
  storage + counter conformance suites (`test/storage-contract.ts`, `test/counter-contract.ts`)
  run against every driver; live Redis/Mongo/Postgres tests skip when `REDIS_URL` / `MONGO_URL` /
  `POSTGRES_URL` are unset.

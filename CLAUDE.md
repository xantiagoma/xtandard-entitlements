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
- The shared infrastructure (storage drivers, auth, server plumbing and router, adapters, CLI
  plumbing, UI shell, build/site tooling, workflows) is `@xtandard/kit`; this repo keeps thin
  wrappers that pass the entitlements defaults (table names, realm, `entpt_`, 423, ids). Fix
  shared bugs in the kit, not here. The counters (`src/counters/*`) are product code on the kit's
  `storage/*/internals`.
- New subpath = four edits: `src/entry-*.ts`, `vite.config.ts` `pack.entry`, `package.json`
  `exports`, `examples/tsconfig.json` `paths`. Each entry file starts with a `@module <subpath>`
  doc comment (the API reference uses it).
- `src/catalog.ts` must stay zero-dependency (browser / edge / marketing pages import it).
- Hot paths (`check`, `consume`) never read state storage when the customer is cached, and a
  refused `consume` must never change a counter (ADR 0005).
- Tests: `test/*.test.ts` (vitest), `test/*.bun.test.ts` (bun:sqlite), `test/*.test-d.ts` (types),
  storage + counter conformance suites (`test/storage-contract.ts` runs `@xtandard/kit`'s on every
  wrapped driver, `test/counter-contract.ts`) run against every driver; live Redis/Mongo/Postgres tests skip when `REDIS_URL` / `MONGO_URL` /
  `POSTGRES_URL` are unset.

## Docs Site

`site/` is an Astro Starlight site (own `package.json`/lockfile, not published) deployed by
`.github/workflows/pages.yml` to https://me.xantiagoma.com/xtandard-entitlements/.

- `README.md` and `docs/*.md` (ADRs included) are the source of truth (they render on GitHub/npm).
  `site/scripts/sync.ts` copies them into `site/src/content/docs/` (generated, gitignored), splitting
  README sections into pages by H2 per `site/manifest.ts` — **renaming a README H2 the manifest lists,
  or adding/renaming a file in `docs/`, needs `site/manifest.ts` updated** (sync fails loudly).
  A page marked `pending: true` is a guide that hasn't landed yet (left out until its file exists).
  The site tooling is `@xtandard/kit/site` (`defineSiteManifest`, `runSync`, `defineXtandardSite`).
- The API reference is generated from `src/` by starlight-typedoc, one module per `exports` entry;
  each entry file starts with a `@module <name>` doc comment.
- `bun run docs:dev` / `docs:build` / `docs:preview` (port 4324). The build fails on broken links.

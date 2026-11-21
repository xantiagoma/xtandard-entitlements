# ADR 0017 — Examples Run from Source, Each with a Demo

**Status:** Accepted

---

## Context

The siblings' examples (`xtandard-flags`, `xtandard-webhooks`) depend on the package via
`file:../..`, and their runner (`scripts/example.ts`) requires `bun run build` and runs
`bun install` in each example on first use. `bun install` _copies_ the package, `dist/` included,
so an example keeps running the build it was installed with until it is reinstalled, and each
install duplicates the framework packages the repo already has. Their examples are also
interactive servers: nothing checks in CI that they still work against the current code.

## Decision

- **Same layout and runner** as the siblings: `examples/<name>/` with its own `package.json`
  (`"@xtandard/entitlements": "file:../.."`) and README, `scripts/example.ts`,
  `bun run examples:<name>`, a free port via `get-port-please`, `typecheck:examples`.
- **In the repo, examples run from source.** `examples/tsconfig.json` maps every
  `@xtandard/entitlements/*` specifier to `src/` — Bun honors tsconfig `paths` at runtime, so the
  same file that makes them typecheck makes them run — and framework packages resolve from the root
  `node_modules`. No build, no per-example install. The admin UI is still the built `dist/ui`
  bundle (the APIs work without it). `test/examples.test.ts` keeps the map complete for every
  `exports` key.
- Exceptions: **`next`** installs Next.js into the example on its first interactive run (the root
  has no `next`) and points Turbopack and its own tsconfig at the source; **`elysia2`** runs with
  `bun --tsconfig-override=tsconfig.json` so `elysia` resolves to the root `elysia-v2` alias for
  both the example and the adapter source.
  **`react-app`** is a Vite app, and Vite does not read tsconfig `paths`: its `vite.config.ts`
  aliases the `@xtandard/entitlements/react*` imports to `src/` and builds the embed's Tailwind
  stylesheet from source, scoped as the package build scopes `dist/react.css` (only when it finds
  the repo's `src/`, so a copied-out app uses the installed package unchanged).
- **Every example has `src/demo.ts`**: a non-interactive, end-to-end script that exits 0 —
  in-process through `app.fetch` / `app.handle` where the framework allows, over a port-0 server
  otherwise. `bun run examples:<name> --demo` runs one; `bun run examples:demos` runs them all.
  Services that may be absent (Postgres, Redis) make a demo skip with a clear message, never fail.
- One catalog (`examples/shared/catalog.ts`) and one set of seeded customers are shared by every
  example; the server examples share one scenario (`examples/shared/scenario.ts`) so the adapters
  are shown to behave identically.

## Consequences

- Examples always exercise the code in the working tree; a breaking change shows up in
  `typecheck:examples` and in the demos, not after the next release.
- Copying an example out takes one more step than in the siblings (copy `shared/`, drop the in-repo
  tsconfig `paths`); each README says so.

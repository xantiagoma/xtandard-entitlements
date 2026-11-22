/**
 * Run a bundled example — its server on a free port, or its non-interactive demo.
 *
 *   bun run examples:hono              # the server, on a free PORT (or: elysia | express | …)
 *   bun run examples:hono --demo       # the end-to-end demo script; exits 0 on success
 *   bun run examples:demos             # every demo, one after another
 *
 * In this repo the examples run **from source**: examples/tsconfig.json maps every
 * `@xtandard/entitlements/*` import to src/ (Bun honors tsconfig `paths` at runtime)
 * and framework packages resolve from the root node_modules — no build, no install.
 * Only examples that need packages the root doesn't have (`next`) are installed, on
 * first use. Server examples get a free PORT; the admin UI they serve comes from
 * dist/ui (build it once with `bun run build` to see the panel). The runner is
 * `@xtandard/kit/build`'s `createExampleRunner`; this file is the table.
 *
 * @module
 */

import { createExampleRunner, type ExampleConfig } from "@xtandard/kit/build";

export type { ExampleConfig };

// Elysia 2: `elysia` must resolve to the root `elysia-v2` alias for the example AND
// the adapter source, so the run swaps in the example's tsconfig for the whole program.
const ELYSIA2 = ["bun", "--tsconfig-override=tsconfig.json"];

export const EXAMPLES: Record<string, ExampleConfig> = {
  hono: {
    dir: "examples/hono",
    kind: "server",
    run: ["bun", "src/index.ts"],
    demo: ["bun", "src/demo.ts"],
    preferredPort: 3000,
    panelPath: "/billing",
  },
  elysia: {
    dir: "examples/elysia",
    kind: "server",
    run: ["bun", "src/index.ts"],
    demo: ["bun", "src/demo.ts"],
    preferredPort: 3000,
    panelPath: "/billing",
  },
  elysia2: {
    dir: "examples/elysia2",
    kind: "server",
    run: [...ELYSIA2, "src/index.ts"],
    demo: [...ELYSIA2, "src/demo.ts"],
    preferredPort: 3000,
    panelPath: "/billing",
    note: "Elysia 2 (RC): typed plugin + Eden treaty client",
  },
  express: {
    dir: "examples/express",
    kind: "server",
    run: ["bun", "src/index.ts"],
    demo: ["bun", "src/demo.ts"],
    preferredPort: 3000,
    panelPath: "/billing",
  },
  bun: {
    dir: "examples/bun",
    kind: "server",
    run: ["bun", "src/index.ts"],
    demo: ["bun", "src/demo.ts"],
    preferredPort: 3000,
    panelPath: "/billing",
  },
  next: {
    dir: "examples/next",
    kind: "server",
    run: ["bun", "run", "dev"],
    demo: ["bun", "src/demo.ts"],
    install: "run",
    preferredPort: 3000,
    panelPath: "/billing",
    note: "Next.js App Router (next dev, installed on first run) — --demo calls the route handlers under Bun",
  },
  "react-app": {
    dir: "examples/react-app",
    kind: "server",
    run: ["bun", "src/start.ts"],
    demo: ["bun", "src/demo.ts"],
    preferredPort: 5190,
    note: "a Vite React app (hooks, gates, meters, pricing + an embedded <CustomerPortal>) — starts its API server too",
  },
  "stripe-webhooks": {
    dir: "examples/stripe-webhooks",
    kind: "server",
    run: ["bun", "src/index.ts"],
    demo: ["bun", "src/demo.ts"],
    preferredPort: 3000,
    panelPath: "/billing",
    note: "signed Stripe events, no network — POST them with `bun src/send.ts` or run --demo",
  },
  "ai-credits": {
    dir: "examples/ai-credits",
    kind: "script",
    run: ["bun", "src/demo.ts"],
    demo: ["bun", "src/demo.ts"],
    note: "reserve / settle LLM tokens against an AI-credit pool; thresholds via onThreshold",
  },
  "flags-bridge": {
    dir: "examples/flags-bridge",
    kind: "script",
    run: ["bun", "src/demo.ts"],
    demo: ["bun", "src/demo.ts"],
    note: "@xtandard/flags rules targeting `plan` / `entitlement.*` through an OpenFeature hook",
  },
  "postgres-redis": {
    dir: "examples/postgres-redis",
    kind: "script",
    run: ["bun", "src/demo.ts"],
    demo: ["bun", "src/demo.ts"],
    note: "needs Postgres + Redis (docker compose up -d in the example dir); skips cleanly without them",
  },
  "storage-drivers": {
    dir: "examples/storage-drivers",
    kind: "script",
    run: ["bun", "src/demo.ts"],
    demo: ["bun", "src/demo.ts"],
    note: "one scenario over memory / file / sqlite / kv-CAS counters",
  },
};

const runner = createExampleRunner(EXAMPLES);

/** Run one example (`demo` = the non-interactive demo). Resolves with the exit code. */
export const runExample = runner.runExample;

if (import.meta.main) process.exit(await runner.main(process.argv.slice(2)));

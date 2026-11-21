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
 * first use. Server examples get a free PORT via get-port-please; the admin UI they
 * serve comes from dist/ui (build it once with `bun run build` to see the panel).
 *
 * @module
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { getPort } from "get-port-please";

/** How one example is run. */
export interface ExampleConfig {
  dir: string;
  kind: "server" | "script";
  /** Command for the interactive run (in the example dir). */
  run: string[];
  /** Command for the non-interactive demo (in the example dir). Exits 0 on success. */
  demo: string[];
  /** `bun install` the example on first use (deps the repo root doesn't have). */
  install?: "always" | "run";
  /** Preferred port for server examples; a nearby free one is used if taken. */
  preferredPort?: number;
  /** Path the admin panel is mounted at, for the printed URL. */
  panelPath?: string;
  /** External requirement or hint to surface before running. */
  note?: string;
}

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

/** Run `cmd` in `cwd`, inheriting stdio; resolve with its exit code. */
async function sh(cmd: string[], cwd: string, env?: Record<string, string>): Promise<number> {
  const proc = Bun.spawn(cmd, {
    cwd,
    env: { ...process.env, ...env },
    stdout: "inherit",
    stderr: "inherit",
  });
  const cleanup = () => proc.kill();
  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);
  return proc.exited;
}

/** Install the example's own dependencies when it needs some and has none yet. */
async function ensureInstalled(name: string, cfg: ExampleConfig, demo: boolean): Promise<number> {
  const needed = cfg.install === "always" || (cfg.install === "run" && !demo);
  if (!needed || existsSync(join(cfg.dir, "node_modules"))) return 0;
  console.log(`Installing ${name} dependencies …`);
  return sh(["bun", "install"], cfg.dir);
}

/** Run one example (`demo` = the non-interactive demo). Resolves with the exit code. */
export async function runExample(name: string, demo: boolean): Promise<number> {
  const cfg = EXAMPLES[name]!;
  if (cfg.note) console.log(`ℹ︎  ${name}: ${cfg.note}`);
  const installed = await ensureInstalled(name, cfg, demo);
  if (installed !== 0) return installed;

  if (demo) return sh(cfg.demo, cfg.dir);

  const env: Record<string, string> = {};
  if (cfg.kind === "server") {
    if (!existsSync("dist/ui")) {
      console.log(
        "ℹ︎  dist/ui is missing — the API works, but build once to see the admin UI: bun run build",
      );
    }
    const preferred = cfg.preferredPort ?? 3000;
    const port = await getPort({ port: preferred, portRange: [preferred, preferred + 200] });
    env.PORT = String(port);
    console.log(`▶  ${name} → http://localhost:${port}${cfg.panelPath ?? ""}`);
  }
  return sh(cfg.run, cfg.dir, env);
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const demo = args.includes("--demo");
  const name = args.find((a) => !a.startsWith("--"));

  if (name === "all") {
    // Every demo, sequentially (they share nothing, but sequential output reads better).
    const failed: string[] = [];
    for (const key of Object.keys(EXAMPLES)) {
      console.log(`\n━━━ ${key} ━━━`);
      if ((await runExample(key, true)) !== 0) failed.push(key);
    }
    if (failed.length) console.error(`\nFailed demos: ${failed.join(", ")}`);
    process.exit(failed.length ? 1 : 0);
  }

  if (!name || !EXAMPLES[name]) {
    console.error(
      `Unknown example "${name ?? ""}". Available: ${Object.keys(EXAMPLES).join(", ")} (or "all" with --demo)`,
    );
    process.exit(1);
  }
  process.exit(await runExample(name, demo));
}

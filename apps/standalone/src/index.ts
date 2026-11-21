/**
 * Standalone `@xtandard/entitlements` server — what the Docker image runs.
 *
 * Delegates to the CLI's `serve` command (panel + HTTP API + customer portal,
 * all configured via environment variables, `/healthcheck` included),
 * overriding only the defaults: containers default to `memory` storage
 * (ephemeral demo mode) where the bare CLI defaults to `file`, and to the
 * bundled example catalog when `CATALOG_PATH` is unset. Mount your own
 * catalog module and point `CATALOG_PATH` at it for real use.
 */

// In-repo app: imports the library from source (Bun runs TS directly), so the
// Docker image needs no compiled lib — only the UI bundle (dist/ui).
process.env.STORAGE_DRIVER ||= "memory";
if (!process.env.CATALOG_PATH) {
  process.env.CATALOG_PATH = new URL("./catalog.example.ts", import.meta.url).pathname;
  console.warn(
    "[xtandard/entitlements] CATALOG_PATH is unset — serving the bundled example catalog.",
  );
}

const { run } = await import("../../../src/cli.ts");

run(["serve"]).then(
  (code) => process.exit(code),
  (err) => {
    console.error("[xtandard/entitlements] failed to start:", err);
    process.exit(1);
  },
);

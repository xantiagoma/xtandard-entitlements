/**
 * The examples' wiring stays complete: every package.json export resolves to
 * source in the examples' tsconfig `paths` (what lets them typecheck and run
 * without a build), and every example folder is runnable through
 * scripts/example.ts with a README and a demo. The demos themselves run via
 * `bun run examples:demos`.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import ts from "typescript";
import { describe, expect, test } from "vitest";
import { EXAMPLES } from "../scripts/example.ts";

const root = resolve(import.meta.dirname, "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
  exports: Record<string, unknown>;
  scripts: Record<string, string>;
};

/** Every import specifier the package exports (CSS and package.json aside). */
const specifiers = Object.keys(pkg.exports)
  .filter((key) => key !== "./package.json" && !key.endsWith(".css"))
  .map((key) => `@xtandard/entitlements${key.slice(1)}`);

function pathsOf(tsconfig: string): Record<string, string[]> {
  const file = join(root, tsconfig);
  const { config, error } = ts.parseConfigFileTextToJson(file, readFileSync(file, "utf8"));
  expect(error).toBeUndefined();
  return (config as { compilerOptions: { paths: Record<string, string[]> } }).compilerOptions.paths;
}

describe.each(["examples/tsconfig.json", "examples/elysia2/tsconfig.json"])("%s", (tsconfig) => {
  const paths = pathsOf(tsconfig);

  test("maps every package.json export", () => {
    expect(specifiers.filter((s) => !paths[s])).toEqual([]);
  });

  test("every mapping points at an existing source file", () => {
    const missing = Object.entries(paths)
      .filter(([s]) => s.startsWith("@xtandard/entitlements"))
      .filter(([, [target]]) => !existsSync(join(root, dirname(tsconfig), target!)));
    expect(missing).toEqual([]);
  });
});

describe("example runner", () => {
  const dirs = readdirSync(join(root, "examples"), { withFileTypes: true })
    .filter((d) => d.isDirectory() && d.name !== "shared" && d.name !== "node_modules")
    .map((d) => d.name);

  test("every example folder is registered, and every registration exists", () => {
    expect(
      Object.values(EXAMPLES)
        .map((e) => e.dir.replace("examples/", ""))
        .sort(),
    ).toEqual([...dirs].sort());
  });

  test.each(Object.entries(EXAMPLES))(
    "%s: package.json, README, demo, root script",
    (name, cfg) => {
      for (const file of ["package.json", "README.md", "src/demo.ts"]) {
        expect(existsSync(join(root, cfg.dir, file)), `${cfg.dir}/${file}`).toBe(true);
      }
      expect(pkg.scripts[`examples:${name}`]).toBe(`bun scripts/example.ts ${name}`);
      const examplePkg = JSON.parse(readFileSync(join(root, cfg.dir, "package.json"), "utf8"));
      expect(examplePkg.dependencies["@xtandard/entitlements"]).toBe("file:../..");
    },
  );
});

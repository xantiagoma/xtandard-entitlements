import { readFile } from "node:fs/promises";
import { runEmbedCssSuite } from "@xtandard/kit/build";
import { describe, expect, it } from "vitest";

// The embed stylesheet's scoping (`xtandard-kit scope-embed-css`): every rule
// under `.xtandard-entitlements`, root tokens re-homed on the wrapper, no
// preflight leaking into the host — and the built dist/react.css too, when present.
runEmbedCssSuite(
  { describe, it, expect },
  {
    scope: ".xtandard-entitlements",
    readBuiltCss: () => readFile("dist/react.css", "utf8").catch(() => undefined),
  },
);

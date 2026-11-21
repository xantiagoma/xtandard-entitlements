// The example imports ../shared and (in this repo) the package source, both outside
// this folder, so Turbopack's root is the repository. Copied out of the repo, delete
// `turbopack.root` and the `paths` in tsconfig.json.
import { fileURLToPath } from "node:url";

/** @type {import("next").NextConfig} */
const config = {
  turbopack: { root: fileURLToPath(new URL("../..", import.meta.url)) },
  agentRules: false, // don't generate AGENTS.md
};

export default config;

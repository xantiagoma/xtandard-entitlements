// Pre-build step: writes src/content/docs/ (generated, gitignored) from the repository's Markdown,
// and copies the brand files the site serves as-is (favicons, the social card) from docs/assets/
// into public/, per manifest.ts (see `syncSite` in @xtandard/kit/site).
//
//   bun scripts/sync.ts
import { runSync } from "@xtandard/kit/site";
import { manifest } from "../manifest.ts";

process.exit(runSync(manifest));

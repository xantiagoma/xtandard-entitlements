// The documentation site, built with @xtandard/kit/site: Starlight over the repository's Markdown
// (scripts/sync.ts copies it into src/content/docs/ first), the header lockups, favicons and social
// card from docs/assets/, a TypeDoc API reference with one module per `exports` entry, Mermaid
// diagrams and the links validator (a broken internal link fails the build). manifest.ts holds the
// information architecture. `bun run build` writes dist/ here; .github/workflows/pages.yml
// publishes it.
import { defineXtandardSite } from "@xtandard/kit/site";
import { manifest } from "./manifest.ts";

export default await defineXtandardSite({
  manifest,
  description:
    "Embeddable entitlements, plans and usage metering for TypeScript: a typed catalog in code, atomic metering, any billing provider, any storage, any framework.",
  // The README tagline, used as the social card's alt text.
  tagline: "Plans, entitlements and usage metering for TypeScript apps — as a library",
  // Symbols several entry points export are documented under the first owner TypeDoc meets: the
  // root re-exports the catalog, so /catalog comes first and the root owns the rest (engine,
  // resolver, contracts, schema).
  apiOwners: ["src/catalog.ts", "src/index.ts"],
  devPort: 4324,
});

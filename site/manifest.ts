// The site's information architecture: which repository Markdown becomes which page, and the
// sidebar tree (see `defineSiteManifest` in @xtandard/kit/site). scripts/sync.ts and
// astro.config.ts both read it, so a page and its sidebar entry cannot drift.
//
// The Markdown in the repository (README.md, docs/*.md) stays the single source of truth: it is
// what GitHub and npm render. A page is one of:
//   - a whole repository file (`src`);
//   - some H2 sections of one (`src` + `sections`, optionally `intro` for the text above the first
//     H2) — how README.md is split into several pages;
//   - a page written for the site only (`site`, relative to site/content/).
// A page marked `pending: true` is a guide that hasn't landed yet: while its `src` is missing the
// page and its sidebar entry are left out and links to it point at GitHub.
// The origin and base come from SITE_ORIGIN / SITE_BASE when pages.yml sets them.
import { fileURLToPath } from "node:url";
import { defineSiteManifest } from "@xtandard/kit/site";

const adrs: [file: string, label: string][] = [
  ["0001-single-package-subpath-exports.md", "0001 · Subpath exports"],
  ["0002-catalog-as-code.md", "0002 · Catalog as code"],
  ["0003-memory-first-snapshots.md", "0003 · Memory-first snapshots"],
  ["0004-state-storage-and-counter-ports.md", "0004 · State + counter ports"],
  ["0005-consumption-model.md", "0005 · Consumption model"],
  ["0006-write-behind-counters.md", "0006 · Write-behind counters"],
  ["0007-billing-provider-port.md", "0007 · Billing provider port"],
  ["0008-flags-bridge.md", "0008 · Flags bridge"],
  ["0009-decisions-and-denials.md", "0009 · Decisions & denials"],
  ["0010-ui-and-portal-tokens.md", "0010 · UI & portal tokens"],
  ["0011-react-hooks-and-embeds.md", "0011 · React hooks & embeds"],
  ["0012-plan-versions-trials-addons.md", "0012 · Versions, trials, add-ons"],
  ["0013-ecosystem-bridges.md", "0013 · Ecosystem bridges"],
  ["0014-periods-and-resets.md", "0014 · Periods & resets"],
  ["0015-non-goals.md", "0015 · Non-goals"],
  ["0016-storage-driver-deviations.md", "0016 · Storage driver deviations"],
  ["0017-examples-run-from-source.md", "0017 · Examples run from source"],
];

export const manifest = defineSiteManifest({
  repoRoot: fileURLToPath(new URL("../", import.meta.url)),
  repoSlug: "xantiagoma/xtandard-entitlements",
  packageName: "@xtandard/entitlements",
  // The root import's module name: `@xtandard/entitlements` is documented at /api/entitlements/.
  rootModule: "entitlements",
  base: "/xtandard-entitlements",
  home: { slug: "", site: "index.mdx" },
  sidebar: [
    {
      label: "Start here",
      items: [
        {
          slug: "getting-started",
          src: "docs/GETTING_STARTED.md",
          label: "Getting started",
        },
        {
          slug: "guides/why",
          src: "README.md",
          sections: ["Why another entitlements tool?"],
          title: "Why @xtandard/entitlements",
          label: "Why",
        },
        {
          slug: "guides/quickstart",
          src: "README.md",
          sections: ["Quickstart", "The catalog", "Checking and metering"],
          title: "Quickstart",
          label: "Quickstart",
        },
        {
          slug: "guides/subpath-exports",
          src: "README.md",
          sections: ["Subpath exports"],
          title: "Subpath exports",
          label: "Subpath exports",
        },
        {
          slug: "guides/examples",
          src: "README.md",
          sections: ["Examples"],
          title: "Examples",
          label: "Examples",
        },
      ],
    },
    {
      label: "Concepts",
      items: [
        { slug: "concepts/catalog", src: "docs/CATALOG.md", label: "Catalog" },
        { slug: "concepts/metering", src: "docs/METERING.md", label: "Metering" },
        { slug: "concepts/architecture", src: "docs/ARCHITECTURE.md", label: "Architecture" },
        { slug: "concepts/hooks", src: "docs/HOOKS.md", label: "Hooks & events" },
      ],
    },
    {
      label: "Integrations",
      items: [
        {
          slug: "integrations/billing",
          src: "docs/BILLING.md",
          label: "Billing providers",
        },
        {
          slug: "integrations/openfeature",
          src: "docs/OPENFEATURE.md",
          label: "Flags & OpenFeature",
        },
        {
          slug: "integrations/ecosystem",
          src: "docs/ECOSYSTEM.md",
          label: "Audit & webhooks",
        },
        {
          slug: "integrations/adapters",
          src: "docs/ADAPTERS.md",
          label: "Framework adapters",
        },
        { slug: "storage", src: "docs/STORAGE.md", label: "Storage & counters" },
      ],
    },
    {
      label: "UI & API",
      items: [
        { slug: "ui/admin", src: "docs/UI.md", label: "Admin UI & React" },
        {
          slug: "ui/screenshots",
          src: "README.md",
          sections: ["Screenshots"],
          title: "Screenshots",
          label: "Screenshots",
        },
        { slug: "ui/portal", src: "docs/PORTAL.md", label: "Customer portal" },
        { slug: "reference/http-api", src: "docs/HTTP_API.md", label: "HTTP API" },
        { slug: "security/auth", src: "docs/AUTH.md", label: "Authentication" },
        {
          slug: "security/authorization",
          src: "docs/AUTHORIZATION.md",
          label: "Authorization",
        },
      ],
    },
    {
      label: "Operations",
      items: [
        {
          slug: "operations/deployment",
          src: "docs/DEPLOYMENT.md",
          label: "Deployment",
        },
        { slug: "operations/testing", src: "docs/TESTING.md", label: "Testing" },
      ],
    },
    // starlight-typedoc's "API reference" group is inserted here by astro.config.ts.
    {
      label: "Project",
      items: [
        {
          slug: "project/ecosystem",
          src: "README.md",
          sections: ["The xtandard ecosystem"],
          title: "The xtandard ecosystem",
          label: "xtandard ecosystem",
        },
        { slug: "project/changelog", src: "CHANGELOG.md", label: "Changelog" },
        {
          slug: "project/research",
          src: "docs/research/landscape.md",
          label: "Landscape research",
        },
        { slug: "project/brand", src: "docs/BRAND.md", label: "Brand" },
        {
          label: "Architecture decisions",
          collapsed: true,
          items: adrs.map(([file, label]) => ({
            slug: `project/adr/${file.slice(0, 4)}`,
            src: `docs/ADR/${file}`,
            label,
          })),
        },
        { slug: "project/releases", src: "docs/RELEASES.md", label: "Releases", internal: true },
        { label: "npm", link: "https://www.npmjs.com/package/@xtandard/entitlements" },
      ],
    },
  ],
});

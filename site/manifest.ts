// The site's information architecture: which repository Markdown becomes which page, the sidebar
// tree, and the package's entry points. scripts/sync.ts reads it to write src/content/docs/, and
// astro.config.ts reads it to build the sidebar and the API reference, so a page and its sidebar
// entry cannot drift.
//
// The Markdown in the repository (README.md, docs/*.md) stays the single source of truth: it is
// what GitHub and npm render. A page is one of:
//   - a whole repository file (`src`);
//   - some H2 sections of one (`src` + `sections`, optionally `intro` for the text above the first
//     H2) — how README.md is split into several pages. Every H2 of a split file other than the
//     README must land on exactly one page, so a new section cannot silently disappear;
//   - a page written for the site only (`site`, relative to site/content/).
// Plain Node APIs only: Astro loads this file through Vite.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const repoRoot = fileURLToPath(new URL("../", import.meta.url));
export const repoSlug = "xantiagoma/xtandard-entitlements";
export const repoUrl = `https://github.com/${repoSlug}`;
export const packageName = "@xtandard/entitlements";
export const npmUrl = "https://www.npmjs.com/package/@xtandard/entitlements";
export const branch = "main";
/**
 * Where the site is served: the project site of xantiagoma.github.io, under the account's custom
 * domain. pages.yml passes what actions/configure-pages reports (SITE_ORIGIN, SITE_BASE), so a
 * domain change needs no code change.
 */
// actions/configure-pages reports the origin as http://; the site is served over https only.
export const siteOrigin = (process.env.SITE_ORIGIN || "https://me.xantiagoma.com").replace(
  /^http:\/\//,
  "https://",
);
export const siteBase = (process.env.SITE_BASE || "/xtandard-entitlements").replace(/\/+$/, "");

// ---- entry points ---------------------------------------------------------------------------

export type Entry = {
  /** The API reference module name (the `@module` tag of the entry file) and its route. */
  module: string;
  /** The import specifier users write. */
  importPath: string;
  /** The source file, relative to the repository root. */
  source: string;
};

/** The root import's module name: `@xtandard/entitlements` is documented at /api/entitlements/. */
export const rootModule = "entitlements";

/** Subpaths that are not TypeScript entry points (assets, the manifest). */
const nonCode = (key: string) =>
  key === "./package.json" || key.endsWith(".css") || key.includes("*");

/**
 * Every public entry point, in package.json `exports` order. The source file follows the build's
 * convention (vite.config.ts `pack.entry`): the root is src/index.ts, a few subpaths have their
 * own module (src/core.ts, src/react.tsx…), and the rest are src/entry-<path-with-dashes>.ts.
 */
export function entries(): Entry[] {
  const exportsMap = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"))
    .exports as Record<string, unknown>;
  return Object.keys(exportsMap)
    .filter((key) => !nonCode(key))
    .map((key) => {
      const sub = key.replace(/^\.\/?/, "");
      const entryFile = `src/entry-${sub.replaceAll("/", "-")}.ts`;
      const candidates =
        sub === ""
          ? ["src/index.ts"]
          : sub.includes("/")
            ? [entryFile]
            : [`src/${sub}.ts`, `src/${sub}.tsx`, entryFile];
      const source = candidates.find((f) => existsSync(join(repoRoot, f)));
      if (!source) throw new Error(`manifest.ts: no source entry for "${key}" in package.json`);
      return {
        module: sub === "" ? rootModule : sub,
        importPath: sub === "" ? packageName : `${packageName}/${sub}`,
        source,
      };
    });
}

// ---- pages ----------------------------------------------------------------------------------

export type Page = {
  /** Route without the base and without slashes; "" is the home page. */
  slug: string;
  /** Sidebar label; the page title when absent. */
  label?: string;
  /** Repository file the page is built from. */
  src?: string;
  /** Only these H2 sections of `src` (by heading text, in file order). */
  sections?: string[];
  /** With `sections`: also the H1 and the text above the first H2. */
  intro?: boolean;
  /** Page title when it does not come from the source's H1. */
  title?: string;
  /** Site-only page in site/content/ (.md or .mdx). */
  site?: string;
  /** Contributor-only material: a banner says so and search skips it. */
  internal?: boolean;
};
export type Link = { label: string; link: string };
export type Group = { label: string; collapsed?: boolean; items: Item[] };
export type Item = Page | Link | Group;

export const home: Page = { slug: "", site: "index.mdx" };

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
];

/** A guide page that only exists once its docs/*.md does (pages land as features merge). */
const optional = (page: Page): Page[] =>
  page.src && !existsSync(join(repoRoot, page.src)) ? [] : [page];

const allSidebar: Item[] = [
  {
    label: "Start here",
    items: [
      ...optional({
        slug: "getting-started",
        src: "docs/GETTING_STARTED.md",
        label: "Getting started",
      }),
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
      ...optional({
        slug: "integrations/billing",
        src: "docs/BILLING.md",
        label: "Billing providers",
      }),
      ...optional({
        slug: "integrations/openfeature",
        src: "docs/OPENFEATURE.md",
        label: "Flags & OpenFeature",
      }),
      ...optional({
        slug: "integrations/ecosystem",
        src: "docs/ECOSYSTEM.md",
        label: "Audit & webhooks",
      }),
      ...optional({
        slug: "integrations/adapters",
        src: "docs/ADAPTERS.md",
        label: "Framework adapters",
      }),
      ...optional({ slug: "storage", src: "docs/STORAGE.md", label: "Storage & counters" }),
    ],
  },
  {
    label: "UI & API",
    items: [
      ...optional({ slug: "ui/admin", src: "docs/UI.md", label: "Admin UI & React" }),
      ...optional({ slug: "ui/portal", src: "docs/PORTAL.md", label: "Customer portal" }),
      { slug: "reference/http-api", src: "docs/HTTP_API.md", label: "HTTP API" },
      ...optional({ slug: "security/auth", src: "docs/AUTH.md", label: "Authentication" }),
      ...optional({
        slug: "security/authorization",
        src: "docs/AUTHORIZATION.md",
        label: "Authorization",
      }),
    ],
  },
  {
    label: "Operations",
    items: [
      ...optional({
        slug: "operations/deployment",
        src: "docs/DEPLOYMENT.md",
        label: "Deployment",
      }),
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
      { slug: "project/research", src: "docs/research/landscape.md", label: "Landscape research" },
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
      { label: "npm", link: npmUrl },
    ],
  },
];

/** Drop groups left empty by `optional` pages that don't exist yet. */
const prune = (items: Item[]): Item[] =>
  items.flatMap((i) => {
    if (!("items" in i)) return [i];
    const kept = prune(i.items);
    return kept.length ? [{ ...i, items: kept }] : [];
  });

export const sidebar: Item[] = prune(allSidebar);

/**
 * Repository files that land with in-flight work: until a file exists, links to it point at the
 * closest existing page (a route without the base) instead of failing the build. An entry is
 * ignored as soon as its file exists, so this list can only shrink.
 */
export const pending: Record<string, string> = {
  "docs/STORAGE.md": "project/adr/0004",
  "docs/UI.md": "project/adr/0010",
  "docs/GETTING_STARTED.md": "guides/quickstart",
  "examples/README.md": "guides/examples",
};

export const isPage = (i: Item): i is Page => "slug" in i;
export const isGroup = (i: Item): i is Group => "items" in i;

/** Every page, the home page first. */
export function pages(): Page[] {
  const out: Page[] = [home];
  const walk = (items: Item[]) => {
    for (const i of items) {
      if (isPage(i)) out.push(i);
      else if (isGroup(i)) walk(i.items);
    }
  };
  walk(sidebar);
  return out;
}

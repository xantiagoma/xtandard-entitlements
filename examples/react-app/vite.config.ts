/**
 * Vite for the React example: two pages — `index.html` (your product UI, gated
 * with `@xtandard/entitlements/react`) and `portal.html` (a billing settings
 * page embedding `<CustomerPortal>` from `@xtandard/entitlements/react/embed`)
 * — with `/billing`, `/token` and `/api` proxied to the example server
 * (src/server.ts at `API_URL`; `bun run start` sets it).
 *
 * In this repo the `@xtandard/entitlements/react*` imports resolve to `src/`
 * (as the other examples' tsconfig `paths` do), so the embed's Tailwind
 * stylesheet is built here and scoped under `.xtandard-entitlements` the way
 * `bun run build` scopes `dist/react.css`. Copied out of the repo, `inRepo` is
 * false and the installed package's built files are used — nothing to change.
 */
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig, type Alias, type Plugin } from "vite";

const here = fileURLToPath(new URL(".", import.meta.url));
const repo = fileURLToPath(new URL("../..", import.meta.url));
const inRepo = existsSync(`${repo}src/entry-react-embed.ts`);
const API_URL = process.env.API_URL ?? "http://localhost:3000";

export default defineConfig(async () => ({
  plugins: [...(inRepo ? await fromSource() : []), react()],
  resolve: { alias: inRepo ? sourceAliases() : [] },
  server: {
    proxy: { "/billing": API_URL, "/token": API_URL, "/api": API_URL },
    ...(inRepo ? { fs: { allow: [repo] } } : {}),
  },
  build: {
    rollupOptions: { input: { main: `${here}index.html`, portal: `${here}portal.html` } },
  },
}));

/** In-repo only: the package's React entry points and stylesheets, from source. */
function sourceAliases(): Alias[] {
  const to = (find: string, path: string): Alias => ({
    find: new RegExp(`^@xtandard/entitlements/${find.replaceAll(".", "\\.")}$`),
    replacement: `${repo}${path}`,
  });
  return [
    to("react", "src/entry-react.ts"),
    to("react/embed", "src/entry-react-embed.ts"),
    to("react/components.css", "src/react/components.css"),
    // The embed source imports this stylesheet itself; both resolve to one module.
    to("react/styles.css", "src/ui/styles.css"),
  ];
}

/**
 * In-repo only: build the embed's Tailwind stylesheet from source. Tailwind
 * scans the Vite root (this example) by default, so the stylesheet also gets an
 * `@source` for the package's `src/`; after Vite compiles it, every rule is
 * scoped under `.xtandard-entitlements` (scripts/scope-embed-css.ts, as in the
 * package build).
 */
async function fromSource(): Promise<Plugin[]> {
  const { default: tailwindcss } = await import("@tailwindcss/vite");
  const { scopeCss } = await import("../../scripts/scope-embed-css.ts");
  const styles = `${repo}src/ui/styles.css`;
  const isStyles = (id: string) => id.split("?")[0] === styles;
  return [
    {
      name: "embed-styles:source",
      enforce: "pre",
      transform: (code, id) => (isStyles(id) ? `${code}\n@source "..";\n` : undefined),
    },
    ...tailwindcss(),
    {
      name: "embed-styles:scope",
      transform: async (code, id) => (isStyles(id) ? scopeCss(code) : undefined),
    },
  ];
}

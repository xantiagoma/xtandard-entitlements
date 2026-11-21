import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// Library build for `@xtandard/entitlements/react/embed` (<EntitlementsDashboard>,
// <CustomerPortal>). Emits dist/react-embed.js (ESM) + dist/react.css. React is a
// peer (external); everything else (TanStack Query, Base UI, styles) is bundled so
// the components are self-contained. emptyOutDir:false keeps the library + UI
// builds.
//
// The emitted dist/react.css is a full Tailwind build (preflight + utilities);
// `scripts/scope-embed-css.ts` runs after this build (see the `build:react`
// script) to scope every rule under `.xtandard-entitlements` so importing the
// stylesheet cannot leak into the host app.
//
// The small hooks package (`@xtandard/entitlements/react`, src/entry-react.ts) is
// built by `vp pack` with the rest of the library, not here.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    outDir: "dist",
    emptyOutDir: false,
    cssCodeSplit: false,
    lib: {
      entry: "src/entry-react-embed.ts",
      formats: ["es"],
      fileName: () => "react-embed.js",
    },
    rollupOptions: {
      external: ["react", "react-dom", "react/jsx-runtime", "react-dom/client"],
      output: { assetFileNames: "react.css" },
    },
  },
});

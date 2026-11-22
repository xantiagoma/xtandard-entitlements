import { defineEmbedConfig } from "@xtandard/kit/build";

// Library build for `@xtandard/entitlements/react/embed` (<EntitlementsDashboard>,
// <CustomerPortal>): dist/react-embed.js (ESM) + dist/react.css. React is a peer
// (external); everything else (TanStack Query, Base UI, the kit UI, styles) is
// bundled so the components are self-contained. The emitted dist/react.css is a
// full Tailwind build; `xtandard-kit scope-embed-css` runs after this build (see
// the `build:react` script) to scope every rule under `.xtandard-entitlements`.
//
// The small hooks package (`@xtandard/entitlements/react`, src/entry-react.ts) is
// built by `vp pack` with the rest of the library, not here.
export default defineEmbedConfig({ entry: "src/entry-react-embed.ts", fileName: "react-embed.js" });

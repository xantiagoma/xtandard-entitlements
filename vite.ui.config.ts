import { defineUiConfig } from "@xtandard/kit/build";

// Separate build for the bundled admin SPA + customer portal: src/ui → dist/ui
// (emptied first), served by the panel handler. `base: "./"` keeps asset URLs
// relative so the SPA works under any mount path (/billing, /admin, ...) via the
// injected <base> tag. `src/ui/public/` (favicon set) is copied as-is.
export default defineUiConfig();

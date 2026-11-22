/**
 * Theme preference: `system` (follows the OS), `light`, or `dark`. The
 * preference is persisted in localStorage; `system` live-updates when the OS
 * scheme changes.
 *
 * The standalone SPA writes the resolved theme to `<html data-theme>` (see
 * {@link initTheme}). The React embed never touches the host document: it puts
 * `data-theme` on its own wrapper, either from this preference (`theme="auto"`)
 * or from the host page's theme ({@link detectHostTheme}, `theme="inherit"`).
 */

import { createThemeStore } from "@xtandard/kit/ui";

export { detectHostTheme, type ResolvedTheme, type ThemePref } from "@xtandard/kit/ui";

/** The entitlements theme store (one per page, shared by the SPA and the embeds). */
export const themeStore = createThemeStore("xtandard-entitlements:theme");

/** Read and write the persisted preference. */
export const { getThemePref, setThemePref } = themeStore;

import { bootSpa } from "@xtandard/kit/ui";
import { App } from "./App.tsx";
import * as api from "./api.ts";
import { themeStore } from "./theme.ts";
import "./styles.css";

// The standalone SPA: the persisted theme on <html> before first paint,
// browser-history routing under the injected basePath, and the portal token
// from `#token=entpt_…` (or `?token=`) attached as a Bearer credential and
// removed from the address bar; `/config` then reports `mode: "portal"`.
bootSpa({
  App,
  configGlobal: "__ENTITLEMENTS_CONFIG__",
  themeKey: themeStore,
  tokenFromUrl: true,
  api,
});

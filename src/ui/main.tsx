import React from "react";
import { createRoot } from "react-dom/client";
import { useBrowserLocation } from "wouter/use-browser-location";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { App } from "./App.tsx";
import { setApiToken } from "./api.ts";
import { ToastProvider } from "./components/Toast.tsx";
import { initTheme } from "./theme.ts";
import { takeTokenFromUrl } from "./lib/token.ts";
import type { PanelConfig } from "./types.ts";
import "./styles.css";

// Apply the persisted theme before first paint.
initTheme();

// Standalone portal: `#token=entpt_…` (or `?token=`) in the URL attaches the
// portal token as a Bearer credential on every API request; `/config` then
// reports `mode: "portal"` and the shell renders the reduced customer chrome.
// The token is removed from the address bar so it isn't bookmarked or shared.
const token = takeTokenFromUrl(window.location, (url) =>
  window.history.replaceState(null, "", url),
);
if (token) setApiToken(token);

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
});

const root = document.getElementById("root");
if (!root) throw new Error("Root element not found");

// The bundled SPA owns its URL and the panel handler serves a SPA catch-all under
// the basePath, so use real browser-history routing for clean, deep-linkable paths.
const basePath = (
  (window as { __ENTITLEMENTS_CONFIG__?: PanelConfig }).__ENTITLEMENTS_CONFIG__?.basePath ?? ""
).replace(/\/$/, "");

createRoot(root).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <App locationHook={useBrowserLocation} base={basePath} />
      </ToastProvider>
    </QueryClientProvider>
  </React.StrictMode>,
);

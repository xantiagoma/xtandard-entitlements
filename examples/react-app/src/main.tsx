/** Entry of page 1 (index.html): the host bar and the gated workspace. */
import React from "react";
import { createRoot } from "react-dom/client";
import "@xtandard/entitlements/react/components.css"; // optional default styles
import "./styles.css";
import { App } from "./app.tsx";
import { HostBar, currentOrg } from "./host.tsx";

const org = currentOrg();
createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <HostBar org={org} page="app" />
    <App org={org} />
  </React.StrictMode>,
);

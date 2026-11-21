import { definePlaywrightConfig } from "@xtandard/kit/build";

/**
 * Browser e2e for the admin SPA, the customer portal and the React embeds.
 * Builds the library (the `/react` hooks entry), the UI bundle and the embed
 * (dist/react-embed.js + scoped react.css), then boots the e2e server — the
 * real panel over the seeded in-memory demo engine (see e2e/server.ts).
 *
 *   bun run test:e2e
 */
export default definePlaywrightConfig({
  port: 3411,
  serverCmd: "bun run build && bun e2e/server.ts",
  workers: 1,
  timeout: 300_000,
});

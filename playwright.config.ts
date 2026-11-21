import { defineConfig, devices } from "@playwright/test";

const PORT = 3411;

/**
 * Browser e2e for the admin SPA, the customer portal and the React embeds.
 * Builds the library (the `/react` hooks entry), the UI bundle and the embed
 * (dist/react-embed.js + scoped react.css), then boots the e2e server — the
 * real panel over the seeded in-memory demo engine (see e2e/server.ts).
 *
 *   bun run test:e2e
 */
export default defineConfig({
  testDir: "e2e",
  testMatch: "**/*.spec.ts",
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: "on-first-retry",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: `bun run build && PORT=${PORT} bun e2e/server.ts`,
    url: `http://localhost:${PORT}/healthcheck`,
    timeout: 300_000,
    reuseExistingServer: !process.env.CI,
  },
});

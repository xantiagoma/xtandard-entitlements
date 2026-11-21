import { expect, test, type Locator, type Page } from "@playwright/test";

// The React embeds + hooks on a themed host page (e2e/server.ts → /e2e/embed,
// mounting the built dist/react-embed.js + scoped react.css and the built
// hooks entry + react-components.css).

const wrapper = (page: Page): Locator => page.locator(".xtandard-entitlements").first();

/** WCAG relative luminance of a computed CSS color (any syntax, incl. oklch). */
async function luminance(locator: Locator, prop: "color" | "background-color"): Promise<number> {
  return locator.evaluate((el, p) => {
    const value = getComputedStyle(el).getPropertyValue(p);
    const ctx = document.createElement("canvas").getContext("2d")!;
    ctx.fillStyle = value;
    ctx.fillRect(0, 0, 1, 1);
    const [r, g, b] = Array.from(ctx.getImageData(0, 0, 1, 1).data).map((c) => {
      const s = c / 255;
      return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
  }, prop);
}

const contrast = (a: number, b: number): number =>
  (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);

async function expectPanelTheme(page: Page, theme: "light" | "dark", heading: string) {
  const title = page.getByRole("heading", { name: heading });
  await expect(title).toBeVisible();
  await expect
    .poll(async () => {
      const surface = await luminance(wrapper(page), "background-color");
      const text = await luminance(title, "color");
      return {
        surface: theme === "dark" ? surface < 0.05 : surface > 0.8,
        readable: contrast(text, surface) > 7,
      };
    })
    .toEqual({ surface: true, readable: true });
  await expect(wrapper(page)).toHaveAttribute("data-theme", theme);
}

test("dashboard embed inherits a dark host (class) and a light host", async ({ page }) => {
  await page.goto("/e2e/embed?view=dashboard&theme=inherit&host=class");
  await expectPanelTheme(page, "dark", "Overview");
  // No theme switcher when the host owns the theme.
  await expect(page.getByRole("group", { name: "Theme" })).toHaveCount(0);
  await page.goto("/e2e/embed?view=dashboard&theme=inherit");
  await expectPanelTheme(page, "light", "Overview");
});

test("dashboard embed follows a live host theme change (data-theme)", async ({ page }) => {
  await page.goto("/e2e/embed?view=dashboard&theme=inherit&host=attr");
  await expectPanelTheme(page, "dark", "Overview");
  await page.evaluate(() => document.documentElement.setAttribute("data-theme", "light"));
  await expectPanelTheme(page, "light", "Overview");
});

test("dashboard embed navigates in memory without touching the host URL", async ({ page }) => {
  await page.goto("/e2e/embed?view=dashboard&theme=light");
  await page.getByRole("button", { name: "Customers", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Customers" })).toBeVisible();
  expect(new URL(page.url()).pathname).toBe("/e2e/embed");
  // Scoped stylesheet: the host bar keeps its own font weight / no panel leakage.
  await expect(page.locator(".host-bar")).toHaveCSS("font-weight", "600");
});

test("forced dark theme + dialog stays inside the scoped wrapper", async ({ page }) => {
  await page.goto("/e2e/embed?view=dashboard&theme=dark");
  await expectPanelTheme(page, "dark", "Overview");
  await page.getByRole("button", { name: "Customers", exact: true }).click();
  await page.getByText("Lucerne Publishing").click();
  await page.getByRole("button", { name: "Add grant" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  expect(await dialog.evaluate((el) => !!el.closest(".xtandard-entitlements"))).toBe(true);
});

test("CustomerPortal embed renders the token's customer", async ({ page }) => {
  await page.goto("/e2e/embed?view=portal&theme=light&customer=alpine-ski");
  await expectPanelTheme(page, "light", "Plan & usage");
  await expect(page.getByText(/Your Pro trial ends in/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Upgrade to Business" })).toBeEnabled();
});

test("hooks + components gate the host's own UI", async ({ page }) => {
  // Coho Winery is on Free: PDF export and SSO are gated, meters show usage.
  await page.goto("/e2e/embed?view=gates&customer=coho-winery");
  await expect(page.getByText("You're on")).toContainText("Free");
  await expect(page.getByRole("button", { name: "Export PDF" })).toHaveCount(0);
  await expect(page.getByText("Upgrade to Pro to use PDF export.")).toBeVisible();
  await expect(page.getByText("Upgrade to Business to use SAML SSO.")).toBeVisible();
  const meter = page.getByRole("progressbar", { name: "API calls" });
  await expect(meter).toHaveAttribute("aria-valuemax", "1000");
  await expect(page.locator("[data-xe=plan][data-current]")).toHaveAttribute("data-plan", "free");

  // Business customer: everything unlocked.
  await page.goto("/e2e/embed?view=gates&customer=northwind");
  await expect(page.getByRole("button", { name: "Export PDF" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Configure SAML" })).toBeVisible();
  await expect(page.locator("[data-xe=upgrade]")).toHaveCount(0);
});

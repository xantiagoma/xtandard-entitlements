import { expect, test, type Page } from "@playwright/test";

// The customer portal: the same SPA in portal mode, scoped by a portal token
// passed in the URL fragment, plus the admin's "Open portal preview".

async function tokenFor(page: Page, customer: string, scope?: "read"): Promise<string> {
  const res = await page.request.get(
    `/e2e/portal-token?customer=${customer}${scope ? `&scope=${scope}` : ""}`,
  );
  return ((await res.json()) as { token: string }).token;
}

test("token in the URL hash → reduced portal chrome, token stripped from the URL", async ({
  page,
}) => {
  const token = await tokenFor(page, "alpine-ski");
  await page.goto(`/#token=${token}`);
  await expect(page.getByRole("heading", { name: "Plan & usage" })).toBeVisible();
  await expect(page.getByText("Customer portal")).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Main navigation" })).toHaveCount(0);
  expect(page.url()).not.toContain("token=");
  // Trial banner, current plan, meters, comparison with the current plan marked.
  await expect(page.getByText(/Your Pro trial ends in/)).toBeVisible();
  await expect(page.getByRole("region", { name: "Current plan" })).toContainText("Pro");
  await expect(page.getByRole("progressbar", { name: "API calls usage" })).toBeVisible();
  await expect(page.getByRole("article", { name: "Pro plan" })).toContainText("Current plan");
});

test("checkout enabled: Upgrade links out to the provider", async ({ page }) => {
  const token = await tokenFor(page, "tailspin");
  await page.goto(`/#token=${token}`);
  await page.getByRole("button", { name: "Upgrade to Business" }).click();
  await expect(page).toHaveURL(/\/e2e\/checkout\?customer=tailspin&item=price_business_monthly/);
  await expect(page.getByRole("heading", { name: "Fake checkout" })).toBeVisible();
});

test("manage billing links out", async ({ page }) => {
  const token = await tokenFor(page, "wingtip");
  await page.goto(`/#token=${token}`);
  await expect(page.getByText(/last payment failed/)).toBeVisible();
  await page.getByRole("button", { name: "Manage billing" }).click();
  await expect(page).toHaveURL(/\/e2e\/billing-portal\?customer=wingtip/);
});

test("checkout disabled: a view-only token shows the hint and disabled buttons", async ({
  page,
}) => {
  const token = await tokenFor(page, "tailspin", "read");
  await page.goto(`/#token=${token}`);
  await expect(page.getByText(/Online plan changes aren't available/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Upgrade to Business" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Manage billing" })).toHaveCount(0);
});

test("an invalid token shows an error, not the admin", async ({ page }) => {
  await page.goto("/#token=entpt_bogus.bogus");
  await expect(page.getByText(/couldn't load|token/i).first()).toBeVisible();
  await expect(page.getByRole("heading", { name: "Overview" })).toHaveCount(0);
});

test("admin portal preview (?customer=) from the customer page", async ({ page }) => {
  await page.goto("/customers/northwind");
  await page.getByRole("button", { name: "Open portal preview" }).click();
  await expect(page).toHaveURL(/\/portal\?customer=northwind/);
  await expect(page.getByText(/Previewing the customer portal of/)).toBeVisible();
  await expect(page.getByRole("region", { name: "Current plan" })).toContainText("Business");
  await page.getByRole("button", { name: "Exit preview" }).click();
  await expect(page.getByRole("heading", { name: "Northwind Traders" })).toBeVisible();
});

test("portal renders in dark mode", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "dark" });
  const token = await tokenFor(page, "fabrikam");
  await page.goto(`/#token=${token}`);
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(page.getByRole("heading", { name: "Plan & usage" })).toBeVisible();
});

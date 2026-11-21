import { expect, test, type Page } from "@playwright/test";

// The admin SPA against the seeded demo (e2e/server.ts). Serial: the mutation
// journey builds on its own state (one in-memory engine per server).
test.describe.configure({ mode: "serial" });

const nav = (page: Page, name: string) =>
  page.getByRole("navigation", { name: "Main navigation" }).getByRole("button", { name });

test("overview: counts, plan mix, trials, activity", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Overview" })).toBeVisible();
  await expect(page.getByText("Acme Billing").first()).toBeVisible();
  const customers = page.getByText("Customers", { exact: true }).first();
  await expect(customers).toBeVisible();
  await expect(page.getByRole("region", { name: "Customers by plan" })).toContainText("Business");
  await expect(page.getByRole("region", { name: "Trials ending soon" })).toContainText(
    "alpine-ski",
  );
  await expect(page.getByRole("region", { name: "Recent activity" })).toContainText("munsons");
});

test("navigates catalog → customers → activity", async ({ page }) => {
  await page.goto("/");
  await nav(page, "Catalog").click();
  await expect(page).toHaveURL(/\/catalog$/);
  await expect(page.getByRole("heading", { name: "Catalog" })).toBeVisible();
  const matrix = page.getByRole("region", { name: "Features × plans" });
  await expect(matrix.getByRole("columnheader", { name: /Pro/ })).toBeVisible();
  // Previous versions and hidden plans are off until toggled.
  await expect(matrix.getByText("legacy")).toHaveCount(0);
  await matrix.getByRole("switch", { name: "Show previous versions" }).click();
  await expect(matrix.getByText(/v1 · legacy/)).toBeVisible();
  await matrix.getByRole("switch", { name: "Show hidden plans" }).click();
  await expect(matrix.getByRole("columnheader", { name: /Enterprise/ })).toBeVisible();
  await expect(page.getByRole("region", { name: "Pricing preview" })).toContainText("$29");
  await expect(page.getByRole("region", { name: "Provider mappings" })).toContainText(
    "price_pro_monthly_v2",
  );

  await nav(page, "Customers").click();
  await expect(page.getByRole("heading", { name: "Customers" })).toBeVisible();
  await page.getByRole("searchbox", { name: "Search customers" }).fill("wood");
  await expect(page.getByText("Woodgrove Bank")).toBeVisible();
  await expect(page.getByText("Fabrikam Inc")).toHaveCount(0);

  await nav(page, "Activity").click();
  await expect(page.getByRole("heading", { name: "Activity" })).toBeVisible();
  await page.getByRole("button", { name: "Overrides" }).click();
  await expect(page.getByText(/Abuse investigation/)).toBeVisible();
  await expect(page.getByText(/Granted 5000 API calls/)).toHaveCount(0);
});

test("customer list paginates", async ({ page }) => {
  await page.goto("/customers");
  await expect(page.getByText("Page 1")).toBeVisible();
  await page.getByRole("button", { name: "Next" }).click();
  await expect(page.getByText("Page 2")).toBeVisible();
  await expect(page.getByText("Wide World Importers")).toBeVisible();
  await page.getByRole("button", { name: "Previous" }).click();
  await expect(page.getByText("Adventure Works")).toBeVisible();
});

test("customer detail: entitlements, usage chart, sources", async ({ page }) => {
  await page.goto("/customers");
  await page.getByText("Fabrikam Inc").click();
  await expect(page).toHaveURL(/\/customers\/fabrikam$/);
  await expect(page.getByRole("heading", { name: "Fabrikam Inc" })).toBeVisible();
  const ents = page.getByRole("region", { name: "Entitlements" });
  await expect(ents.getByRole("progressbar", { name: "API calls usage" })).toHaveAttribute(
    "data-level",
    /warn|critical/,
  );
  await expect(ents.getByText("grant · +5k")).toBeVisible();
  await expect(page.getByRole("img", { name: /API calls daily usage/ })).toBeVisible();
});

test("adds a grant (with validation) and revokes it", async ({ page }) => {
  await page.goto("/customers/tailspin");
  await page.getByRole("button", { name: "Add grant" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Feature").selectOption("ai_credits");
  await dialog.getByLabel("Amount").fill("-5");
  await dialog.getByRole("button", { name: "Add grant" }).click();
  await expect(dialog.getByText("The amount must be greater than zero.")).toBeVisible();
  await dialog.getByLabel("Amount").fill("2,500");
  await dialog.getByLabel("Reason").fill("Hackathon sponsor");
  await dialog.getByRole("button", { name: "Add grant" }).click();
  await expect(page.getByText("Granted 2,500 credits of AI credits")).toBeVisible();
  await expect(dialog).toHaveCount(0);
  const grants = page.getByRole("region", { name: "Grants" });
  await expect(grants.getByText("“Hackathon sponsor”")).toBeVisible();

  await grants.getByRole("button", { name: "Revoke" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Revoke" }).click();
  await expect(page.getByText("Grant revoked")).toBeVisible();
  await expect(grants.getByText("No grants.")).toBeVisible();
});

test("adds an override (reason required) and removes it", async ({ page }) => {
  await page.goto("/customers/coho-winery");
  await page.getByRole("button", { name: "Add override" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Feature").selectOption("export_pdf");
  await dialog.getByRole("button", { name: "Add override" }).click();
  await expect(dialog.getByText(/Say why/)).toBeVisible();
  await dialog.getByLabel("Reason").fill("Design partner");
  await dialog.getByRole("button", { name: "Add override" }).click();
  await expect(page.getByText("Override on PDF export added")).toBeVisible();
  const ents = page.getByRole("region", { name: "Entitlements" });
  await expect(ents.getByRole("row", { name: /PDF export/ })).toContainText("Enabled");
  await expect(ents.getByRole("row", { name: /PDF export/ })).toContainText("override");

  const overrides = page.getByRole("region", { name: "Overrides" });
  await overrides.getByRole("button", { name: "Remove" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Remove override" }).click();
  await expect(page.getByText("Override removed")).toBeVisible();
  await expect(ents.getByRole("row", { name: /PDF export/ })).toContainText("Not included");
});

test("changes plan and cancels at period end", async ({ page }) => {
  await page.goto("/customers/bellows");
  await page.getByRole("button", { name: "Change plan" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Plan").selectOption("business");
  await dialog.getByRole("button", { name: "Change plan" }).click();
  await expect(page.getByText("Moved to Business")).toBeVisible();
  const subs = page.getByRole("region", { name: "Plans & subscriptions" });
  await expect(subs.getByText("Active")).toBeVisible();
  const ents = page.getByRole("region", { name: "Entitlements" });
  await expect(ents.getByRole("row", { name: /SAML SSO/ })).toContainText("Enabled");

  await subs.getByRole("button", { name: "Cancel" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Cancel immediately" }).click();
  await expect(page.getByText("Subscription canceled")).toBeVisible();
  await expect(ents.getByRole("row", { name: /SAML SSO/ })).toContainText("Not included");
});

test("starts a trial and sets usage", async ({ page }) => {
  await page.goto("/customers/margies-travel");
  await page.getByRole("button", { name: "Start trial" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Start trial" }).click();
  await expect(page.getByText("Trial of Pro started")).toBeVisible();
  await expect(
    page.getByRole("region", { name: "Plans & subscriptions" }).getByText("Trialing"),
  ).toBeVisible();

  await page.getByRole("button", { name: "Set Seats usage" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Used").fill("7");
  await dialog.getByRole("button", { name: "Set usage" }).click();
  await expect(page.getByText("Seats set to 7")).toBeVisible();
  await expect(
    page
      .getByRole("region", { name: "Entitlements" })
      .getByRole("progressbar", { name: "Seats usage" }),
  ).toHaveAttribute("aria-valuenow", "7");
});

test("edits the profile", async ({ page }) => {
  await page.goto("/customers/fincher");
  await page.getByRole("button", { name: "Edit profile" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Email").fill("not-an-email");
  await dialog.getByRole("button", { name: "Save profile" }).click();
  await expect(dialog.getByText("Enter a valid email address.")).toBeVisible();
  await dialog.getByLabel("Name").fill("Fincher & Partners Architects");
  await dialog.getByLabel("Email").fill("accounts@fincher.example");
  await dialog.getByRole("button", { name: "Save profile" }).click();
  await expect(page.getByRole("heading", { name: "Fincher & Partners Architects" })).toBeVisible();
  await expect(page.getByText("accounts@fincher.example")).toBeVisible();
});

test("theme toggle switches light ↔ dark and persists", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Dark theme" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.getByRole("button", { name: "Light theme" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
});

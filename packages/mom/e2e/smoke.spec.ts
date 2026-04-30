import { expect, test } from "@playwright/test";

test("smoke: example.com loads", async ({ page }) => {
	await page.goto("https://example.com/");
	await expect(page.getByRole("heading", { name: "Example Domain" })).toBeVisible();
});

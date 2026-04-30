import { defineConfig, devices } from "@playwright/test";

const storageState = process.env.PLAYWRIGHT_STORAGE_STATE;

export default defineConfig({
	testDir: "./e2e",
	fullyParallel: true,
	forbidOnly: Boolean(process.env.CI),
	retries: process.env.CI ? 2 : 0,
	reporter: process.env.CI ? "line" : "html",
	use: {
		trace: "on-first-retry",
		...(storageState ? { storageState } : {}),
		headless: process.env.PLAYWRIGHT_HEADED !== "1",
	},
	projects: [
		{
			name: "chromium",
			use: { ...devices["Desktop Chrome"] },
		},
	],
});

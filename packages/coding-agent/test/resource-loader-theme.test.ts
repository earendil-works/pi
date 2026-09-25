import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetCapabilitiesCache, setCapabilityOverrides } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";

describe("DefaultResourceLoader theme color mode", () => {
	let tempDir: string;
	let agentDir: string;
	let cwd: string;
	let themePath: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "resource-loader-theme-"));
		agentDir = join(tempDir, "agent");
		cwd = join(tempDir, "project");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(cwd, { recursive: true });

		const themeJson = JSON.parse(
			readFileSync(join(process.cwd(), "src", "modes", "interactive", "theme", "dark.json"), "utf-8"),
		) as { name: string; colors: Record<string, string | number> };
		themeJson.name = "capability-test";
		themeJson.colors.userMessageBg = "#3c3544";
		themePath = join(tempDir, "capability-test.json");
		writeFileSync(themePath, JSON.stringify(themeJson));
	});

	afterEach(() => {
		vi.unstubAllEnvs();
		setCapabilityOverrides({});
		resetCapabilitiesCache();
		rmSync(tempDir, { recursive: true, force: true });
	});

	// Regression test for #9973.
	it.each([
		{
			environment: "256-color",
			environmentOverride: "0",
			setting: true,
			expected: "\x1b[48;2;60;53;68mx\x1b[49m",
		},
		{
			environment: "truecolor",
			environmentOverride: "1",
			setting: false,
			expected: "\x1b[48;5;59mx\x1b[49m",
		},
	])(
		"uses the $setting setting over a $environment environment",
		async ({ environmentOverride, setting, expected }) => {
			vi.stubEnv("PI_TRUE_COLOR", environmentOverride);
			setCapabilityOverrides({});
			resetCapabilitiesCache();

			const loader = new DefaultResourceLoader({
				cwd,
				agentDir,
				settingsManager: SettingsManager.inMemory({ terminal: { trueColor: setting } }),
				additionalThemePaths: [themePath],
				noExtensions: true,
				noSkills: true,
				noPromptTemplates: true,
				noContextFiles: true,
			});
			await loader.reload();

			const loadedTheme = loader.getThemes().themes.find((theme) => theme.name === "capability-test");
			expect(loadedTheme?.bg("userMessageBg", "x")).toBe(expected);
		},
	);

	it("returns to automatic detection after an explicit setting is removed", async () => {
		vi.stubEnv("PI_TRUE_COLOR", "1");
		setCapabilityOverrides({});
		resetCapabilitiesCache();

		const settingsPath = join(agentDir, "settings.json");
		writeFileSync(settingsPath, JSON.stringify({ terminal: { trueColor: false } }));
		const settingsManager = SettingsManager.create(cwd, agentDir);
		const loader = new DefaultResourceLoader({
			cwd,
			agentDir,
			settingsManager,
			additionalThemePaths: [themePath],
			noExtensions: true,
			noSkills: true,
			noPromptTemplates: true,
			noContextFiles: true,
		});
		await loader.reload();
		setCapabilityOverrides(settingsManager.getTerminalCapabilityOverrides());

		writeFileSync(settingsPath, "{}");
		await loader.reload();

		const loadedTheme = loader.getThemes().themes.find((theme) => theme.name === "capability-test");
		expect(loadedTheme?.bg("userMessageBg", "x")).toBe("\x1b[48;2;60;53;68mx\x1b[49m");
	});
});

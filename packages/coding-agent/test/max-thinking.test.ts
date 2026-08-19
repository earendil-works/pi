import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { isValidThinkingLevel } from "../src/cli/args.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { loadThemeFromPath } from "../src/modes/interactive/theme/theme.ts";

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe("max thinking level", () => {
	it("is accepted by CLI and settings", async () => {
		expect(isValidThinkingLevel("max")).toBe(true);

		const settings = SettingsManager.inMemory();
		settings.setDefaultThinkingLevel("max");
		await settings.flush();
		expect(settings.getDefaultThinkingLevel()).toBe("max");
	});

	it("falls back to thinkingXhigh for legacy themes", () => {
		const testDir = mkdtempSync(join(tmpdir(), "pi-max-theme-"));
		tempDirs.push(testDir);
		const currentDir = dirname(fileURLToPath(import.meta.url));
		const darkTheme = JSON.parse(
			readFileSync(join(currentDir, "../src/modes/interactive/theme/dark.json"), "utf8"),
		) as { name: string; colors: Record<string, unknown> };
		darkTheme.name = "legacy-theme";
		delete darkTheme.colors.thinkingMax;
		const themePath = join(testDir, "legacy-theme.json");
		writeFileSync(themePath, JSON.stringify(darkTheme));

		const legacyTheme = loadThemeFromPath(themePath);
		expect(legacyTheme.getThinkingBorderColor("max")("border")).toBe(
			legacyTheme.getThinkingBorderColor("xhigh")("border"),
		);
	});
});

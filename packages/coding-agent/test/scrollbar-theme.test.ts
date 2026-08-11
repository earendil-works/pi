import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadThemeFromPath } from "../src/modes/interactive/theme/theme.ts";

const tempDirs: string[] = [];

function loadDarkTheme(): { name: string; colors: Record<string, string | number> } {
	return JSON.parse(readFileSync(new URL("../src/modes/interactive/theme/dark.json", import.meta.url), "utf8")) as {
		name: string;
		colors: Record<string, string | number>;
	};
}

function writeTheme(theme: { name: string; colors: Record<string, string | number> }): string {
	const testDir = mkdtempSync(join(tmpdir(), "pi-scrollbar-theme-"));
	tempDirs.push(testDir);
	const themePath = join(testDir, `${theme.name}.json`);
	writeFileSync(themePath, JSON.stringify(theme));
	return themePath;
}

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe("optional fullscreen theme colors", () => {
	it("falls back to selectedBg when scrollbarThumb is omitted", () => {
		const themeJson = loadDarkTheme();
		themeJson.name = "legacy-scrollbar-theme";
		delete themeJson.colors.scrollbarThumb;

		const loadedTheme = loadThemeFromPath(writeTheme(themeJson), "truecolor");
		expect(loadedTheme.getBgAnsi("scrollbarThumb")).toBe(loadedTheme.getBgAnsi("selectedBg"));
	});

	it("uses an explicitly configured scrollbarThumb", () => {
		const themeJson = loadDarkTheme();
		themeJson.name = "custom-scrollbar-theme";
		themeJson.colors.scrollbarThumb = "#123456";

		const loadedTheme = loadThemeFromPath(writeTheme(themeJson), "truecolor");
		expect(loadedTheme.getBgAnsi("scrollbarThumb")).toBe("\x1b[48;2;18;52;86m");
	});

	it("falls back to existing selection and text colors for search highlights", () => {
		const themeJson = loadDarkTheme();
		themeJson.name = "legacy-search-theme";
		delete themeJson.colors.searchMatchBg;
		delete themeJson.colors.searchMatchText;

		const loadedTheme = loadThemeFromPath(writeTheme(themeJson), "truecolor");
		expect(loadedTheme.getBgAnsi("searchMatchBg")).toBe(loadedTheme.getBgAnsi("selectedBg"));
		expect(loadedTheme.getFgAnsi("searchMatchText")).toBe(loadedTheme.getFgAnsi("text"));
	});

	it("uses explicitly configured search highlight colors", () => {
		const themeJson = loadDarkTheme();
		themeJson.name = "custom-search-theme";
		themeJson.colors.searchMatchBg = "#112233";
		themeJson.colors.searchMatchText = "#223344";

		const loadedTheme = loadThemeFromPath(writeTheme(themeJson), "truecolor");
		expect(loadedTheme.getBgAnsi("searchMatchBg")).toBe("\x1b[48;2;17;34;51m");
		expect(loadedTheme.getFgAnsi("searchMatchText")).toBe("\x1b[38;2;34;51;68m");
	});
});

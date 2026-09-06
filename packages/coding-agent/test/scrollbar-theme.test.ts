import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadThemeFromPath, setThemeJsonValidator } from "../src/modes/interactive/theme/theme.ts";
import { validateThemeJson } from "../src/modes/interactive/theme/theme-json.ts";

setThemeJsonValidator(validateThemeJson);

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

describe("fullscreen theme colors", () => {
	it.each([
		["scrollbarTrack", "muted"],
		["scrollbarThumb", "text"],
	] as const)("falls back to %s when omitted", (token, fallback) => {
		const themeJson = loadDarkTheme();
		themeJson.name = `missing-${token}-theme`;
		delete themeJson.colors[token];

		const loadedTheme = loadThemeFromPath(writeTheme(themeJson), "truecolor");
		expect(loadedTheme.getFgAnsi(token)).toBe(loadedTheme.getFgAnsi(fallback));
	});

	it("uses explicitly configured scrollbar colors", () => {
		const themeJson = loadDarkTheme();
		themeJson.name = "custom-scrollbar-theme";
		themeJson.colors.scrollbarTrack = "#654321";
		themeJson.colors.scrollbarThumb = "#123456";

		const loadedTheme = loadThemeFromPath(writeTheme(themeJson), "truecolor");
		expect(loadedTheme.getFgAnsi("scrollbarTrack")).toBe("\x1b[38;2;101;67;33m");
		expect(loadedTheme.getFgAnsi("scrollbarThumb")).toBe("\x1b[38;2;18;52;86m");
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

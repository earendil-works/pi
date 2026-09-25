import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { colorToHex, styleText } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it } from "vitest";
import { loadThemeFromPath, setTerminalColors } from "../src/modes/interactive/theme/theme.ts";

const tempDirs: string[] = [];

type ThemeFile = { name: string; appearance?: "dark" | "light"; colors: Record<string, string | number> };

/** Load a copy of a built-in theme, modified by `edit`. */
function loadTheme(base: "dark" | "light", edit: (theme: ThemeFile) => void = () => {}) {
	const themeJson = JSON.parse(
		readFileSync(new URL(`../src/modes/interactive/theme/${base}.json`, import.meta.url), "utf8"),
	) as ThemeFile;
	edit(themeJson);
	const dir = mkdtempSync(join(tmpdir(), "pi-theme-style-"));
	tempDirs.push(dir);
	const path = join(dir, `${themeJson.name}.json`);
	writeFileSync(path, JSON.stringify(themeJson));
	return loadThemeFromPath(path, "truecolor");
}

afterEach(() => {
	setTerminalColors({});
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("theme styles", () => {
	it("renders theme tokens the same as the generic text styler", () => {
		const theme = loadTheme("dark");
		expect(theme.style("Ready", { fg: "success", bg: "toolSuccessBg", bold: true })).toBe(
			styleText("Ready", { fg: theme.colors.success, bg: theme.colors.toolSuccessBg, bold: true }, "truecolor"),
		);
	});

	it("rejects unknown tokens and tokens in the wrong slot", () => {
		const theme = loadTheme("dark");
		expect(() => theme.style("x", { fg: "notAToken" as never })).toThrow("Unknown theme color: notAToken");
		// @ts-expect-error background tokens are not foreground colors; use theme.colors.userMessageBg
		expect(() => theme.style("x", { fg: "userMessageBg" })).toThrow("Unknown theme color: userMessageBg");
	});

	it("loads OKLCH theme values", () => {
		const theme = loadTheme("dark", (json) => {
			json.colors.accent = "oklch(62% 0.1 200)";
		});
		expect(theme.colors.accent).toEqual({ kind: "oklch", l: 0.62, c: 0.1, h: 200 });
	});

	it("detects the appearance unless it is declared", () => {
		expect(loadTheme("dark").appearance).toBe("dark");
		expect(loadTheme("light").appearance).toBe("light");
		expect(
			loadTheme("dark", (json) => {
				json.appearance = "light";
			}).appearance,
		).toBe("light");

		// Palette colors 0-15 follow the terminal palette, so such themes follow the terminal background.
		const paletteOnly = loadTheme("dark", (json) => {
			for (const key of Object.keys(json.colors)) json.colors[key] = key.endsWith("Bg") ? 0 : 7;
		});
		expect(paletteOnly.appearance).toBe("dark");
		setTerminalColors({ background: { r: 250, g: 250, b: 250 } });
		expect(paletteOnly.appearance).toBe("light");
	});

	it("renders empty tokens as terminal defaults and reports concrete colors for them", () => {
		const theme = loadTheme("dark", (json) => {
			json.colors.text = "";
			json.colors.userMessageBg = "";
		});
		expect(theme.fg("text", "x")).toBe("\x1b[39mx\x1b[39m");
		expect(theme.bg("userMessageBg", "x")).toBe("\x1b[49mx\x1b[49m");
		expect(colorToHex(theme.colors.text)).toBe("#e5e5e7");
		expect(colorToHex(theme.colors.userMessageBg)).toBe("#000000");

		setTerminalColors({ foreground: { r: 200, g: 210, b: 220 }, background: { r: 10, g: 20, b: 30 } });
		expect(colorToHex(theme.colors.text)).toBe("#c8d2dc");
		expect(colorToHex(theme.colors.userMessageBg)).toBe("#0a141e");
	});
});

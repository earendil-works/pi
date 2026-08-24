import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetCapabilitiesCache, setCapabilities } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it } from "vitest";
import { initTheme, loadThemeFromPath, style, theme } from "../src/modes/interactive/theme/theme.ts";

const tempDirs: string[] = [];

afterEach(() => {
	resetCapabilitiesCache();
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("theme styles", () => {
	it("accepts theme tokens and concrete colors", () => {
		setCapabilities({ images: null, trueColor: true, hyperlinks: false });
		initTheme("dark");

		expect(style("Ready", { fg: "toolSuccessBg" })).toBe(style("Ready", { fg: theme.colors.toolSuccessBg }));
		expect(theme.style("Ready", { fg: "success", bg: "toolSuccessBg", bold: true })).toContain("Ready");
	});

	it("keeps the legacy foreground and background helpers", () => {
		setCapabilities({ images: null, trueColor: true, hyperlinks: false });
		initTheme("dark");

		expect(theme.fg("success", "Ready")).toBe(`${theme.getFgAnsi("success")}Ready\x1b[39m`);
		expect(theme.bg("toolSuccessBg", "Ready")).toBe(`${theme.getBgAnsi("toolSuccessBg")}Ready\x1b[49m`);
	});

	it("loads OKLCH theme values", () => {
		const themeJson = JSON.parse(
			readFileSync(new URL("../src/modes/interactive/theme/dark.json", import.meta.url), "utf8"),
		) as { name: string; colors: Record<string, string | number> };
		themeJson.name = "oklch-theme";
		themeJson.colors.accent = "oklch(62% 0.1 200)";
		const dir = mkdtempSync(join(tmpdir(), "pi-oklch-theme-"));
		tempDirs.push(dir);
		const path = join(dir, "oklch-theme.json");
		writeFileSync(path, JSON.stringify(themeJson));

		const loaded = loadThemeFromPath(path, "truecolor");
		expect(loaded.colors.accent).toEqual({ kind: "oklch", l: 0.62, c: 0.1, h: 200 });
		expect(loaded.style("Accent", { fg: "accent" })).toMatch(/^\x1b\[38;2;\d+;\d+;\d+mAccent\x1b\[39m$/);
	});
});

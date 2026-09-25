import { resetCapabilitiesCache, setCapabilities } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it } from "vitest";
import {
	detectTerminalBackgroundFromEnv,
	detectTerminalTheme,
	getThemeByName,
	parseAutoThemeSetting,
	resolveThemeSetting,
} from "../src/modes/interactive/theme/theme.ts";

afterEach(() => {
	resetCapabilitiesCache();
});

describe("detectTerminalBackgroundFromEnv", () => {
	it("uses the COLORFGBG background color index", () => {
		expect(detectTerminalBackgroundFromEnv({ env: { COLORFGBG: "0;15" } })).toMatchObject({
			theme: "light",
			source: "COLORFGBG",
			confidence: "high",
		});
		expect(detectTerminalBackgroundFromEnv({ env: { COLORFGBG: "15;0" } })).toMatchObject({
			theme: "dark",
			source: "COLORFGBG",
			confidence: "high",
		});
	});

	it("uses the last COLORFGBG field as the background", () => {
		expect(detectTerminalBackgroundFromEnv({ env: { COLORFGBG: "0;7;15" } }).theme).toBe("light");
	});

	it("defaults to dark without terminal background hints", () => {
		expect(detectTerminalBackgroundFromEnv({ env: {} })).toMatchObject({
			theme: "dark",
			source: "fallback",
			confidence: "low",
		});
	});
});

describe("detectTerminalTheme", () => {
	it("uses the reported background before environment hints", () => {
		expect(
			detectTerminalTheme({ background: { r: 250, g: 250, b: 250 } }, { env: { COLORFGBG: "15;0" } }),
		).toMatchObject({ theme: "light", source: "terminal colors", confidence: "high" });
		expect(detectTerminalTheme({ background: { r: 8, g: 8, b: 8 } })).toMatchObject({ theme: "dark" });
	});

	it("follows the terminal foreground when text is readable that way", () => {
		// Black text has more contrast on this gray, but white text still reaches 4.5:1, so the foreground decides.
		const background = { r: 118, g: 118, b: 118 };
		expect(detectTerminalTheme({ background }).theme).toBe("light");
		expect(detectTerminalTheme({ background, foreground: { r: 255, g: 255, b: 255 } }).theme).toBe("dark");
		// White text cannot reach 4.5:1 on mid-gray, so the theme uses dark text instead.
		expect(
			detectTerminalTheme({ background: { r: 128, g: 128, b: 128 }, foreground: { r: 255, g: 255, b: 255 } }).theme,
		).toBe("light");
	});

	it("falls back to environment hints without a reported background", () => {
		expect(detectTerminalTheme({}, { env: { COLORFGBG: "0;15" } })).toMatchObject({
			theme: "light",
			source: "COLORFGBG",
		});
		expect(detectTerminalTheme({ foreground: { r: 0, g: 0, b: 0 } }, { env: {} })).toMatchObject({
			theme: "dark",
			source: "fallback",
		});
	});
});

describe("theme color mode", () => {
	it("uses terminal capabilities", () => {
		setCapabilities({ images: null, trueColor: false, hyperlinks: false });
		const ansi256Theme = getThemeByName("dark");
		if (!ansi256Theme) throw new Error("dark theme not found");
		expect(ansi256Theme.getColorMode()).toBe("256color");
		expect(ansi256Theme.getFgAnsi("accent")).toMatch(/^\x1b\[38;5;\d+m$/);

		setCapabilities({ images: null, trueColor: true, hyperlinks: false });
		const truecolorTheme = getThemeByName("dark");
		if (!truecolorTheme) throw new Error("dark theme not found");
		expect(truecolorTheme.getColorMode()).toBe("truecolor");
		expect(truecolorTheme.getFgAnsi("accent")).toMatch(/^\x1b\[38;2;\d+;\d+;\d+m$/);
	});
});

describe("theme setting helpers", () => {
	it("parses and resolves automatic theme settings", () => {
		expect(parseAutoThemeSetting("light/dark")).toEqual({ lightTheme: "light", darkTheme: "dark" });
		expect(resolveThemeSetting("dark", "light")).toBe("dark");
		expect(resolveThemeSetting("light/dark", "light")).toBe("light");
		expect(resolveThemeSetting("light/dark", "dark")).toBe("dark");
		expect(resolveThemeSetting("light/dark/extra", "dark")).toBeUndefined();
	});
});

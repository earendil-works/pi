import { resetCapabilitiesCache, setCapabilities } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it } from "vitest";
import {
	detectColorFgBgTheme,
	detectTerminalTheme,
	getThemeByName,
	parseAutoThemeSetting,
	resolveThemeSetting,
} from "../src/modes/interactive/theme/theme.ts";

afterEach(() => {
	resetCapabilitiesCache();
});

describe("detectColorFgBgTheme", () => {
	it("uses the last COLORFGBG field as the background color index", () => {
		expect(detectColorFgBgTheme({ COLORFGBG: "0;15" })).toBe("light");
		expect(detectColorFgBgTheme({ COLORFGBG: "15;0" })).toBe("dark");
		expect(detectColorFgBgTheme({ COLORFGBG: "0;7;15" })).toBe("light");
		expect(detectColorFgBgTheme({})).toBeUndefined();
	});
});

describe("detectTerminalTheme", () => {
	it("uses the reported background before COLORFGBG", () => {
		expect(detectTerminalTheme({ background: { r: 250, g: 250, b: 250 } }, { COLORFGBG: "15;0" })).toBe("light");
		expect(detectTerminalTheme({ background: { r: 8, g: 8, b: 8 } }, { COLORFGBG: "0;15" })).toBe("dark");
	});

	it("follows the terminal foreground when text is readable that way", () => {
		// Black text has more contrast on this gray, but white text still reaches 4.5:1, so the foreground decides.
		const background = { r: 118, g: 118, b: 118 };
		expect(detectTerminalTheme({ background })).toBe("light");
		expect(detectTerminalTheme({ background, foreground: { r: 255, g: 255, b: 255 } })).toBe("dark");
		// White text cannot reach 4.5:1 on mid-gray, so the theme uses dark text instead.
		expect(
			detectTerminalTheme({ background: { r: 128, g: 128, b: 128 }, foreground: { r: 255, g: 255, b: 255 } }),
		).toBe("light");
	});

	it("falls back to COLORFGBG, then dark", () => {
		expect(detectTerminalTheme({}, { COLORFGBG: "0;15" })).toBe("light");
		expect(detectTerminalTheme({ foreground: { r: 0, g: 0, b: 0 } }, {})).toBe("dark");
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

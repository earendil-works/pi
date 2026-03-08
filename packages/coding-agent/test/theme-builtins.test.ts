import { describe, expect, it } from "vitest";
import { getAvailableThemes, initTheme, setTheme, theme } from "../src/theme/theme.js";

describe("built-in themes", () => {
	it("includes the nerv theme and can load it", () => {
		const themes = getAvailableThemes();

		expect(themes).toContain("nerv");

		const result = setTheme("nerv");
		expect(result).toEqual({ success: true });
		expect(theme.fg("accent", "NERV")).toContain("\u001b[");
		expect(theme.fg("warning", "WARN")).toContain("\u001b[");
	});

	it("uses nerv as the default theme", () => {
		delete process.env.COLORFGBG;
		process.env.COLORTERM = "truecolor";

		initTheme();

		expect(theme.getFgAnsi("text")).toBe("\u001b[38;2;224;224;216m");
		expect(theme.getFgAnsi("warning")).toContain("\u001b[38;2;");
	});
});

import { colorToOklch, colorToRgb, parseColor, type RgbColor, rgbColor } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it } from "vitest";
import {
	generateSystemThemeColors,
	type SystemThemeInput,
	wcagContrast,
} from "../src/modes/interactive/theme/system-theme.ts";
import {
	getAvailableThemes,
	getThemeByName,
	getThemeExportColors,
	setTerminalColors,
	type ThemeToken,
} from "../src/modes/interactive/theme/theme.ts";

const rgb = (hex: string): RgbColor => colorToRgb(parseColor(hex));
const lightness = ({ r, g, b }: RgbColor) => colorToOklch(rgbColor(r, g, b)).l;

const DRACULA: SystemThemeInput = {
	background: rgb("#282a36"),
	foreground: rgb("#f8f8f2"),
	palette: ["#21222c", "#ff5555", "#50fa7b", "#f1fa8c", "#bd93f9", "#ff79c6", "#8be9fd", "#f8f8f2"]
		.concat(["#6272a4", "#ff6e6e", "#69ff94", "#ffffa5", "#d6acff", "#ff92df", "#a4ffff", "#ffffff"])
		.map(rgb),
};

/** Dark with a palette, light with an unreadable foreground, background only, and mid-gray. */
const TERMINALS: Record<string, SystemThemeInput> = {
	dracula: DRACULA,
	solarizedLight: { background: rgb("#fdf6e3"), foreground: rgb("#657b83") },
	backgroundOnly: { background: rgb("#1e1e1e") },
	midGray: { background: rgb("#808080"), foreground: rgb("#ffffff") },
};

const PANELS: ThemeToken[] = ["userMessageBg", "toolPendingBg", "toolSuccessBg", "toolErrorBg", "selectedBg"];

function resolved(input: SystemThemeInput, token: ThemeToken): RgbColor {
	const value = generateSystemThemeColors(input).colors[token];
	if (value === "") return PANELS.includes(token) ? input.background! : input.foreground!;
	return rgb(value as string);
}

afterEach(() => {
	setTerminalColors({});
});

describe("generateSystemThemeColors", () => {
	it("keeps body text readable (WCAG 4.5:1) on the background and its panels", () => {
		for (const [name, input] of Object.entries(TERMINALS)) {
			const text = resolved(input, "text");
			for (const surface of [input.background!, resolved(input, "selectedBg")]) {
				expect(wcagContrast(text, surface), name).toBeGreaterThanOrEqual(4.5);
			}
			expect(
				wcagContrast(resolved(input, "toolTitle"), resolved(input, "toolErrorBg")),
				name,
			).toBeGreaterThanOrEqual(4.5);
		}
	});

	it("orders foreground roles by contrast and keeps panels close to the background", () => {
		for (const [name, input] of Object.entries(TERMINALS)) {
			const background = lightness(input.background!);
			const offset = (token: ThemeToken) => lightness(resolved(input, token)) - background;
			// On mid-gray the levels collapse to the strongest reachable color.
			if (name !== "midGray") {
				expect(Math.abs(offset("text")), name).toBeGreaterThan(Math.abs(offset("muted")));
				expect(Math.abs(offset("muted")), name).toBeGreaterThan(Math.abs(offset("dim")));
			}
			const lighter = generateSystemThemeColors(input).appearance === "dark";
			for (const panel of PANELS) {
				expect(wcagContrast(resolved(input, panel), input.background!), `${name} ${panel}`).toBeLessThan(2);
				expect(offset(panel) > 0, `${name} ${panel}`).toBe(lighter);
			}
		}
	});

	it("uses the terminal foreground and palette hues", () => {
		expect(generateSystemThemeColors(DRACULA).colors.text).toBe("");
		// Solarized's foreground is below 4.5:1 on its own background, so text is darkened.
		expect(generateSystemThemeColors(TERMINALS.solarizedLight).colors.text).not.toBe("");
		const hue = ({ r, g, b }: RgbColor) => colorToOklch(rgbColor(r, g, b)).h;
		expect(Math.abs(hue(resolved(DRACULA, "error")) - hue(DRACULA.palette![1]))).toBeLessThan(8);
	});

	it("renders grayscale at zero saturation", () => {
		const { colors } = generateSystemThemeColors({ ...DRACULA, saturation: 0 });
		expect(colorToOklch(parseColor(colors.error as string)).c).toBeLessThan(0.005);
	});

	it("falls back to palette indices and faint text without a background", () => {
		const { colors, dim, appearance } = generateSystemThemeColors({ appearanceHint: "light" });
		expect(appearance).toBe("light");
		expect([colors.error, colors.text, colors.userMessageBg]).toEqual([1, "", ""]);
		expect(dim).toContain("muted");
		expect(generateSystemThemeColors({ saturation: 0 }).colors.error).toBe("");
	});
});

describe("system theme", () => {
	it("is listed first, has no export colors, and is generated from the terminal colors", () => {
		expect(getAvailableThemes()[0]).toBe("system");
		expect(getThemeExportColors("system")).toEqual({});

		setTerminalColors(DRACULA);
		const theme = getThemeByName("system")!;
		expect(theme.appearance).toBe("dark");
		expect(theme.getFgAnsi("text")).toBe("\x1b[39m");
		expect(theme.getFgAnsi("error")).toMatch(/^\x1b\[38;/);
	});

	it("renders faint tokens with SGR 2 and closes it", () => {
		const theme = getThemeByName("system")!;
		expect(theme.fg("muted", "x")).toBe("\x1b[39m\x1b[2mx\x1b[22;39m");
		expect(theme.style("x", { fg: "muted" })).toBe("\x1b[39m\x1b[2mx\x1b[22m\x1b[39m");
	});
});

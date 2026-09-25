import { colorToOklch, type RgbColor, rgbColor } from "@earendil-works/pi-tui";
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
	markTerminalColorsPending,
	setTerminalColors,
	type ThemeToken,
} from "../src/modes/interactive/theme/theme.ts";

function rgb(hex: string): RgbColor {
	return {
		r: Number.parseInt(hex.slice(1, 3), 16),
		g: Number.parseInt(hex.slice(3, 5), 16),
		b: Number.parseInt(hex.slice(5, 7), 16),
	};
}

const lightness = (color: RgbColor) => colorToOklch(rgbColor(color.r, color.g, color.b)).l;

/** Terminal themes: dark, light, low-saturation, strongly tinted, and a mid-gray background. */
const TERMINALS: Record<string, SystemThemeInput> = {
	dracula: {
		background: rgb("#282a36"),
		foreground: rgb("#f8f8f2"),
		palette: [
			"#21222c",
			"#ff5555",
			"#50fa7b",
			"#f1fa8c",
			"#bd93f9",
			"#ff79c6",
			"#8be9fd",
			"#f8f8f2",
			"#6272a4",
			"#ff6e6e",
			"#69ff94",
			"#ffffa5",
			"#d6acff",
			"#ff92df",
			"#a4ffff",
			"#ffffff",
		].map(rgb),
	},
	solarizedLight: {
		background: rgb("#fdf6e3"),
		foreground: rgb("#657b83"),
		palette: [
			"#073642",
			"#dc322f",
			"#859900",
			"#b58900",
			"#268bd2",
			"#d33682",
			"#2aa198",
			"#eee8d5",
			"#002b36",
			"#cb4b16",
			"#586e75",
			"#657b83",
			"#839496",
			"#6c71c4",
			"#93a1a1",
			"#fdf6e3",
		].map(rgb),
	},
	solarizedDark: {
		background: rgb("#002b36"),
		foreground: rgb("#839496"),
		palette: [
			"#073642",
			"#dc322f",
			"#859900",
			"#b58900",
			"#268bd2",
			"#d33682",
			"#2aa198",
			"#eee8d5",
			"#002b36",
			"#cb4b16",
			"#586e75",
			"#657b83",
			"#839496",
			"#6c71c4",
			"#93a1a1",
			"#fdf6e3",
		].map(rgb),
	},
	grayscale: {
		background: rgb("#000000"),
		foreground: rgb("#c0c0c0"),
		palette: Array.from({ length: 16 }, (_, index) => rgb(index < 8 ? "#808080" : "#c0c0c0")),
	},
	midGray: { background: rgb("#808080"), foreground: rgb("#ffffff") },
	backgroundOnly: { background: rgb("#1e1e1e") },
};

const TEXT_TOKENS: ThemeToken[] = ["text", "userMessageText", "toolTitle"];
const PANELS: ThemeToken[] = [
	"userMessageBg",
	"customMessageBg",
	"toolPendingBg",
	"toolSuccessBg",
	"toolErrorBg",
	"selectedBg",
	"searchMatchBg",
];

function resolved(input: SystemThemeInput, token: ThemeToken): RgbColor {
	const value = generateSystemThemeColors(input).colors[token];
	if (value === "") return PANELS.includes(token) ? input.background! : input.foreground!;
	if (typeof value === "number") throw new Error(`unexpected index for ${token}`);
	return rgb(value);
}

afterEach(() => {
	setTerminalColors({});
});

describe("generateSystemThemeColors", () => {
	it("is deterministic", () => {
		for (const input of Object.values(TERMINALS)) {
			expect(generateSystemThemeColors(input)).toEqual(generateSystemThemeColors(input));
		}
	});

	it("keeps body text readable (WCAG 4.5:1) on the surfaces it is drawn on", () => {
		const drawnOn: Record<string, ThemeToken[]> = {
			text: ["selectedBg"],
			userMessageText: ["userMessageBg"],
			toolTitle: ["toolPendingBg", "toolSuccessBg", "toolErrorBg"],
		};
		for (const [name, input] of Object.entries(TERMINALS)) {
			for (const token of TEXT_TOKENS) {
				const text = resolved(input, token);
				const surfaces = token === "text" ? [input.background!] : [];
				for (const panel of drawnOn[token]) surfaces.push(resolved(input, panel));
				for (const surface of surfaces) {
					expect(wcagContrast(text, surface), `${name} ${token}`).toBeGreaterThanOrEqual(4.5);
				}
			}
		}
	});

	it("orders foreground roles by contrast to the background", () => {
		for (const [name, input] of Object.entries(TERMINALS)) {
			// On mid-gray the levels are relaxed until they collapse to the strongest reachable color.
			if (name === "midGray") continue;
			const background = lightness(input.background!);
			const distance = (token: ThemeToken) => Math.abs(lightness(resolved(input, token)) - background);
			// Faint borders and dim text share a level; muted text is stronger, body text strongest.
			expect(distance("dim"), name).toBeGreaterThanOrEqual(distance("borderMuted") - 0.005);
			expect(distance("muted"), name).toBeGreaterThan(distance("dim"));
			expect(distance("text"), name).toBeGreaterThan(distance("muted"));
			expect(distance("accent"), name).toBeGreaterThan(distance("dim"));
		}
	});

	it("keeps panels close to the background and in the theme's direction", () => {
		for (const [name, input] of Object.entries(TERMINALS)) {
			const { appearance } = generateSystemThemeColors(input);
			const background = lightness(input.background!);
			for (const panel of PANELS) {
				const color = resolved(input, panel);
				const offset = lightness(color) - background;
				expect(wcagContrast(color, input.background!), `${name} ${panel}`).toBeLessThan(2);
				expect(appearance === "dark" ? offset > 0 : offset < 0, `${name} ${panel}`).toBe(true);
			}
		}
	});

	it("uses the terminal foreground for body text when it is readable", () => {
		expect(generateSystemThemeColors(TERMINALS.dracula).colors.text).toBe("");
		// Solarized's foreground is below the WCAG minimum on its own background, so text is darkened.
		expect(generateSystemThemeColors(TERMINALS.solarizedLight).colors.text).not.toBe("");
	});

	it("takes hues from the terminal palette", () => {
		const hue = (color: RgbColor) => colorToOklch(rgbColor(color.r, color.g, color.b)).h;
		const input = TERMINALS.dracula;
		for (const [token, slot] of [
			["error", 1],
			["success", 2],
			["mdLink", 4],
			["accent", 5],
			["syntaxVariable", 6],
		] as const) {
			expect(Math.abs(hue(resolved(input, token)) - hue(input.palette![slot])), token).toBeLessThan(8);
		}
	});

	it("detects the appearance from the foreground and background", () => {
		expect(generateSystemThemeColors(TERMINALS.dracula).appearance).toBe("dark");
		expect(generateSystemThemeColors(TERMINALS.solarizedLight).appearance).toBe("light");
		// White text cannot reach 4.5:1 on mid-gray, so the theme uses dark text instead.
		expect(generateSystemThemeColors(TERMINALS.midGray).appearance).toBe("light");
	});

	it("renders grayscale at zero saturation", () => {
		const { colors } = generateSystemThemeColors({ ...TERMINALS.dracula, saturation: 0 });
		for (const value of Object.values(colors)) {
			if (typeof value !== "string" || value === "") continue;
			expect(colorToOklch(rgbColor(...(Object.values(rgb(value)) as [number, number, number]))).c).toBeLessThan(
				0.005,
			);
		}
	});

	it("falls back to palette indices and faint text without a background", () => {
		const { colors, dim, appearance } = generateSystemThemeColors({ appearanceHint: "light" });
		expect(appearance).toBe("light");
		expect(colors.error).toBe(1);
		expect(colors.success).toBe(2);
		expect(colors.text).toBe("");
		expect(colors.muted).toBe("");
		expect(colors.userMessageBg).toBe("");
		expect(dim).toContain("muted");
		expect(dim).not.toContain("text");

		// While colors are pending, nothing is colored.
		expect(generateSystemThemeColors({ saturation: 0 }).colors.error).toBe("");
	});
});

describe("system theme", () => {
	it("is listed first and has no export colors", () => {
		expect(getAvailableThemes()[0]).toBe("system");
		expect(getThemeExportColors("system")).toEqual({});
	});

	it("is generated from the reported terminal colors", () => {
		setTerminalColors(TERMINALS.dracula);
		const theme = getThemeByName("system")!;
		expect(theme.name).toBe("system");
		expect(theme.appearance).toBe("dark");
		expect(theme.getFgAnsi("text")).toBe("\x1b[39m");
		expect(theme.getFgAnsi("error")).toMatch(/^\x1b\[38;/);

		markTerminalColorsPending();
		expect(getThemeByName("system")!.colors.error.kind).toBe("rgb");
		const pending = generateSystemThemeColors({ ...TERMINALS.dracula, saturation: 0 });
		expect(pending.colors.error).not.toBe(generateSystemThemeColors(TERMINALS.dracula).colors.error);
	});

	it("renders faint tokens with SGR 2 and closes it", () => {
		setTerminalColors({});
		const theme = getThemeByName("system")!;
		expect(theme.fg("muted", "x")).toBe("\x1b[39m\x1b[2mx\x1b[22;39m");
		expect(theme.style("x", { fg: "muted" })).toBe("\x1b[39m\x1b[2mx\x1b[22m\x1b[39m");
		expect(theme.fg("text", "x")).toBe("\x1b[39mx\x1b[39m");
	});
});

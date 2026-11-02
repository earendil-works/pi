// Tests of themes (slice 11 §4b): the active theme for a mode and a pick, CSS variables of a theme, and terminal
// colours by role (true colour, the nearest of 256, `tui` overrides first, the fallback for a missing role).

import { describe, expect, it } from "vitest";
import { activeTheme, FALLBACK_THEMES, type Theme, terminalColor, themeVariables } from "../../src/surfaces/themes.ts";

const COLORS = {
	accent: "#e8590c",
	bg: "#111317",
	fg: "#e8e8e8",
	muted: "#8a8f98",
	error: "#ff0000",
	warning: "#ffaa00",
	success: "#00ff00",
};

const SOLARIZED: Theme = { id: "solarized", name: "Solarized", mode: "dark", colors: { ...COLORS, link: "#268bd2" } };

const PAPER: Theme = { id: "paper", name: "Paper", mode: "light", colors: COLORS, web: { radius: "10px" } };

const NIGHT: Theme = { id: "night", name: "Night", mode: "dark", colors: COLORS, tui: { accent: "208" } };

describe("the active theme", () => {
	it("is the picked one of the mode, else the first of the mode, else the fallback", () => {
		const themes = [SOLARIZED, PAPER, NIGHT];
		expect(activeTheme(themes, { dark: "night", light: null }, "dark").id).toBe("night");
		expect(activeTheme(themes, { dark: null, light: null }, "dark").id).toBe("solarized");
		expect(activeTheme(themes, { dark: "paper", light: null }, "dark").id).toBe("solarized");
		expect(activeTheme(themes, { dark: null, light: "gone" }, "light").id).toBe("paper");
		expect(activeTheme([SOLARIZED], { dark: null, light: null }, "light")).toBe(FALLBACK_THEMES.light);
	});
});

describe("CSS variables", () => {
	it("gives every role and every web extra a custom property", () => {
		expect(themeVariables(SOLARIZED)).toMatchObject({
			"--accent": "#e8590c",
			"--bg": "#111317",
			"--link": "#268bd2",
		});
		expect(themeVariables(PAPER)["--radius"]).toBe("10px");
	});
});

describe("terminal colours", () => {
	it("gives true colour, or the nearest of 256, for a role", () => {
		expect(terminalColor(SOLARIZED, "accent", "truecolor", "fg")).toBe("38;2;232;89;12");
		expect(terminalColor(SOLARIZED, "bg", "truecolor", "bg")).toBe("48;2;17;19;23");
		expect(terminalColor(SOLARIZED, "error", "256", "fg")).toBe("38;5;196");
		expect(terminalColor(SOLARIZED, "fg", "256", "fg")).toBe("38;5;254");
		expect(terminalColor(SOLARIZED, "bg", "256", "bg")).toBe("48;5;233");
	});

	it("takes the theme's tui override first, the fallback for a missing role, the default for an unknown one", () => {
		expect(terminalColor(NIGHT, "accent", "truecolor", "fg")).toBe("38;5;208");
		const partial = { ...SOLARIZED, colors: { ...COLORS, muted: "not a colour" } };
		expect(terminalColor(partial, "muted", "truecolor", "fg")).toBe("39");
		expect(terminalColor(SOLARIZED, "nobody", "256", "bg")).toBe("49");
		const fallback = FALLBACK_THEMES.dark.colors.accent.slice(1);
		const rgb = [0, 2, 4].map((at) => Number.parseInt(fallback.slice(at, at + 2), 16)).join(";");
		const missing = { ...SOLARIZED, colors: { ...COLORS, accent: undefined as unknown as string } };
		expect(terminalColor(missing, "accent", "truecolor", "fg")).toBe(`38;2;${rgb}`);
	});
});

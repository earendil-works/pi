import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getThemeExportColors, loadThemeFromPath } from "../src/modes/interactive/theme/theme.ts";

type ThemeFile = {
	name: string;
	vars?: Record<string, string | number>;
	colors: Record<string, string | number>;
	export?: {
		pageBg?: string | number;
		cardBg?: string | number;
		infoBg?: string | number;
	};
};

function createTempThemeDir(): string {
	const tempRoot = mkdtempSync(join(tmpdir(), "pi-theme-alpha-"));
	process.env.PI_CODING_AGENT_DIR = join(tempRoot, "agent");
	mkdirSync(join(process.env.PI_CODING_AGENT_DIR, "themes"), { recursive: true });
	return tempRoot;
}

function cleanupTempDir(tempRoot: string, previousAgentDir: string | undefined) {
	rmSync(tempRoot, { recursive: true, force: true });
	if (previousAgentDir === undefined) {
		delete process.env.PI_CODING_AGENT_DIR;
	} else {
		process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	}
}

function readDarkTheme(): ThemeFile {
	return JSON.parse(
		readFileSync(new URL("../src/modes/interactive/theme/dark.json", import.meta.url), "utf-8"),
	) as ThemeFile;
}

describe("theme alpha blending", () => {
	let tempRoot: string;
	let previousAgentDir: string | undefined;

	beforeEach(() => {
		previousAgentDir = process.env.PI_CODING_AGENT_DIR;
		tempRoot = createTempThemeDir();
	});

	afterEach(() => {
		cleanupTempDir(tempRoot, previousAgentDir);
	});

	it("blends #RRGGBBAA colors with bg var", () => {
		const darkTheme = readDarkTheme();
		const customTheme: ThemeFile = {
			...darkTheme,
			name: "alpha-test-blend",
			vars: {
				...(darkTheme.vars ?? {}),
			},
		};

		const themePath = join(process.env.PI_CODING_AGENT_DIR!, "themes", "alpha-test-blend.json");
		writeFileSync(themePath, JSON.stringify(customTheme, null, 2));

		const theme = loadThemeFromPath(themePath, "truecolor");
		// The dark theme's toolSuccessBg is #b5bd6826 (green at ~15% alpha)
		// It should be blended with the bg var (#1e1e2e)
		const bgAnsi = theme.getBgAnsi("toolSuccessBg");
		// Background ANSI uses 48;2;R;G;Bm
		expect(bgAnsi).toMatch(/48;2;\d+;\d+;\d+m/);
	});

	it("handles #RRGGBB (no alpha) as fully opaque", () => {
		const darkTheme = readDarkTheme();
		const customTheme: ThemeFile = {
			...darkTheme,
			name: "alpha-test-opaque",
			vars: {
				...(darkTheme.vars ?? {}),
				toolSuccessBg: "#283228", // override with opaque color (no alpha)
			},
			colors: {
				...darkTheme.colors,
				toolSuccessBg: "toolSuccessBg",
			},
		};

		const themePath = join(process.env.PI_CODING_AGENT_DIR!, "themes", "alpha-test-opaque.json");
		writeFileSync(themePath, JSON.stringify(customTheme, null, 2));

		const theme = loadThemeFromPath(themePath, "truecolor");
		const bgAnsi = theme.getBgAnsi("toolSuccessBg");
		expect(bgAnsi).toContain("48;2;40;50;40"); // #283228 as RGB
	});

	it("blends alpha colors in export section", () => {
		const darkTheme = readDarkTheme();
		const customTheme: ThemeFile = {
			...darkTheme,
			name: "alpha-test-export",
			vars: {
				...(darkTheme.vars ?? {}),
				semiPageBg: "#ffffff40", // white at 25% alpha
			},
			export: {
				pageBg: "semiPageBg",
			},
		};

		const themePath = join(process.env.PI_CODING_AGENT_DIR!, "themes", "alpha-test-export.json");
		writeFileSync(themePath, JSON.stringify(customTheme, null, 2));

		const colors = getThemeExportColors("alpha-test-export");
		// #ffffff at 25% over #1e1e2e should produce an opaque color
		expect(colors.pageBg).toMatch(/^#[0-9a-f]{6}$/);
		// Should be lighter than the bg color
		expect(colors.pageBg).not.toBe("#1e1e2e");
	});

	it("uses selectedBg fallback when bg var is not defined", () => {
		const darkTheme = readDarkTheme();
		// Remove bg from vars, but still have alpha color
		const varsWithoutBg = { ...(darkTheme.vars ?? {}) } as Record<string, string | number>;
		delete varsWithoutBg.bg;

		const customTheme: ThemeFile = {
			...darkTheme,
			name: "alpha-test-nobg",
			vars: {
				...varsWithoutBg,
				testSuccessBg: "#b5bd6826", // green at ~15% alpha
			},
			colors: {
				...darkTheme.colors,
				toolSuccessBg: "testSuccessBg",
			},
		};

		const themePath = join(process.env.PI_CODING_AGENT_DIR!, "themes", "alpha-test-nobg.json");
		writeFileSync(themePath, JSON.stringify(customTheme, null, 2));

		// Should not throw - falls back to selectedBg
		const theme = loadThemeFromPath(themePath, "truecolor");
		expect(theme).toBeDefined();
		const bgAnsi = theme.getBgAnsi("toolSuccessBg");
		expect(bgAnsi).toMatch(/48;2;\d+;\d+;\d+m/);
	});

	it("blends alpha color referenced by var", () => {
		const darkTheme = readDarkTheme();
		const customTheme: ThemeFile = {
			...darkTheme,
			name: "alpha-test-var",
			vars: {
				...(darkTheme.vars ?? {}),
				successBg: "#b5bd6826", // green at ~15% alpha, referenced by var
			},
			colors: {
				...darkTheme.colors,
				toolSuccessBg: "successBg",
			},
		};

		const themePath = join(process.env.PI_CODING_AGENT_DIR!, "themes", "alpha-test-var.json");
		writeFileSync(themePath, JSON.stringify(customTheme, null, 2));

		const theme = loadThemeFromPath(themePath, "truecolor");
		expect(theme).toBeDefined();
		// Should have blended the var-ref'd alpha color
		const bgAnsi = theme.getBgAnsi("toolSuccessBg");
		expect(bgAnsi).toMatch(/48;2;\d+;\d+;\d+m/);
	});

	it("fully transparent alpha (00) results in background color", () => {
		const darkTheme = readDarkTheme();
		const customTheme: ThemeFile = {
			...darkTheme,
			name: "alpha-test-fully-transparent",
			vars: {
				...(darkTheme.vars ?? {}),
				invisibleBg: "#ff000000", // red at 0% alpha = fully transparent
			},
			colors: {
				...darkTheme.colors,
				toolSuccessBg: "invisibleBg",
			},
		};

		const themePath = join(process.env.PI_CODING_AGENT_DIR!, "themes", "alpha-test-fully-transparent.json");
		writeFileSync(themePath, JSON.stringify(customTheme, null, 2));

		const theme = loadThemeFromPath(themePath, "truecolor");
		const bgAnsi = theme.getBgAnsi("toolSuccessBg");
		// Fully transparent should result in the background color (#1e1e2e)
		expect(bgAnsi).toContain("48;2;30;30;46"); // #1e1e2e as RGB
	});
});

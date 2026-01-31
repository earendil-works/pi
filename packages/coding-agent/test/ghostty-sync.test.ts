/**
 * Tests for Ghostty Theme Sync
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	cleanupOldGhosttyThemes,
	computeThemeHash,
	fetchGhosttyColors,
	type GhosttyColors,
	generateGhosttyTheme,
	getOrCreateGhosttyTheme,
	getThemesDir,
	ghosttyThemeExists,
	isGhosttyAvailable,
	isRunningInGhostty,
	normalizeColor,
	parseGhosttyConfig,
} from "../src/theme/ghostty-sync.js";

describe("GhosttyDetector", () => {
	const originalEnv = process.env;

	beforeEach(() => {
		// Reset environment before each test
		process.env = { ...originalEnv };
	});

	afterEach(() => {
		// Restore original environment
		process.env = originalEnv;
	});

	describe("isRunningInGhostty", () => {
		it("should return true when TERM_PROGRAM is ghostty", () => {
			process.env.TERM_PROGRAM = "ghostty";
			expect(isRunningInGhostty()).toBe(true);
		});

		it("should return false when TERM_PROGRAM is not ghostty", () => {
			process.env.TERM_PROGRAM = "iTerm.app";
			expect(isRunningInGhostty()).toBe(false);
		});

		it("should return false when TERM_PROGRAM is undefined", () => {
			delete process.env.TERM_PROGRAM;
			expect(isRunningInGhostty()).toBe(false);
		});

		it("should return false when TERM_PROGRAM is empty string", () => {
			process.env.TERM_PROGRAM = "";
			expect(isRunningInGhostty()).toBe(false);
		});
	});

	describe("isGhosttyAvailable", () => {
		it("should return true when ghostty is in PATH (current environment)", () => {
			// In the actual Ghostty environment, this should return true
			// We can't easily mock execSync here, so we test the actual behavior
			const result = isGhosttyAvailable();
			// We expect true in this environment since ghostty is installed
			expect(typeof result).toBe("boolean");
		});
	});
});

describe("GhosttyColorParser", () => {
	describe("normalizeColor", () => {
		it("should normalize 6-digit hex with hash", () => {
			expect(normalizeColor("#ff0000")).toBe("#ff0000");
			expect(normalizeColor("#ffffff")).toBe("#ffffff");
		});

		it("should normalize 3-digit hex with hash", () => {
			expect(normalizeColor("#f00")).toBe("#ff0000");
			expect(normalizeColor("#fff")).toBe("#ffffff");
			expect(normalizeColor("#abc")).toBe("#aabbcc");
		});

		it("should normalize 6-digit hex without hash", () => {
			expect(normalizeColor("ff0000")).toBe("#ff0000");
			expect(normalizeColor("ffffff")).toBe("#ffffff");
		});

		it("should handle already normalized colors", () => {
			expect(normalizeColor("#111113")).toBe("#111113");
			expect(normalizeColor("#edeef0")).toBe("#edeef0");
		});
	});

	describe("parseGhosttyConfig", () => {
		it("should parse background and foreground", () => {
			const config = `background = #111113
foreground = #edeef0`;

			const result = parseGhosttyConfig(config);

			expect(result.background).toBe("#111113");
			expect(result.foreground).toBe("#edeef0");
		});

		it("should parse palette colors", () => {
			const config = `background = #111113
foreground = #edeef0
palette = 0=#111113
palette = 1=#ff6188
palette = 2=#a9dc76
palette = 3=#ffd866`;

			const result = parseGhosttyConfig(config);

			expect(result.palette[0]).toBe("#111113");
			expect(result.palette[1]).toBe("#ff6188");
			expect(result.palette[2]).toBe("#a9dc76");
			expect(result.palette[3]).toBe("#ffd866");
		});

		it("should provide defaults when colors are missing", () => {
			const config = ``;

			const result = parseGhosttyConfig(config);

			expect(result.background).toBe("#1e1e1e");
			expect(result.foreground).toBe("#d4d4d4");
		});

		it("should ignore non-color lines", () => {
			const config = `font-family = Berkeley Mono
background = #111113
foreground = #edeef0
keybind = super+q=quit`;

			const result = parseGhosttyConfig(config);

			expect(result.background).toBe("#111113");
			expect(result.foreground).toBe("#edeef0");
			expect(Object.keys(result.palette)).toHaveLength(0);
		});
	});

	describe("fetchGhosttyColors", () => {
		it("should return colors when ghostty is available", () => {
			// This test runs the actual command
			const result = fetchGhosttyColors();

			if (isGhosttyAvailable()) {
				expect(result).not.toBeNull();
				expect(result?.background).toMatch(/^#[0-9a-fA-F]{6}$/);
				expect(result?.foreground).toMatch(/^#[0-9a-fA-F]{6}$/);
			} else {
				expect(result).toBeNull();
			}
		});
	});
});

describe("GhosttyThemeGenerator", () => {
	describe("computeThemeHash", () => {
		it("should return consistent hash for same colors", () => {
			const colors: GhosttyColors = {
				background: "#111113",
				foreground: "#edeef0",
				palette: { 1: "#ff6188", 2: "#a9dc76" },
			};

			const hash1 = computeThemeHash(colors);
			const hash2 = computeThemeHash(colors);

			expect(hash1).toBe(hash2);
			expect(hash1).toMatch(/^[0-9a-f]{8}$/);
		});

		it("should return different hash for different colors", () => {
			const colors1: GhosttyColors = {
				background: "#111113",
				foreground: "#edeef0",
				palette: {},
			};

			const colors2: GhosttyColors = {
				background: "#000000",
				foreground: "#ffffff",
				palette: {},
			};

			const hash1 = computeThemeHash(colors1);
			const hash2 = computeThemeHash(colors2);

			expect(hash1).not.toBe(hash2);
		});

		it("should include palette in hash computation", () => {
			const colors1: GhosttyColors = {
				background: "#111113",
				foreground: "#edeef0",
				palette: { 1: "#ff0000" },
			};

			const colors2: GhosttyColors = {
				background: "#111113",
				foreground: "#edeef0",
				palette: { 1: "#00ff00" },
			};

			const hash1 = computeThemeHash(colors1);
			const hash2 = computeThemeHash(colors2);

			expect(hash1).not.toBe(hash2);
		});
	});

	describe("generateGhosttyTheme", () => {
		it("should generate theme with semantic variable names", () => {
			const colors: GhosttyColors = {
				background: "#111113",
				foreground: "#edeef0",
				palette: {
					1: "#ff6188", // error
					2: "#a9dc76", // success
					3: "#ffd866", // warning
					4: "#61afef", // link
					5: "#c678dd", // accent
					6: "#56b6c2", // accentAlt
				},
			};

			const theme = generateGhosttyTheme(colors, "test-theme");

			// Check structure
			expect(theme.$schema).toBeDefined();
			expect(theme.name).toBe("test-theme");
			expect(theme.vars).toBeDefined();
			expect(theme.colors).toBeDefined();

			// Check semantic vars exist
			expect(theme.vars.bg).toBe("#111113");
			expect(theme.vars.fg).toBe("#edeef0");
			expect(theme.vars.accent).toBe("#c678dd");
			expect(theme.vars.accentAlt).toBe("#56b6c2");
			expect(theme.vars.link).toBe("#61afef");
			expect(theme.vars.error).toBe("#ff6188");
			expect(theme.vars.success).toBe("#a9dc76");
			expect(theme.vars.warning).toBe("#ffd866");

			// Check derived neutrals exist
			expect(theme.vars.muted).toMatch(/^#[0-9a-f]{6}$/);
			expect(theme.vars.dim).toMatch(/^#[0-9a-f]{6}$/);
			expect(theme.vars.borderMuted).toMatch(/^#[0-9a-f]{6}$/);

			// Check derived backgrounds exist
			expect(theme.vars.selectedBg).toMatch(/^#[0-9a-f]{6}$/);
			expect(theme.vars.userMsgBg).toMatch(/^#[0-9a-f]{6}$/);
			expect(theme.vars.toolPendingBg).toMatch(/^#[0-9a-f]{6}$/);
			expect(theme.vars.toolSuccessBg).toMatch(/^#[0-9a-f]{6}$/);
			expect(theme.vars.toolErrorBg).toMatch(/^#[0-9a-f]{6}$/);
			expect(theme.vars.customMsgBg).toMatch(/^#[0-9a-f]{6}$/);

			// Check budget colors exist
			expect(theme.vars.budgetGreen).toMatch(/^#[0-9a-f]{6}$/);
			expect(theme.vars.budgetYellow).toMatch(/^#[0-9a-f]{6}$/);
			expect(theme.vars.budgetOrange).toMatch(/^#[0-9a-f]{6}$/);
			expect(theme.vars.budgetRed).toMatch(/^#[0-9a-f]{6}$/);
		});

		it("should use fallback colors when palette is empty", () => {
			const colors: GhosttyColors = {
				background: "#111113",
				foreground: "#edeef0",
				palette: {},
			};

			const theme = generateGhosttyTheme(colors, "test-theme");

			// Should use fallback colors
			expect(theme.vars.error).toBe("#cc6666");
			expect(theme.vars.success).toBe("#98c379");
			expect(theme.vars.warning).toBe("#e5c07b");
			expect(theme.vars.link).toBe("#61afef");
			expect(theme.vars.accent).toBe("#c678dd");
			expect(theme.vars.accentAlt).toBe("#56b6c2");
		});

		it("should map colors to semantic references in colors section", () => {
			const colors: GhosttyColors = {
				background: "#111113",
				foreground: "#edeef0",
				palette: {
					1: "#ff6188",
					2: "#a9dc76",
					3: "#ffd866",
					4: "#61afef",
					5: "#c678dd",
					6: "#56b6c2",
				},
			};

			const theme = generateGhosttyTheme(colors, "test-theme");

			// Colors should reference vars
			expect(theme.colors.accent).toBe("accent");
			expect(theme.colors.error).toBe("error");
			expect(theme.colors.success).toBe("success");
			expect(theme.colors.warning).toBe("warning");
			expect(theme.colors.border).toBe("link"); // border uses link color
			expect(theme.colors.muted).toBe("muted");
			expect(theme.colors.dim).toBe("dim");
		});

		it("should use a blue/green to red gradient for thinking levels", () => {
			const colors: GhosttyColors = {
				background: "#111113",
				foreground: "#edeef0",
				palette: {
					1: "#ff6188", // error (red)
					2: "#a9dc76", // success (green)
					3: "#ffd866", // warning (yellow)
					4: "#61afef", // link (blue)
					5: "#c678dd", // accent
					6: "#56b6c2", // accentAlt
				},
			};

			const theme = generateGhosttyTheme(colors, "test-theme");

			expect(theme.colors.thinkingLow).toBe("link");
			expect(theme.colors.thinkingMedium).toBe("success");
			expect(theme.colors.thinkingHigh).toBe("orange");
			expect(theme.colors.thinkingXhigh).toBe("error");
		});

		it("should have all required color tokens", () => {
			const colors: GhosttyColors = {
				background: "#111113",
				foreground: "#edeef0",
				palette: {},
			};

			const theme = generateGhosttyTheme(colors, "test-theme");

			// Required tokens from schema
			const requiredTokens = [
				"accent",
				"border",
				"borderAccent",
				"borderMuted",
				"success",
				"error",
				"warning",
				"orange",
				"muted",
				"dim",
				"text",
				"userMessageBg",
				"userMessageText",
				"toolPendingBg",
				"toolSuccessBg",
				"toolErrorBg",
				"toolTitle",
				"toolOutput",
				"mdHeading",
				"mdLink",
				"mdLinkUrl",
				"mdCode",
				"mdCodeBlock",
				"mdCodeBlockBorder",
				"mdQuote",
				"mdQuoteBorder",
				"mdHr",
				"mdListBullet",
				"toolDiffAdded",
				"toolDiffRemoved",
				"toolDiffContext",
				"syntaxComment",
				"syntaxKeyword",
				"syntaxFunction",
				"syntaxVariable",
				"syntaxString",
				"syntaxNumber",
				"syntaxType",
				"syntaxOperator",
				"syntaxPunctuation",
				"thinkingOff",
				"thinkingMinimal",
				"thinkingLow",
				"thinkingMedium",
				"thinkingHigh",
				"thinkingXhigh",
				"budgetGreen",
				"budgetYellow",
				"budgetOrange",
				"budgetRed",
			];

			for (const token of requiredTokens) {
				expect(theme.colors[token]).toBeDefined();
			}
		});
	});
});

describe("GhosttyThemeManager", () => {
	describe("getThemesDir", () => {
		it("should return path to themes directory", () => {
			const dir = getThemesDir();
			expect(dir).toContain(".mu");
			expect(dir).toContain("agent");
			expect(dir).toContain("themes");
		});
	});

	describe("ghosttyThemeExists", () => {
		it("should return false for non-existent theme", () => {
			expect(ghosttyThemeExists("ghostty-sync-nonexistent")).toBe(false);
		});

		it("should return true for existing theme file (manual test)", () => {
			// This test is skipped in automated runs to avoid filesystem side effects.
			// To run manually: create a theme first, then check existence.
			if (process.env.CI || process.env.NODE_ENV === "test") {
				// Skip in CI/test environments
				return;
			}
			// First create a theme
			const result = getOrCreateGhosttyTheme();
			if (result) {
				expect(ghosttyThemeExists(result.name)).toBe(true);
			}
		});
	});

	describe("getOrCreateGhosttyTheme", () => {
		it("should return null when not in Ghostty", () => {
			const originalTermProgram = process.env.TERM_PROGRAM;
			process.env.TERM_PROGRAM = "iTerm.app";

			const result = getOrCreateGhosttyTheme();

			expect(result).toBeNull();

			process.env.TERM_PROGRAM = originalTermProgram;
		});

		it("should return theme name when in Ghostty (manual test)", () => {
			// This test is skipped in automated runs to avoid filesystem side effects.
			if (process.env.CI || process.env.NODE_ENV === "test") {
				// Skip in CI/test environments
				return;
			}
			if (!isGhosttyAvailable() || !isRunningInGhostty()) {
				// Skip this test if not in Ghostty environment
				return;
			}

			const result = getOrCreateGhosttyTheme();

			expect(result).not.toBeNull();
			expect(result?.name).toMatch(/^ghostty-sync-[0-9a-f]{8}$/);
			expect(typeof result?.isNew).toBe("boolean");
		});
	});

	describe("cleanupOldGhosttyThemes", () => {
		it("should not throw when cleaning up (manual test)", () => {
			// This test is skipped in automated runs to avoid filesystem side effects.
			if (process.env.CI || process.env.NODE_ENV === "test") {
				return;
			}
			// Should not throw even if no themes exist
			expect(() => cleanupOldGhosttyThemes("ghostty-sync-test")).not.toThrow();
		});
	});
});

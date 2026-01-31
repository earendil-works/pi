/**
 * Ghostty Theme Sync Module
 *
 * Detects Ghostty terminal and generates matching themes.
 */

import { execSync } from "node:child_process";

/**
 * Check if the ghostty command is available in PATH.
 * @returns true if ghostty CLI is accessible
 */
export function isGhosttyAvailable(): boolean {
	try {
		execSync("which ghostty", { stdio: "pipe" });
		return true;
	} catch {
		return false;
	}
}

/**
 * Check if currently running inside a Ghostty terminal.
 * @returns true if TERM_PROGRAM is "ghostty"
 */
export function isRunningInGhostty(): boolean {
	return process.env.TERM_PROGRAM === "ghostty";
}

// ============================================================================
// GhosttyColorParser
// ============================================================================

/**
 * Structured color data from Ghostty configuration.
 */
export interface GhosttyColors {
	background: string;
	foreground: string;
	palette: Record<number, string>;
}

/**
 * Fetch colors from Ghostty configuration.
 * Executes `ghostty +show-config` and parses the output.
 * @returns GhosttyColors or null if ghostty is not available
 */
export function fetchGhosttyColors(): GhosttyColors | null {
	try {
		const output = execSync("ghostty +show-config", {
			encoding: "utf-8",
			timeout: 5000,
			stdio: ["pipe", "pipe", "pipe"],
		});
		return parseGhosttyConfig(output);
	} catch {
		return null;
	}
}

/**
 * Parse Ghostty config output into structured colors.
 * @param output Raw output from `ghostty +show-config`
 * @returns Structured GhosttyColors
 */
export function parseGhosttyConfig(output: string): GhosttyColors {
	const colors: GhosttyColors = {
		background: "#1e1e1e",
		foreground: "#d4d4d4",
		palette: {},
	};

	for (const line of output.split("\n")) {
		const match = line.match(/^(\S+)\s*=\s*(.+)$/);
		if (!match) continue;

		const [, key, value] = match;
		const trimmedValue = value.trim();

		if (key === "background") {
			colors.background = normalizeColor(trimmedValue);
		} else if (key === "foreground") {
			colors.foreground = normalizeColor(trimmedValue);
		} else if (key === "palette") {
			const paletteMatch = trimmedValue.match(/^(\d+)=(.+)$/);
			if (paletteMatch) {
				const index = parseInt(paletteMatch[1], 10);
				if (index >= 0 && index <= 15) {
					colors.palette[index] = normalizeColor(paletteMatch[2]);
				}
			}
		}
	}

	return colors;
}

/**
 * Normalize a color string to 6-digit hex format.
 * @param color Color string (e.g., "#fff", "ff0000", "#ff0000")
 * @returns Normalized 6-digit hex color (e.g., "#ffffff")
 */
export function normalizeColor(color: string): string {
	const trimmed = color.trim();

	// Already 6-digit with hash
	if (trimmed.startsWith("#") && trimmed.length === 7) {
		return trimmed.toLowerCase();
	}

	// 3-digit with hash (expand)
	if (trimmed.startsWith("#") && trimmed.length === 4) {
		const r = trimmed[1];
		const g = trimmed[2];
		const b = trimmed[3];
		return `#${r}${r}${g}${g}${b}${b}`.toLowerCase();
	}

	// 6-digit without hash
	if (!trimmed.startsWith("#") && trimmed.length === 6 && /^[0-9a-fA-F]{6}$/.test(trimmed)) {
		return `#${trimmed}`.toLowerCase();
	}

	// 3-digit without hash (expand)
	if (!trimmed.startsWith("#") && trimmed.length === 3 && /^[0-9a-fA-F]{3}$/.test(trimmed)) {
		const r = trimmed[0];
		const g = trimmed[1];
		const b = trimmed[2];
		return `#${r}${r}${g}${g}${b}${b}`.toLowerCase();
	}

	// Return as-is if we can't parse it (shouldn't happen with valid input)
	return trimmed.toLowerCase();
}

// ============================================================================
// GhosttyThemeGenerator
// ============================================================================

import { createHash } from "node:crypto";

/**
 * Generated theme JSON structure.
 */
export interface ThemeJson {
	$schema: string;
	name: string;
	vars: Record<string, string>;
	colors: Record<string, string>;
}

/**
 * Generate a complete theme from Ghostty colors.
 * @param colors Ghostty color configuration
 * @param themeName Name for the generated theme
 * @returns Complete theme JSON
 */
export function generateGhosttyTheme(colors: GhosttyColors, themeName: string): ThemeJson {
	const bg = colors.background;
	const fg = colors.foreground;
	const isDark = getLuminance(bg) < 0.5;

	// ANSI color slots - with fallbacks
	const error = colors.palette[1] || "#cc6666";
	const success = colors.palette[2] || "#98c379";
	const warning = colors.palette[3] || "#e5c07b";
	const link = colors.palette[4] || "#61afef";
	const accent = colors.palette[5] || "#c678dd";
	const accentAlt = colors.palette[6] || "#56b6c2";

	// Derive neutrals from bg/fg mix
	const muted = mixColors(fg, bg, 0.65);
	const dim = mixColors(fg, bg, 0.45);
	const borderMuted = mixColors(fg, bg, 0.25);

	// Derive backgrounds
	const bgShift = isDark ? 12 : -12;
	const selectedBg = adjustBrightness(bg, bgShift);
	const userMsgBg = adjustBrightness(bg, Math.round(bgShift * 0.7));
	const toolPendingBg = adjustBrightness(bg, Math.round(bgShift * 0.4));
	const toolSuccessBg = mixColors(bg, success, 0.88);
	const toolErrorBg = mixColors(bg, error, 0.88);
	const customMsgBg = mixColors(bg, accent, 0.92);

	// Orange (derived from warning + error mix)
	const orange = mixColors(warning, error, 0.5);

	// Budget colors (mixed from semantic colors)
	const budgetGreen = mixColors(success, bg, 0.7);
	const budgetYellow = mixColors(warning, bg, 0.7);
	const budgetOrange = mixColors(orange, bg, 0.7);
	const budgetRed = mixColors(error, bg, 0.7);

	return {
		$schema: "https://raw.githubusercontent.com/badlogic/mu-mono/main/packages/coding-agent/theme-schema.json",
		name: themeName,
		vars: {
			// Core semantic colors
			bg,
			fg,
			accent,
			accentAlt,
			link,
			error,
			success,
			warning,
			orange,

			// Derived neutrals
			muted,
			dim,
			borderMuted,

			// Derived backgrounds
			selectedBg,
			userMsgBg,
			toolPendingBg,
			toolSuccessBg,
			toolErrorBg,
			customMsgBg,

			// Budget indicators
			budgetGreen,
			budgetYellow,
			budgetOrange,
			budgetRed,
		},
		colors: {
			// Core UI
			accent: "accent",
			border: "link",
			borderAccent: "accent",
			borderMuted: "borderMuted",
			success: "success",
			error: "error",
			warning: "warning",
			orange: "orange",
			muted: "muted",
			dim: "dim",
			text: "",

			// Backgrounds
			userMessageBg: "userMsgBg",
			userMessageText: "",
			toolPendingBg: "toolPendingBg",
			toolSuccessBg: "toolSuccessBg",
			toolErrorBg: "toolErrorBg",
			toolTitle: "",
			toolOutput: "muted",

			// Markdown
			mdHeading: "warning",
			mdLink: "link",
			mdLinkUrl: "dim",
			mdCode: "accent",
			mdCodeBlock: "success",
			mdCodeBlockBorder: "muted",
			mdQuote: "muted",
			mdQuoteBorder: "muted",
			mdHr: "muted",
			mdListBullet: "accent",

			// Diffs
			toolDiffAdded: "success",
			toolDiffRemoved: "error",
			toolDiffContext: "muted",

			// Syntax
			syntaxComment: "muted",
			syntaxKeyword: "accent",
			syntaxFunction: "link",
			syntaxVariable: "accentAlt",
			syntaxString: "success",
			syntaxNumber: "accent",
			syntaxType: "accentAlt",
			syntaxOperator: "fg",
			syntaxPunctuation: "muted",

			// Thinking levels
			thinkingOff: "borderMuted",
			thinkingMinimal: "muted",
			thinkingLow: "link",
			thinkingMedium: "success",
			thinkingHigh: "orange",
			thinkingXhigh: "error",

			// Budget
			budgetGreen: "budgetGreen",
			budgetYellow: "budgetYellow",
			budgetOrange: "budgetOrange",
			budgetRed: "budgetRed",
		},
	};
}

/**
 * Compute a hash of Ghostty colors for change detection.
 * @param colors Ghostty color configuration
 * @returns 8-character hex hash
 */
export function computeThemeHash(colors: GhosttyColors): string {
	const parts: string[] = [];
	parts.push(`bg=${colors.background}`);
	parts.push(`fg=${colors.foreground}`);
	for (let i = 0; i <= 15; i++) {
		parts.push(`p${i}=${colors.palette[i] ?? ""}`);
	}
	const signature = parts.join("\n");
	return createHash("sha1").update(signature).digest("hex").slice(0, 8);
}

// Color utility functions

function hexToRgb(hex: string): { r: number; g: number; b: number } {
	const h = hex.replace("#", "");
	return {
		r: parseInt(h.substring(0, 2), 16),
		g: parseInt(h.substring(2, 4), 16),
		b: parseInt(h.substring(4, 6), 16),
	};
}

function rgbToHex(r: number, g: number, b: number): string {
	const clamp = (n: number) => Math.round(Math.min(255, Math.max(0, n)));
	return `#${clamp(r).toString(16).padStart(2, "0")}${clamp(g)
		.toString(16)
		.padStart(2, "0")}${clamp(b).toString(16).padStart(2, "0")}`;
}

function getLuminance(hex: string): number {
	const { r, g, b } = hexToRgb(hex);
	return (0.299 * r + 0.587 * g + 0.114 * b) / 255;
}

function adjustBrightness(hex: string, amount: number): string {
	const { r, g, b } = hexToRgb(hex);
	return rgbToHex(r + amount, g + amount, b + amount);
}

function mixColors(color1: string, color2: string, weight: number): string {
	const c1 = hexToRgb(color1);
	const c2 = hexToRgb(color2);
	return rgbToHex(
		c1.r * weight + c2.r * (1 - weight),
		c1.g * weight + c2.g * (1 - weight),
		c1.b * weight + c2.b * (1 - weight),
	);
}

// ============================================================================
// GhosttyThemeManager
// ============================================================================

import * as fs from "node:fs";
import { homedir } from "node:os";
import * as path from "node:path";

/**
 * Get the directory where themes are stored.
 * @returns Path to themes directory
 */
export function getThemesDir(): string {
	return path.join(homedir(), ".mu", "agent", "themes");
}

/**
 * Get or create a Ghostty-synced theme.
 * If a theme matching the current Ghostty config exists, returns it.
 * Otherwise, generates a new theme and saves it.
 * @returns Object with theme name and whether it's new, or null if Ghostty not available
 */
export function getOrCreateGhosttyTheme(): { name: string; isNew: boolean } | null {
	// Only proceed if in Ghostty
	if (!isRunningInGhostty() || !isGhosttyAvailable()) {
		return null;
	}

	// Fetch current Ghostty colors
	const colors = fetchGhosttyColors();
	if (!colors) {
		return null;
	}

	// Compute hash and theme name
	const hash = computeThemeHash(colors);
	const themeName = `ghostty-sync-${hash}`;

	// Check if theme already exists
	if (ghosttyThemeExists(themeName)) {
		return { name: themeName, isNew: false };
	}

	// Generate and save new theme
	const theme = generateGhosttyTheme(colors, themeName);
	const themesDir = getThemesDir();

	// Ensure directory exists
	if (!fs.existsSync(themesDir)) {
		fs.mkdirSync(themesDir, { recursive: true });
	}

	// Write theme file
	const themePath = path.join(themesDir, `${themeName}.json`);
	fs.writeFileSync(themePath, JSON.stringify(theme, null, 2));

	// Clean up old themes
	cleanupOldGhosttyThemes(themeName);

	return { name: themeName, isNew: true };
}

/**
 * Clean up old Ghostty-synced theme files.
 * Removes all ghostty-sync-*.json files except the current one.
 * @param currentName Name of the current theme to keep
 */
export function cleanupOldGhosttyThemes(currentName: string): void {
	const themesDir = getThemesDir();

	try {
		if (!fs.existsSync(themesDir)) {
			return;
		}

		const files = fs.readdirSync(themesDir);
		for (const file of files) {
			if (file === `${currentName}.json`) continue;
			if (file.startsWith("ghostty-sync-") && file.endsWith(".json")) {
				fs.unlinkSync(path.join(themesDir, file));
			}
		}
	} catch {
		// Best-effort cleanup - ignore errors
	}
}

/**
 * Check if a Ghostty-synced theme file exists.
 * @param themeName Name of the theme (e.g., "ghostty-sync-85eee45d")
 * @returns true if the theme file exists
 */
export function ghosttyThemeExists(themeName: string): boolean {
	const themesDir = getThemesDir();
	const themePath = path.join(themesDir, `${themeName}.json`);
	return fs.existsSync(themePath);
}

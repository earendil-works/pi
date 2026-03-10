import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
	type CursorAccentAnsi,
	type EditorTheme,
	type MarkdownTheme,
	type SelectListTheme,
	setCursorAccentAnsi,
} from "@kennyfrc/mu-tui";
import { type Static, Type } from "@sinclair/typebox";
import { TypeCompiler } from "@sinclair/typebox/compiler";
import chalk from "chalk";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ============================================================================
// Types & Schema
// ============================================================================

const ColorValueSchema = Type.Union([
	Type.String(), // hex "#ff0000", var ref "primary", or empty ""
	Type.Integer({ minimum: 0, maximum: 255 }), // 256-color index
]);

type ColorValue = Static<typeof ColorValueSchema>;

const ThemeJsonSchema = Type.Object({
	$schema: Type.Optional(Type.String()),
	name: Type.String(),
	vars: Type.Optional(Type.Record(Type.String(), ColorValueSchema)),
	colors: Type.Object({
		// Core UI (11 colors)
		accent: ColorValueSchema,
		border: ColorValueSchema,
		borderAccent: ColorValueSchema,
		borderMuted: ColorValueSchema,
		success: ColorValueSchema,
		error: ColorValueSchema,
		warning: ColorValueSchema,
		orange: ColorValueSchema,
		muted: ColorValueSchema,
		dim: ColorValueSchema,
		text: ColorValueSchema,
		// Backgrounds & Content Text (7 colors)
		userMessageBg: ColorValueSchema,
		userMessageText: ColorValueSchema,
		toolPendingBg: ColorValueSchema,
		toolSuccessBg: ColorValueSchema,
		toolErrorBg: ColorValueSchema,
		toolTitle: ColorValueSchema,
		toolOutput: ColorValueSchema,
		// Markdown (10 colors)
		mdHeading: ColorValueSchema,
		mdLink: ColorValueSchema,
		mdLinkUrl: ColorValueSchema,
		mdCode: ColorValueSchema,
		mdCodeBlock: ColorValueSchema,
		mdCodeBlockBorder: ColorValueSchema,
		mdQuote: ColorValueSchema,
		mdQuoteBorder: ColorValueSchema,
		mdHr: ColorValueSchema,
		mdListBullet: ColorValueSchema,
		// Tool Diffs (3 colors)
		toolDiffAdded: ColorValueSchema,
		toolDiffRemoved: ColorValueSchema,
		toolDiffContext: ColorValueSchema,
		// Syntax Highlighting (9 colors)
		syntaxComment: ColorValueSchema,
		syntaxKeyword: ColorValueSchema,
		syntaxFunction: ColorValueSchema,
		syntaxVariable: ColorValueSchema,
		syntaxString: ColorValueSchema,
		syntaxNumber: ColorValueSchema,
		syntaxType: ColorValueSchema,
		syntaxOperator: ColorValueSchema,
		syntaxPunctuation: ColorValueSchema,
		// Thinking Level Borders (6 colors)
		thinkingOff: ColorValueSchema,
		thinkingMinimal: ColorValueSchema,
		thinkingLow: ColorValueSchema,
		thinkingMedium: ColorValueSchema,
		thinkingHigh: ColorValueSchema,
		thinkingXhigh: ColorValueSchema,
		// Context Budget Indicators (4 colors)
		budgetGreen: ColorValueSchema,
		budgetYellow: ColorValueSchema,
		budgetOrange: ColorValueSchema,
		budgetRed: ColorValueSchema,
	}),
});

type ThemeJson = Static<typeof ThemeJsonSchema>;

const validateThemeJson = TypeCompiler.Compile(ThemeJsonSchema);

export type ThemeColor =
	| "accent"
	| "border"
	| "borderAccent"
	| "borderMuted"
	| "success"
	| "error"
	| "warning"
	| "orange"
	| "muted"
	| "dim"
	| "text"
	| "userMessageText"
	| "toolTitle"
	| "toolOutput"
	| "mdHeading"
	| "mdLink"
	| "mdLinkUrl"
	| "mdCode"
	| "mdCodeBlock"
	| "mdCodeBlockBorder"
	| "mdQuote"
	| "mdQuoteBorder"
	| "mdHr"
	| "mdListBullet"
	| "toolDiffAdded"
	| "toolDiffRemoved"
	| "toolDiffContext"
	| "syntaxComment"
	| "syntaxKeyword"
	| "syntaxFunction"
	| "syntaxVariable"
	| "syntaxString"
	| "syntaxNumber"
	| "syntaxType"
	| "syntaxOperator"
	| "syntaxPunctuation"
	| "thinkingOff"
	| "thinkingMinimal"
	| "thinkingLow"
	| "thinkingMedium"
	| "thinkingHigh"
	| "thinkingXhigh"
	| "budgetGreen"
	| "budgetYellow"
	| "budgetOrange"
	| "budgetRed";

export type ThemeBg = "userMessageBg" | "toolPendingBg" | "toolSuccessBg" | "toolErrorBg";

type ColorMode = "truecolor" | "256color";

// ============================================================================
// Color Utilities
// ============================================================================

function detectColorMode(): ColorMode {
	const colorterm = process.env.COLORTERM;
	if (colorterm === "truecolor" || colorterm === "24bit") {
		return "truecolor";
	}
	// Windows Terminal supports truecolor
	if (process.env.WT_SESSION) {
		return "truecolor";
	}
	const term = process.env.TERM || "";
	if (term.includes("256color")) {
		return "256color";
	}
	return "256color";
}

function hexToRgb(hex: string): { r: number; g: number; b: number } {
	const cleaned = hex.replace("#", "");
	if (cleaned.length !== 6) {
		throw new Error(`Invalid hex color: ${hex}`);
	}
	const r = parseInt(cleaned.substring(0, 2), 16);
	const g = parseInt(cleaned.substring(2, 4), 16);
	const b = parseInt(cleaned.substring(4, 6), 16);
	if (Number.isNaN(r) || Number.isNaN(g) || Number.isNaN(b)) {
		throw new Error(`Invalid hex color: ${hex}`);
	}
	return { r, g, b };
}

function rgbTo256(r: number, g: number, b: number): number {
	const rIndex = Math.round((r / 255) * 5);
	const gIndex = Math.round((g / 255) * 5);
	const bIndex = Math.round((b / 255) * 5);
	return 16 + 36 * rIndex + 6 * gIndex + bIndex;
}

function hexTo256(hex: string): number {
	const { r, g, b } = hexToRgb(hex);
	return rgbTo256(r, g, b);
}

function fgAnsi(color: string | number, mode: ColorMode): string {
	if (color === "") return "\x1b[39m";
	if (typeof color === "number") return `\x1b[38;5;${color}m`;
	if (color.startsWith("#")) {
		if (mode === "truecolor") {
			const { r, g, b } = hexToRgb(color);
			return `\x1b[38;2;${r};${g};${b}m`;
		} else {
			const index = hexTo256(color);
			return `\x1b[38;5;${index}m`;
		}
	}
	throw new Error(`Invalid color value: ${color}`);
}

function bgAnsi(color: string | number, mode: ColorMode): string {
	if (color === "") return "\x1b[49m";
	if (typeof color === "number") return `\x1b[48;5;${color}m`;
	if (color.startsWith("#")) {
		if (mode === "truecolor") {
			const { r, g, b } = hexToRgb(color);
			return `\x1b[48;2;${r};${g};${b}m`;
		} else {
			const index = hexTo256(color);
			return `\x1b[48;5;${index}m`;
		}
	}
	throw new Error(`Invalid color value: ${color}`);
}

function resolveVarRefs(
	value: ColorValue,
	vars: Record<string, ColorValue>,
	visited = new Set<string>(),
): string | number {
	if (typeof value === "number" || value === "" || value.startsWith("#")) {
		return value;
	}
	if (visited.has(value)) {
		throw new Error(`Circular variable reference detected: ${value}`);
	}
	if (!(value in vars)) {
		throw new Error(`Variable reference not found: ${value}`);
	}
	visited.add(value);
	return resolveVarRefs(vars[value], vars, visited);
}

function resolveThemeColors<T extends Record<string, ColorValue>>(
	colors: T,
	vars: Record<string, ColorValue> = {},
): Record<keyof T, string | number> {
	const resolved: Record<string, string | number> = {};
	for (const [key, value] of Object.entries(colors)) {
		resolved[key] = resolveVarRefs(value, vars);
	}
	return resolved as Record<keyof T, string | number>;
}

// ============================================================================
// Theme Class
// ============================================================================

export class Theme {
	private fgValues: Map<ThemeColor, string | number>;
	private bgValues: Map<ThemeBg, string | number>;
	private fgColors: Map<ThemeColor, string>;
	private bgColors: Map<ThemeBg, string>;
	private mode: ColorMode;

	constructor(
		fgColors: Record<ThemeColor, string | number>,
		bgColors: Record<ThemeBg, string | number>,
		mode: ColorMode,
	) {
		this.mode = mode;
		this.fgValues = new Map();
		this.fgColors = new Map();
		for (const [key, value] of Object.entries(fgColors) as [ThemeColor, string | number][]) {
			this.fgValues.set(key, value);
			this.fgColors.set(key, fgAnsi(value, mode));
		}
		this.bgValues = new Map();
		this.bgColors = new Map();
		for (const [key, value] of Object.entries(bgColors) as [ThemeBg, string | number][]) {
			this.bgValues.set(key, value);
			this.bgColors.set(key, bgAnsi(value, mode));
		}
	}

	fg(color: ThemeColor, text: string): string {
		const ansi = this.fgColors.get(color);
		if (!ansi) throw new Error(`Unknown theme color: ${color}`);
		return `${ansi}${text}\x1b[39m`; // Reset only foreground color
	}

	bg(color: ThemeBg, text: string): string {
		const ansi = this.bgColors.get(color);
		if (!ansi) throw new Error(`Unknown theme background color: ${color}`);
		return `${ansi}${text}\x1b[49m`; // Reset only background color
	}

	bold(text: string): string {
		return chalk.bold(text);
	}

	italic(text: string): string {
		return chalk.italic(text);
	}

	underline(text: string): string {
		return chalk.underline(text);
	}

	getFgAnsi(color: ThemeColor): string {
		const ansi = this.fgColors.get(color);
		if (!ansi) throw new Error(`Unknown theme color: ${color}`);
		return ansi;
	}

	getBgAnsi(color: ThemeBg): string {
		const ansi = this.bgColors.get(color);
		if (!ansi) throw new Error(`Unknown theme background color: ${color}`);
		return ansi;
	}

	getBgAnsiFromThemeColor(color: ThemeColor): string {
		const value = this.fgValues.get(color);
		if (value === undefined) throw new Error(`Unknown theme color: ${color}`);
		return bgAnsi(value, this.mode);
	}

	getFgAnsiFromThemeBg(color: ThemeBg): string {
		const value = this.bgValues.get(color);
		if (value === undefined) throw new Error(`Unknown theme background color: ${color}`);
		return fgAnsi(value, this.mode);
	}

	getColorMode(): ColorMode {
		return this.mode;
	}

	getThinkingBorderColor(level: "off" | "minimal" | "low" | "medium" | "high" | "xhigh"): (str: string) => string {
		const color = this.getThinkingBorderThemeColor(level);
		return (str: string) => this.fg(color, str);
	}

	getThinkingBorderThemeColor(level: "off" | "minimal" | "low" | "medium" | "high" | "xhigh"): ThemeColor {
		// Map thinking levels to dedicated theme colors
		switch (level) {
			case "off":
				return "thinkingOff";
			case "minimal":
				return "thinkingMinimal";
			case "low":
				return "thinkingLow";
			case "medium":
				return "thinkingMedium";
			case "high":
				return "thinkingHigh";
			case "xhigh":
				return "thinkingXhigh";
			default:
				return "thinkingOff";
		}
	}

	getThinkingCursorAccentAnsi(level: "off" | "minimal" | "low" | "medium" | "high" | "xhigh"): CursorAccentAnsi {
		return this.getCursorAccentAnsiForThemeColor(this.getThinkingBorderThemeColor(level));
	}

	getCursorAccentAnsiForThemeColor(color: ThemeColor): CursorAccentAnsi {
		return {
			fgAnsi: this.getFgAnsiFromThemeBg("toolPendingBg"),
			bgAnsi: this.getBgAnsiFromThemeColor(color),
		};
	}
}

// ============================================================================
// Theme Loading
// ============================================================================

let BUILTIN_THEMES: Record<string, ThemeJson> | undefined;

function getBuiltinThemes(): Record<string, ThemeJson> {
	if (!BUILTIN_THEMES) {
		const darkPath = path.join(__dirname, "dark.json");
		const lightPath = path.join(__dirname, "light.json");
		const nervPath = path.join(__dirname, "nerv.json");
		BUILTIN_THEMES = {
			dark: JSON.parse(fs.readFileSync(darkPath, "utf-8")) as ThemeJson,
			light: JSON.parse(fs.readFileSync(lightPath, "utf-8")) as ThemeJson,
			nerv: JSON.parse(fs.readFileSync(nervPath, "utf-8")) as ThemeJson,
		};
	}
	return BUILTIN_THEMES;
}

function getThemesDir(): string {
	return path.join(os.homedir(), ".mu", "agent", "themes");
}

export function getAvailableThemes(): string[] {
	const themes = new Set<string>(Object.keys(getBuiltinThemes()));
	const themesDir = getThemesDir();
	if (fs.existsSync(themesDir)) {
		const files = fs.readdirSync(themesDir);
		for (const file of files) {
			if (file.endsWith(".json")) {
				themes.add(file.slice(0, -5));
			}
		}
	}
	return Array.from(themes).sort();
}

function loadThemeJson(name: string): ThemeJson {
	const builtinThemes = getBuiltinThemes();
	if (name in builtinThemes) {
		return builtinThemes[name];
	}
	const themesDir = getThemesDir();
	const themePath = path.join(themesDir, `${name}.json`);
	if (!fs.existsSync(themePath)) {
		throw new Error(`Theme not found: ${name}`);
	}
	const content = fs.readFileSync(themePath, "utf-8");
	let json: unknown;
	try {
		json = JSON.parse(content);
	} catch (error) {
		throw new Error(`Failed to parse theme ${name}: ${error}`);
	}
	if (!validateThemeJson.Check(json)) {
		const errors = Array.from(validateThemeJson.Errors(json));
		const errorMessages = errors.map((e) => `  - ${e.path}: ${e.message}`).join("\n");
		throw new Error(`Invalid theme ${name}:\n${errorMessages}`);
	}
	return json as ThemeJson;
}

function createTheme(themeJson: ThemeJson, mode?: ColorMode): Theme {
	const colorMode = mode ?? detectColorMode();
	const resolvedColors = resolveThemeColors(themeJson.colors, themeJson.vars);
	const fgColors: Record<ThemeColor, string | number> = {} as Record<ThemeColor, string | number>;
	const bgColors: Record<ThemeBg, string | number> = {} as Record<ThemeBg, string | number>;
	const bgColorKeys: Set<string> = new Set(["userMessageBg", "toolPendingBg", "toolSuccessBg", "toolErrorBg"]);
	for (const [key, value] of Object.entries(resolvedColors)) {
		if (bgColorKeys.has(key)) {
			bgColors[key as ThemeBg] = value;
		} else {
			fgColors[key as ThemeColor] = value;
		}
	}
	return new Theme(fgColors, bgColors, colorMode);
}

function loadTheme(name: string, mode?: ColorMode): Theme {
	const themeJson = loadThemeJson(name);
	return createTheme(themeJson, mode);
}

function detectTerminalBackground(): "dark" | "light" {
	const colorfgbg = process.env.COLORFGBG || "";
	if (colorfgbg) {
		const parts = colorfgbg.split(";");
		if (parts.length >= 2) {
			const bg = parseInt(parts[1], 10);
			if (!Number.isNaN(bg)) {
				const result = bg < 8 ? "dark" : "light";
				return result;
			}
		}
	}
	return "dark";
}

function getDefaultTheme(): string {
	return "nerv";
}

// ============================================================================
// Global Theme Instance
// ============================================================================

export let theme: Theme;
let currentThemeName: string | undefined;
let themeWatcher: fs.FSWatcher | undefined;
let onThemeChangeCallback: (() => void) | undefined;

function applyThemeRuntimeBindings(): void {
	setCursorAccentAnsi(theme.getFgAnsiFromThemeBg("toolPendingBg"), theme.getBgAnsiFromThemeColor("accent"));
}

export function initTheme(themeName?: string): void {
	const name = themeName ?? getDefaultTheme();
	currentThemeName = name;
	try {
		theme = loadTheme(name);
		applyThemeRuntimeBindings();
		startThemeWatcher();
	} catch (error) {
		// Theme is invalid - fall back to dark theme silently
		currentThemeName = "dark";
		theme = loadTheme("dark");
		applyThemeRuntimeBindings();
		// Don't start watcher for fallback theme
	}
}

export function setTheme(name: string): { success: boolean; error?: string } {
	currentThemeName = name;
	try {
		theme = loadTheme(name);
		applyThemeRuntimeBindings();
		startThemeWatcher();
		return { success: true };
	} catch (error) {
		// Theme is invalid - fall back to dark theme
		currentThemeName = "dark";
		theme = loadTheme("dark");
		applyThemeRuntimeBindings();
		// Don't start watcher for fallback theme
		return {
			success: false,
			error: error instanceof Error ? error.message : String(error),
		};
	}
}

export function onThemeChange(callback: () => void): void {
	onThemeChangeCallback = callback;
}

function startThemeWatcher(): void {
	// Stop existing watcher if any
	if (themeWatcher) {
		themeWatcher.close();
		themeWatcher = undefined;
	}

	// Only watch if it's a custom theme (not built-in)
	if (!currentThemeName || currentThemeName in getBuiltinThemes()) {
		return;
	}

	const themesDir = getThemesDir();
	const themeFile = path.join(themesDir, `${currentThemeName}.json`);

	// Only watch if the file exists
	if (!fs.existsSync(themeFile)) {
		return;
	}

	try {
		themeWatcher = fs.watch(themeFile, (eventType) => {
			if (eventType === "change") {
				// Debounce rapid changes
				setTimeout(() => {
					try {
						// Reload the theme
						theme = loadTheme(currentThemeName!);
						applyThemeRuntimeBindings();
						// Notify callback (to invalidate UI)
						if (onThemeChangeCallback) {
							onThemeChangeCallback();
						}
					} catch (error) {
						// Ignore errors (file might be in invalid state while being edited)
					}
				}, 100);
			} else if (eventType === "rename") {
				// File was deleted or renamed - fall back to default theme
				setTimeout(() => {
					if (!fs.existsSync(themeFile)) {
						currentThemeName = "dark";
						theme = loadTheme("dark");
						applyThemeRuntimeBindings();
						if (themeWatcher) {
							themeWatcher.close();
							themeWatcher = undefined;
						}
						if (onThemeChangeCallback) {
							onThemeChangeCallback();
						}
					}
				}, 100);
			}
		});
	} catch (error) {
		// Ignore errors starting watcher
	}
}

export function stopThemeWatcher(): void {
	if (themeWatcher) {
		themeWatcher.close();
		themeWatcher = undefined;
	}
}

// ============================================================================
// Ghostty Theme Sync Integration
// ============================================================================

import type { SettingsManager } from "../settings-manager.js";
import { getOrCreateGhosttyTheme, isGhosttyAvailable, isRunningInGhostty } from "./ghostty-sync.js";

/**
 * Initialize theme with Ghostty sync support.
 * Uses "respectful sync": only syncs if user hasn't explicitly chosen a non-Ghostty theme.
 * If running in Ghostty and no explicit theme saved, generates/uses a synced theme.
 * Otherwise, uses the saved theme from settings.
 * @param settingsManager Settings manager to read/save theme preference
 */
export function initThemeWithGhostty(settingsManager: SettingsManager): void {
	const savedTheme = settingsManager.getTheme();

	// Check if we should use Ghostty sync:
	// - Must be running in Ghostty with CLI available
	// - Either no theme saved, or already using a ghostty-sync theme
	if (isRunningInGhostty() && isGhosttyAvailable()) {
		const isGhosttyTheme = savedTheme?.startsWith("ghostty-sync-");

		if (!savedTheme || isGhosttyTheme) {
			const result = getOrCreateGhosttyTheme();
			if (result) {
				// Use the Ghostty-synced theme
				initTheme(result.name);
				// Save to settings for persistence (only if it's new or different)
				if (result.name !== savedTheme) {
					settingsManager.setTheme(result.name);
				}
				return;
			}
		}
	}

	// Fall back to saved theme (or default if none)
	initTheme(savedTheme);
}

// ============================================================================
// TUI Helpers
// ============================================================================

export function getMarkdownTheme(): MarkdownTheme {
	return {
		heading: (text: string) => theme.fg("mdHeading", text),
		link: (text: string) => theme.fg("mdLink", text),
		linkUrl: (text: string) => theme.fg("mdLinkUrl", text),
		code: (text: string) => theme.fg("mdCode", text),
		codeBlock: (text: string) => theme.fg("mdCodeBlock", text),
		codeBlockBorder: (text: string) => theme.fg("mdCodeBlockBorder", text),
		quote: (text: string) => theme.fg("mdQuote", text),
		quoteBorder: (text: string) => theme.fg("mdQuoteBorder", text),
		hr: (text: string) => theme.fg("mdHr", text),
		listBullet: (text: string) => theme.fg("mdListBullet", text),
		bold: (text: string) => theme.bold(text),
		italic: (text: string) => theme.italic(text),
		underline: (text: string) => theme.underline(text),
		strikethrough: (text: string) => chalk.strikethrough(text),
	};
}

export function getSelectListTheme(): SelectListTheme {
	return {
		selectedPrefix: (text: string) => theme.fg("accent", text),
		selectedText: (text: string) => `\x1b[1m${theme.fg("accent", text)}\x1b[22m`,
		description: (text: string) => theme.fg("muted", text),
		scrollInfo: (text: string) => theme.fg("muted", text),
		noMatch: (text: string) => theme.fg("muted", text),
	};
}

export function getEditorTheme(): EditorTheme {
	return {
		borderColor: (text: string) => theme.fg("borderMuted", text),
		cursorAccentAnsi: theme.getCursorAccentAnsiForThemeColor("accent"),
		selectList: getSelectListTheme(),
	};
}

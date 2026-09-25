/**
 * The `system` theme: pi's colors derived from the terminal's own theme.
 *
 * Every token has a role (how far it must stand out from the background) and an ANSI palette slot
 * (where its hue comes from). Lightness is placed by contrast in OKLab lightness (L, 0-1): each role
 * keeps at least a minimum |ΔL| and WCAG ratio to the background and the panels it is drawn on. Hue and
 * saturation come from the terminal's palette color for the token's slot, so pi matches the terminal theme.
 * Saturation is relative to the sRGB gamut at each lightness and hue, so a pastel palette color stays
 * pastel and a vivid one stays vivid when its lightness moves.
 *
 * Depending on what the terminal reports, the theme is generated in one of three tiers:
 * - background and palette: hues from the palette, lightness from the background;
 * - background only: built-in hues, lightness from the background;
 * - nothing: ANSI palette indices and the default colors, which the terminal renders itself.
 */

import {
	colorToOklch,
	colorToRgb,
	maxOklchChroma,
	type OklchChannels,
	oklchColor,
	type RgbColor,
	rgbColor,
} from "@earendil-works/pi-tui";
import type { ThemeAppearance, ThemeBg, ThemeColor, ThemeToken } from "./theme.ts";

export const SYSTEM_THEME_NAME = "system";

/** How strongly a token stands out from the background, weakest to strongest; panels are backgrounds. */
type Role = "surface" | "message" | "highlight" | "faint" | "dim" | "muted" | "strong" | "text";

interface TokenSpec {
	role: Role;
	/** ANSI palette slot the hue comes from; undefined for neutral tokens. */
	slot?: number;
}

const RED = 1;
const GREEN = 2;
const YELLOW = 3;
const BLUE = 4;
const MAGENTA = 5;
const CYAN = 6;
const BRIGHT_MAGENTA = 13;

const FOREGROUND_TOKENS: Record<ThemeColor, TokenSpec> = {
	text: { role: "text" },
	userMessageText: { role: "text" },
	customMessageText: { role: "text" },
	toolTitle: { role: "text" },
	searchMatchText: { role: "text" },
	scrollbarThumb: { role: "text" },
	syntaxOperator: { role: "text" },
	syntaxPunctuation: { role: "text" },

	accent: { role: "strong", slot: CYAN },
	borderAccent: { role: "strong", slot: CYAN },
	success: { role: "strong", slot: GREEN },
	error: { role: "strong", slot: RED },
	warning: { role: "strong", slot: YELLOW },
	customMessageLabel: { role: "strong", slot: MAGENTA },
	mdHeading: { role: "strong", slot: YELLOW },
	mdLink: { role: "strong", slot: BLUE },
	mdCode: { role: "strong", slot: CYAN },
	mdCodeBlock: { role: "strong", slot: GREEN },
	mdListBullet: { role: "strong", slot: CYAN },
	toolDiffAdded: { role: "strong", slot: GREEN },
	toolDiffRemoved: { role: "strong", slot: RED },
	syntaxKeyword: { role: "strong", slot: MAGENTA },
	syntaxFunction: { role: "strong", slot: BLUE },
	syntaxVariable: { role: "strong", slot: CYAN },
	syntaxString: { role: "strong", slot: GREEN },
	syntaxNumber: { role: "strong", slot: RED },
	syntaxType: { role: "strong", slot: YELLOW },
	thinkingMedium: { role: "strong", slot: CYAN },
	thinkingHigh: { role: "strong", slot: MAGENTA },
	thinkingXhigh: { role: "strong", slot: BRIGHT_MAGENTA },
	thinkingMax: { role: "strong", slot: RED },
	bashMode: { role: "strong", slot: GREEN },

	border: { role: "muted", slot: BLUE },
	thinkingLow: { role: "muted", slot: BLUE },
	muted: { role: "muted" },
	thinkingText: { role: "muted" },
	toolOutput: { role: "muted" },
	mdQuote: { role: "muted" },
	mdCodeBlockBorder: { role: "muted" },
	toolDiffContext: { role: "muted" },
	syntaxComment: { role: "muted" },

	dim: { role: "dim" },
	mdLinkUrl: { role: "dim" },
	mdQuoteBorder: { role: "dim" },
	mdHr: { role: "dim" },
	thinkingMinimal: { role: "dim" },

	borderMuted: { role: "faint" },
	scrollbarTrack: { role: "faint" },
	thinkingOff: { role: "faint" },
};

const BACKGROUND_TOKENS: Record<ThemeBg, TokenSpec> = {
	toolPendingBg: { role: "surface" },
	toolSuccessBg: { role: "surface", slot: GREEN },
	toolErrorBg: { role: "surface", slot: RED },
	customMessageBg: { role: "surface", slot: MAGENTA },
	userMessageBg: { role: "message" },
	selectedBg: { role: "highlight", slot: BLUE },
	searchMatchBg: { role: "highlight", slot: YELLOW },
};

/**
 * Minimum |ΔL| per role and appearance. Panels are measured from the terminal background;
 * foreground roles from the strongest surface or message panel, since text sits on those too.
 * Calibrated against pi's built-in dark and light themes.
 */
const MINIMUM_CONTRAST: Record<Role, Record<ThemeAppearance, number>> = {
	surface: { dark: 0.055, light: 0.05 },
	message: { dark: 0.085, light: 0.065 },
	highlight: { dark: 0.13, light: 0.13 },
	faint: { dark: 0.14, light: 0.18 },
	dim: { dark: 0.22, light: 0.33 },
	muted: { dark: 0.3, light: 0.4 },
	strong: { dark: 0.42, light: 0.42 },
	text: { dark: 0.56, light: 0.66 },
};

/**
 * Minimum WCAG 2 contrast ratio per role, against the same surfaces as the |ΔL| minimum. OKLab lightness
 * differences near black are hard to see on real displays; the WCAG ratio's flare term covers that end.
 */
const MINIMUM_WCAG_CONTRAST: Record<Role, number> = {
	surface: 1.15,
	message: 1.25,
	highlight: 1.45,
	faint: 1.7,
	dim: 2.3,
	muted: 3,
	strong: 3.6,
	text: 4.5,
};

/** The next stronger role: a palette color may keep its own lightness up to that role's minimum. */
const ROLE_CEILING: Partial<Record<Role, Role>> = { faint: "dim", dim: "muted", muted: "strong", strong: "text" };

/** WCAG 2 contrast ratio that body text must reach on the background and every panel. */
const TEXT_MINIMUM_WCAG_CONTRAST = MINIMUM_WCAG_CONTRAST.text;

/** Neutral text stays near gray: an absolute OKLCH chroma cap on the tint it takes from the terminal. */
const NEUTRAL_MAX_CHROMA = 0.035;
/** Colored panels keep this share of their palette color's relative saturation, so they stay calm. */
const PANEL_SATURATION = 0.3;

/** A hue with a saturation relative to the sRGB gamut (0-1), optionally capped to an absolute chroma. */
interface Tint {
	h: number;
	s: number;
	maxChroma?: number;
}

/** Hues for terminals that report a background but no palette, by slot. */
const BUILTIN_TINTS: Record<number, Tint> = {
	[RED]: { h: 25, s: 0.65 },
	[GREEN]: { h: 145, s: 0.6 },
	[YELLOW]: { h: 90, s: 0.65 },
	[BLUE]: { h: 255, s: 0.55 },
	[MAGENTA]: { h: 320, s: 0.55 },
	[CYAN]: { h: 200, s: 0.55 },
};

export interface SystemThemeInput {
	foreground?: RgbColor;
	background?: RgbColor;
	/** ANSI colors 0-15. */
	palette?: RgbColor[];
	/** Saturation multiplier from 0 (grayscale) to 1. The first frame renders in grayscale until colors arrive. */
	saturation?: number;
	/** Appearance when the terminal did not report its background, e.g. from COLORFGBG. */
	appearanceHint?: ThemeAppearance;
}

export interface SystemThemeColors {
	/** Hex colors, ANSI palette indices, or "" for the terminal default. */
	colors: Record<ThemeToken, string | number>;
	/** Foreground tokens rendered faint (SGR 2), for terminals that did not report colors. */
	dim: ThemeColor[];
	appearance: ThemeAppearance | undefined;
}

/** OKLab lightness of an sRGB color, 0-1. */
export function oklabLightness(color: RgbColor): number {
	return colorToOklch(rgbColor(color.r, color.g, color.b)).l;
}

/** WCAG 2 relative luminance. */
export function relativeLuminance({ r, g, b }: RgbColor): number {
	const linear = (channel: number) => {
		const value = channel / 255;
		return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
	};
	return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
}

/** WCAG 2 contrast ratio, 1-21. */
export function wcagContrast(first: RgbColor, second: RgbColor): number {
	const a = relativeLuminance(first);
	const b = relativeLuminance(second);
	return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

/**
 * Whether a terminal is dark or light, from its reported colors: the direction of its own foreground
 * when text can be readable that way, otherwise dark when white text has more contrast on the
 * background than black text.
 */
export function terminalAppearance(background: RgbColor, foreground?: RgbColor): ThemeAppearance {
	const white = { r: 255, g: 255, b: 255 };
	const black = { r: 0, g: 0, b: 0 };
	const whiteContrast = wcagContrast(white, background);
	const blackContrast = wcagContrast(black, background);
	if (foreground) {
		const foregroundL = oklabLightness(foreground);
		const backgroundL = oklabLightness(background);
		if (Math.abs(foregroundL - backgroundL) > 0.05) {
			const appearance = foregroundL > backgroundL ? "dark" : "light";
			const best = appearance === "dark" ? whiteContrast : blackContrast;
			if (best >= TEXT_MINIMUM_WCAG_CONTRAST) return appearance;
		}
	}
	return whiteContrast >= blackContrast ? "dark" : "light";
}

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

function hexOf(rgb: RgbColor): string {
	return `#${[rgb.r, rgb.g, rgb.b].map((channel) => channel.toString(16).padStart(2, "0")).join("")}`;
}

/** The tint of a color: its hue and its chroma relative to the most the gamut allows at its lightness. */
function tintOf({ l, c, h }: OklchChannels): Tint {
	const max = maxOklchChroma(l, h);
	return { h, s: max > 1e-4 ? clamp(c / max, 0, 1) : 0 };
}

/** An sRGB color at OKLab lightness `l` with a tint's hue and relative saturation. */
function colorAt(l: number, tint: Tint): RgbColor {
	const lightness = clamp(l, 0, 1);
	const chroma = Math.min(tint.s * maxOklchChroma(lightness, tint.h), tint.maxChroma ?? Number.POSITIVE_INFINITY);
	return colorToRgb(oklchColor(lightness, chroma, tint.h));
}

/**
 * Generate the system theme's colors from the terminal's reported colors.
 */
export function generateSystemThemeColors(input: SystemThemeInput): SystemThemeColors {
	const saturation = clamp(input.saturation ?? 1, 0, 1);
	const { background, foreground } = input;
	if (!background) return indexedColors(saturation, input.appearanceHint);
	const palette = input.palette?.length === 16 ? input.palette : undefined;

	const appearance = terminalAppearance(background, foreground);
	const direction = appearance === "dark" ? 1 : -1;
	const backgroundLch = colorToOklch(rgbColor(background.r, background.g, background.b));
	const backgroundL = backgroundLch.l;

	// Backgrounds near mid-gray cannot fit every minimum: scale them down together to keep the order.
	const minimums = Object.fromEntries(
		Object.entries(MINIMUM_CONTRAST).map(([role, values]) => [role, values[appearance]]),
	) as Record<Role, number>;
	const needed = Math.max(minimums.surface, minimums.message) + minimums.text;
	const room = appearance === "dark" ? 1 - backgroundL : backgroundL;
	const scale = needed > room ? room / needed : 1;
	const minimum = (role: Role) => minimums[role] * scale;

	/** Tint for a slot, from the palette or the built-in tints, with the palette color's lightness. */
	const source = (slot: number): { tint: Tint; l: number | undefined } => {
		if (palette) {
			const lch = colorToOklch(rgbColor(palette[slot].r, palette[slot].g, palette[slot].b));
			return { tint: tintOf(lch), l: lch.l };
		}
		return { tint: BUILTIN_TINTS[slot % 8] ?? BUILTIN_TINTS[CYAN], l: undefined };
	};
	const desaturate = (tint: Tint): Tint => ({
		...tint,
		s: tint.s * saturation,
		maxChroma: tint.maxChroma === undefined ? undefined : tint.maxChroma * saturation,
	});
	/**
	 * Neutral colors keep their source's absolute chroma: a near-white or near-black tint is a large share
	 * of the tiny gamut there, and scaling it relatively would turn it into a strong color elsewhere.
	 */
	const neutralTint = ({ c, h }: OklchChannels, maxChroma = Number.POSITIVE_INFINITY): Tint => ({
		h,
		s: 1,
		maxChroma: Math.min(c, maxChroma),
	});

	const colors: Partial<Record<ThemeToken, RgbColor | "">> = {};

	// Panels: offsets from the background, neutral ones in the background's own tint.
	const panels: RgbColor[] = [];
	let surfaceTopL = backgroundL;
	for (const [token, spec] of Object.entries(BACKGROUND_TOKENS) as [ThemeBg, TokenSpec][]) {
		// Neutral panels are the background shifted in lightness, keeping its tint.
		let tint = neutralTint(backgroundLch);
		if (spec.slot !== undefined) {
			const { tint: slotTint } = source(spec.slot);
			tint = { h: slotTint.h, s: slotTint.s * PANEL_SATURATION };
		}
		tint = desaturate(tint);
		const offset = backgroundL + direction * minimum(spec.role);
		const visible = reachContrast(offset, tint, direction, [background], MINIMUM_WCAG_CONTRAST[spec.role]);
		const l = panelLightness(backgroundL, visible, tint, direction);
		const color = colorAt(l, tint);
		colors[token] = color;
		panels.push(color);
		if (spec.role !== "highlight") {
			surfaceTopL = appearance === "dark" ? Math.max(surfaceTopL, l) : Math.min(surfaceTopL, l);
		}
	}

	// Foreground tokens: at least their role's minimum beyond the strongest surface. Palette colors keep
	// their own lightness when it already lies between their role's minimum and the next role's.
	const foregroundLch = foreground ? colorToOklch(rgbColor(foreground.r, foreground.g, foreground.b)) : undefined;
	// Body text must be readable on every panel; other text on the background and the content panels.
	const surfaces = [background, ...panels];
	const contentSurfaces = [
		background,
		...(Object.entries(BACKGROUND_TOKENS) as [ThemeBg, TokenSpec][])
			.filter(([, spec]) => spec.role !== "highlight")
			.map(([token]) => colors[token] as RgbColor),
	];
	for (const [token, spec] of Object.entries(FOREGROUND_TOKENS) as [ThemeColor, TokenSpec][]) {
		const { tint, l: sourceL } =
			spec.slot !== undefined
				? source(spec.slot)
				: {
						// Body text takes the foreground's tint, secondary text the background's, both near gray.
						tint: neutralTint(
							spec.role === "text" ? (foregroundLch ?? backgroundLch) : backgroundLch,
							NEUTRAL_MAX_CHROMA,
						),
						l: undefined,
					};
		const lowest = surfaceTopL + direction * minimum(spec.role);
		const ceilingRole = ROLE_CEILING[spec.role];
		const highest = ceilingRole ? surfaceTopL + direction * minimum(ceilingRole) : appearance === "dark" ? 1 : 0;
		const [low, high] = direction > 0 ? [lowest, highest] : [highest, lowest];
		const l = sourceL === undefined ? lowest : clamp(sourceL, low, high);
		const readableOn = spec.role === "text" ? surfaces : contentSurfaces;
		const paint = desaturate(tint);
		colors[token] = colorAt(reachContrast(l, paint, direction, readableOn, MINIMUM_WCAG_CONTRAST[spec.role]), paint);
	}

	// Body text uses the terminal's own foreground when it is readable and clearly stronger than muted text.
	if (foreground && foregroundLch && usableForeground(foreground, foregroundLch.l, direction, surfaces, colors)) {
		for (const [token, spec] of Object.entries(FOREGROUND_TOKENS) as [ThemeColor, TokenSpec][]) {
			if (spec.role === "text") colors[token] = "";
		}
	}

	const result = {} as Record<ThemeToken, string | number>;
	for (const [token, color] of Object.entries(colors) as [ThemeToken, RgbColor | ""][]) {
		result[token] = color === "" ? "" : hexOf(color);
	}
	return { colors: result, dim: [], appearance };
}

/**
 * Limit a panel's lightness so that text can still reach the WCAG minimum on it. This only matters for
 * backgrounds near mid-gray, where even black or white text barely reaches it on the background itself.
 */
function panelLightness(backgroundL: number, l: number, tint: Tint, direction: number): number {
	const extreme = direction > 0 ? { r: 255, g: 255, b: 255 } : { r: 0, g: 0, b: 0 };
	const readable = (candidate: number) =>
		wcagContrast(extreme, colorAt(candidate, tint)) >= TEXT_MINIMUM_WCAG_CONTRAST;
	if (readable(l)) return l;
	let [low, high] = [backgroundL, l];
	for (let index = 0; index < 20; index++) {
		const middle = (low + high) / 2;
		if (readable(middle)) low = middle;
		else high = middle;
	}
	return low;
}

/**
 * The lightness at or beyond `l` (toward white for dark themes, black for light themes) closest to `l`
 * where the color reaches a WCAG contrast ratio on every surface, or the extreme if none does.
 */
function reachContrast(l: number, tint: Tint, direction: number, surfaces: RgbColor[], ratio: number): number {
	const meets = (candidate: number) => {
		const color = colorAt(candidate, tint);
		return surfaces.every((surface) => wcagContrast(color, surface) >= ratio);
	};
	if (meets(l)) return l;
	const extreme = direction > 0 ? 1 : 0;
	if (!meets(extreme)) return extreme;
	let [low, high] = [l, extreme];
	for (let index = 0; index < 20; index++) {
		const middle = (low + high) / 2;
		if (meets(middle)) high = middle;
		else low = middle;
	}
	return high;
}

function usableForeground(
	foreground: RgbColor,
	foregroundL: number,
	direction: number,
	surfaces: RgbColor[],
	colors: Partial<Record<ThemeToken, RgbColor | "">>,
): boolean {
	const muted = colors.muted;
	if (!muted) return false;
	const margin = (foregroundL - oklabLightness(muted)) * direction;
	return (
		margin >= 0.08 && surfaces.every((surface) => wcagContrast(foreground, surface) >= TEXT_MINIMUM_WCAG_CONTRAST)
	);
}

/**
 * Colors for terminals that reported nothing: the terminal renders ANSI indices 0-15 and the default
 * colors with its own theme, so they fit any background. Neutral tokens below body text are faint (SGR 2)
 * instead of bright black, which some themes make nearly invisible. Panels have no background.
 */
function indexedColors(saturation: number, appearance: ThemeAppearance | undefined): SystemThemeColors {
	const colors = {} as Record<ThemeToken, string | number>;
	const dim: ThemeColor[] = [];
	for (const [token, spec] of Object.entries(FOREGROUND_TOKENS) as [ThemeColor, TokenSpec][]) {
		colors[token] = spec.slot !== undefined && saturation > 0 ? spec.slot : "";
		if (spec.slot === undefined && spec.role !== "text") dim.push(token);
	}
	for (const token of Object.keys(BACKGROUND_TOKENS) as ThemeBg[]) {
		colors[token] = "";
	}
	return { colors, dim, appearance };
}

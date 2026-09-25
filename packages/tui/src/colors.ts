import { linearSrgbToOklab, linearToSrgb, okhslToRgb, oklabToLinearSrgb, rgbToOkhsl, srgbToLinear } from "./oklab.ts";
import type { RgbColor } from "./terminal-colors.ts";

export interface IndexedColor {
	readonly kind: "indexed";
	readonly index: number;
}

export interface RgbColorValue {
	readonly kind: "rgb";
	readonly r: number;
	readonly g: number;
	readonly b: number;
}

export interface OklchColorValue {
	readonly kind: "oklch";
	readonly l: number;
	readonly c: number;
	readonly h: number;
}

/** A concrete color. Every color can be converted to sRGB, so color math never fails. */
export type Color = IndexedColor | RgbColorValue | OklchColorValue;
export type TerminalColorMode = "256color" | "truecolor";
export type ColorMixSpace = "oklch" | "srgb";

export interface OklchChannels {
	l: number;
	c: number;
	h: number;
}

/**
 * OKHSL channels: hue in degrees, saturation and lightness 0-1. Saturation is relative to the most the
 * sRGB gamut allows at that hue and lightness, so every value is in gamut.
 */
export interface OkhslChannels {
	h: number;
	s: number;
	l: number;
}

export interface TextAttributes {
	bold?: boolean;
	dim?: boolean;
	italic?: boolean;
	underline?: boolean;
	inverse?: boolean;
	strikethrough?: boolean;
}

export interface TextStyle extends TextAttributes {
	fg?: Color;
	bg?: Color;
}

function requireFinite(value: number, name: string): void {
	if (!Number.isFinite(value)) throw new Error(`${name} must be finite`);
}

export function indexedColor(index: number): IndexedColor {
	if (!Number.isInteger(index) || index < 0 || index > 255) {
		throw new Error(`ANSI color index must be an integer from 0 to 255: ${index}`);
	}
	return Object.freeze({ kind: "indexed", index });
}

export function rgbColor(r: number, g: number, b: number): RgbColorValue {
	for (const [name, value] of [
		["r", r],
		["g", g],
		["b", b],
	] as const) {
		requireFinite(value, name);
		if (value < 0 || value > 255) throw new Error(`${name} must be between 0 and 255: ${value}`);
	}
	return Object.freeze({ kind: "rgb", r, g, b });
}

export function oklchColor(l: number, c: number, h: number): OklchColorValue {
	requireFinite(l, "l");
	requireFinite(c, "c");
	requireFinite(h, "h");
	if (l < 0 || l > 1) throw new Error(`l must be between 0 and 1: ${l}`);
	if (c < 0) throw new Error(`c must not be negative: ${c}`);
	return Object.freeze({ kind: "oklch", l, c, h: ((h % 360) + 360) % 360 });
}

const NUMBER_PATTERN = String.raw`[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?`;
const OKLCH_PATTERN = new RegExp(
	`^oklch\\(\\s*(${NUMBER_PATTERN})(%)?\\s+(${NUMBER_PATTERN})\\s+(${NUMBER_PATTERN})(?:deg)?\\s*\\)$`,
	"i",
);
const OKHSL_PATTERN = new RegExp(
	`^okhsl\\(\\s*(${NUMBER_PATTERN})(?:deg)?\\s+(${NUMBER_PATTERN})(%)?\\s+(${NUMBER_PATTERN})(%)?\\s*\\)$`,
	"i",
);

/**
 * An OKHSL color, converted to sRGB. Saturation is relative to the sRGB gamut at the hue and lightness,
 * so equal saturation looks equally colorful across hues and lightness.
 * @param h Hue in degrees.
 * @param s Saturation, 0-1.
 * @param l Lightness, 0-1.
 */
export function okhslColor(h: number, s: number, l: number): RgbColorValue {
	requireFinite(h, "h");
	requireFinite(s, "s");
	requireFinite(l, "l");
	if (s < 0 || s > 1) throw new Error(`s must be between 0 and 1: ${s}`);
	if (l < 0 || l > 1) throw new Error(`l must be between 0 and 1: ${l}`);
	const { r, g, b } = okhslToRgb(h, s, l);
	return rgbColor(r, g, b);
}

export function colorToOkhsl(color: Color): OkhslChannels {
	const { hue, saturation, lightness } = rgbToOkhsl(colorToRgb(color));
	return { h: hue, s: saturation, l: lightness };
}

export function parseColor(value: string | number): Color {
	if (typeof value === "number") return indexedColor(value);

	const hex = /^#([\da-f]{3}|[\da-f]{6})$/i.exec(value);
	if (hex) {
		const digits = hex[1].length === 3 ? [...hex[1]].map((digit) => digit + digit).join("") : hex[1];
		return rgbColor(
			Number.parseInt(digits.slice(0, 2), 16),
			Number.parseInt(digits.slice(2, 4), 16),
			Number.parseInt(digits.slice(4, 6), 16),
		);
	}

	const oklch = OKLCH_PATTERN.exec(value);
	if (oklch) {
		const lightness = Number.parseFloat(oklch[1]) / (oklch[2] ? 100 : 1);
		return oklchColor(lightness, Number.parseFloat(oklch[3]), Number.parseFloat(oklch[4]));
	}

	const okhsl = OKHSL_PATTERN.exec(value);
	if (okhsl) {
		const saturation = Number.parseFloat(okhsl[2]) / (okhsl[3] ? 100 : 1);
		const lightness = Number.parseFloat(okhsl[4]) / (okhsl[5] ? 100 : 1);
		return okhslColor(Number.parseFloat(okhsl[1]), saturation, lightness);
	}

	throw new Error(`Invalid color value: ${value}`);
}

const BASIC_COLORS: readonly RgbColor[] = [
	{ r: 0, g: 0, b: 0 },
	{ r: 128, g: 0, b: 0 },
	{ r: 0, g: 128, b: 0 },
	{ r: 128, g: 128, b: 0 },
	{ r: 0, g: 0, b: 128 },
	{ r: 128, g: 0, b: 128 },
	{ r: 0, g: 128, b: 128 },
	{ r: 192, g: 192, b: 192 },
	{ r: 128, g: 128, b: 128 },
	{ r: 255, g: 0, b: 0 },
	{ r: 0, g: 255, b: 0 },
	{ r: 255, g: 255, b: 0 },
	{ r: 0, g: 0, b: 255 },
	{ r: 255, g: 0, b: 255 },
	{ r: 0, g: 255, b: 255 },
	{ r: 255, g: 255, b: 255 },
];
const CUBE_VALUES = [0, 95, 135, 175, 215, 255] as const;
const GRAY_VALUES = Array.from({ length: 24 }, (_, index) => 8 + index * 10);

function indexedToRgb(index: number): RgbColor {
	if (index < 16) return { ...BASIC_COLORS[index] };
	if (index < 232) {
		const cubeIndex = index - 16;
		return {
			r: CUBE_VALUES[Math.floor(cubeIndex / 36)],
			g: CUBE_VALUES[Math.floor((cubeIndex % 36) / 6)],
			b: CUBE_VALUES[cubeIndex % 6],
		};
	}
	const gray = 8 + (index - 232) * 10;
	return { r: gray, g: gray, b: gray };
}

interface OklabChannels {
	l: number;
	a: number;
	b: number;
}

interface LinearRgbChannels {
	r: number;
	g: number;
	b: number;
}

function rgbToOklab({ r, g, b }: RgbColor): OklabChannels {
	const [l, a, labB] = linearSrgbToOklab([srgbToLinear(r / 255), srgbToLinear(g / 255), srgbToLinear(b / 255)]);
	return { l, a, b: labB };
}

function oklabToLinearRgb({ l, a, b }: OklabChannels): LinearRgbChannels {
	const [r, g, linearB] = oklabToLinearSrgb([l, a, b]);
	return { r, g, b: linearB };
}

function isInSrgbGamut({ r, g, b }: LinearRgbChannels): boolean {
	const epsilon = 1e-7;
	return r >= -epsilon && r <= 1 + epsilon && g >= -epsilon && g <= 1 + epsilon && b >= -epsilon && b <= 1 + epsilon;
}

function linearRgbToChannels({ r, g, b }: LinearRgbChannels): RgbColor {
	return {
		r: Math.round(Math.max(0, Math.min(1, linearToSrgb(r))) * 255),
		g: Math.round(Math.max(0, Math.min(1, linearToSrgb(g))) * 255),
		b: Math.round(Math.max(0, Math.min(1, linearToSrgb(b))) * 255),
	};
}

function oklchToRgb({ l, c, h }: OklchChannels): RgbColor {
	// Gamut mapping keeps the hue fixed, so its direction is computed once and scaled by chroma.
	const radians = (h * Math.PI) / 180;
	const cos = Math.cos(radians);
	const sin = Math.sin(radians);
	const atChroma = (chroma: number) => oklabToLinearRgb({ l, a: chroma * cos, b: chroma * sin });

	const direct = atChroma(c);
	if (isInSrgbGamut(direct)) return linearRgbToChannels(direct);

	// Reduce chroma until the color fits. The achromatic color is always in gamut, so it is the
	// fallback when no bisection step fits, e.g. `oklch(100% 0.3 150)` must map to white.
	let linear = atChroma(0);
	let low = 0;
	let high = c;
	for (let index = 0; index < 20; index++) {
		const chroma = (low + high) / 2;
		const candidate = atChroma(chroma);
		if (isInSrgbGamut(candidate)) {
			low = chroma;
			linear = candidate;
		} else {
			high = chroma;
		}
	}
	return linearRgbToChannels(linear);
}

export function colorToRgb(color: Color): RgbColor {
	switch (color.kind) {
		case "indexed":
			return indexedToRgb(color.index);
		case "rgb":
			return { r: color.r, g: color.g, b: color.b };
		case "oklch":
			return oklchToRgb(color);
	}
}

export function colorToOklch(color: Color): OklchChannels {
	if (color.kind === "oklch") return { l: color.l, c: color.c, h: color.h };
	const lab = rgbToOklab(colorToRgb(color));
	return {
		l: lab.l,
		c: Math.hypot(lab.a, lab.b),
		h: ((Math.atan2(lab.b, lab.a) * 180) / Math.PI + 360) % 360,
	};
}

export function colorToHex(color: Color): string {
	const { r, g, b } = colorToRgb(color);
	const channel = (value: number) => Math.round(value).toString(16).padStart(2, "0");
	return `#${channel(r)}${channel(g)}${channel(b)}`;
}

export function mixColors(first: Color, second: Color, amount: number, space: ColorMixSpace = "oklch"): Color {
	requireFinite(amount, "amount");
	if (amount < 0 || amount > 1) throw new Error(`amount must be between 0 and 1: ${amount}`);

	if (space === "srgb") {
		const a = colorToRgb(first);
		const b = colorToRgb(second);
		return rgbColor(a.r + (b.r - a.r) * amount, a.g + (b.g - a.g) * amount, a.b + (b.b - a.b) * amount);
	}

	const a = colorToOklch(first);
	const b = colorToOklch(second);
	const firstHue = a.c < 1e-7 ? b.h : a.h;
	const secondHue = b.c < 1e-7 ? firstHue : b.h;
	const hueDelta = ((secondHue - firstHue + 540) % 360) - 180;
	return oklchColor(a.l + (b.l - a.l) * amount, a.c + (b.c - a.c) * amount, firstHue + hueDelta * amount);
}

function findClosest(values: readonly number[], target: number): number {
	let closestIndex = 0;
	let closestDistance = Infinity;
	for (let index = 0; index < values.length; index++) {
		const distance = Math.abs(target - values[index]);
		if (distance < closestDistance) {
			closestIndex = index;
			closestDistance = distance;
		}
	}
	return closestIndex;
}

function colorDistance(first: RgbColor, second: RgbColor): number {
	const dr = first.r - second.r;
	const dg = first.g - second.g;
	const db = first.b - second.b;
	return dr * dr * 0.299 + dg * dg * 0.587 + db * db * 0.114;
}

function rgbToAnsi256(color: RgbColor): number {
	const rIndex = findClosest(CUBE_VALUES, color.r);
	const gIndex = findClosest(CUBE_VALUES, color.g);
	const bIndex = findClosest(CUBE_VALUES, color.b);
	const cubeColor = { r: CUBE_VALUES[rIndex], g: CUBE_VALUES[gIndex], b: CUBE_VALUES[bIndex] };
	const cubeIndex = 16 + 36 * rIndex + 6 * gIndex + bIndex;

	const gray = Math.round(0.299 * color.r + 0.587 * color.g + 0.114 * color.b);
	const grayOffset = findClosest(GRAY_VALUES, gray);
	const grayValue = GRAY_VALUES[grayOffset];
	const spread = Math.max(color.r, color.g, color.b) - Math.min(color.r, color.g, color.b);
	if (
		spread < 10 &&
		colorDistance(color, { r: grayValue, g: grayValue, b: grayValue }) < colorDistance(color, cubeColor)
	) {
		return 232 + grayOffset;
	}
	return cubeIndex;
}

function colorAnsi(color: Color, mode: TerminalColorMode, background: boolean): string {
	if (color.kind === "indexed") return `\x1b[${background ? 48 : 38};5;${color.index}m`;

	const rgb = colorToRgb(color);
	if (mode === "truecolor") {
		return `\x1b[${background ? 48 : 38};2;${Math.round(rgb.r)};${Math.round(rgb.g)};${Math.round(rgb.b)}m`;
	}
	return `\x1b[${background ? 48 : 38};5;${rgbToAnsi256(rgb)}m`;
}

export function foregroundAnsi(color: Color, mode: TerminalColorMode): string {
	return colorAnsi(color, mode, false);
}

export function backgroundAnsi(color: Color, mode: TerminalColorMode): string {
	return colorAnsi(color, mode, true);
}

export function styleText(text: string, options: TextStyle, mode: TerminalColorMode): string {
	return styleTextWithAnsi(
		text,
		options.fg && foregroundAnsi(options.fg, mode),
		options.bg && backgroundAnsi(options.bg, mode),
		options,
	);
}

/**
 * Like `styleText()`, but with precomputed color escape sequences, e.g. cached theme colors.
 * Colors in `options` are ignored.
 */
export function styleTextWithAnsi(
	text: string,
	fgAnsi: string | undefined,
	bgAnsi: string | undefined,
	options: TextAttributes,
): string {
	// Resets are prepended so they close in reverse order of the opening sequences.
	let prefix = "";
	let suffix = "";
	if (fgAnsi) {
		prefix += fgAnsi;
		suffix = "\x1b[39m";
	}
	if (bgAnsi) {
		prefix += bgAnsi;
		suffix = `\x1b[49m${suffix}`;
	}
	if (options.bold) prefix += "\x1b[1m";
	if (options.dim) prefix += "\x1b[2m";
	if (options.bold || options.dim) suffix = `\x1b[22m${suffix}`;
	if (options.italic) {
		prefix += "\x1b[3m";
		suffix = `\x1b[23m${suffix}`;
	}
	if (options.underline) {
		prefix += "\x1b[4m";
		suffix = `\x1b[24m${suffix}`;
	}
	if (options.inverse) {
		prefix += "\x1b[7m";
		suffix = `\x1b[27m${suffix}`;
	}
	if (options.strikethrough) {
		prefix += "\x1b[9m";
		suffix = `\x1b[29m${suffix}`;
	}
	return `${prefix}${text}${suffix}`;
}

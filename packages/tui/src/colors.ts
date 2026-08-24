export interface DefaultColor {
	readonly kind: "default";
}

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

export type Color = DefaultColor | IndexedColor | RgbColorValue | OklchColorValue;
export type TerminalColorMode = "none" | "16color" | "256color" | "truecolor";
export type ColorMixSpace = "oklch" | "srgb";

export interface RgbChannels {
	r: number;
	g: number;
	b: number;
}

export interface OklchChannels {
	l: number;
	c: number;
	h: number;
}

export interface TextStyle {
	fg?: Color;
	bg?: Color;
	bold?: boolean;
	dim?: boolean;
	italic?: boolean;
	underline?: boolean;
	inverse?: boolean;
	strikethrough?: boolean;
}

export const defaultColor: DefaultColor = Object.freeze({ kind: "default" });

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

export function parseColor(value: string | number): Color {
	if (typeof value === "number") return indexedColor(value);
	if (value === "") return defaultColor;

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

	throw new Error(`Invalid color value: ${value}`);
}

const BASIC_COLORS: readonly RgbChannels[] = [
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

function indexedToRgb(index: number): RgbChannels {
	if (index < 16) return BASIC_COLORS[index];
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

function srgbToLinear(channel: number): number {
	return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
}

function linearToSrgb(channel: number): number {
	return channel <= 0.0031308 ? channel * 12.92 : 1.055 * channel ** (1 / 2.4) - 0.055;
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

function rgbToOklab({ r, g, b }: RgbChannels): OklabChannels {
	const linearR = srgbToLinear(r / 255);
	const linearG = srgbToLinear(g / 255);
	const linearB = srgbToLinear(b / 255);
	const l = Math.cbrt(0.4122214708 * linearR + 0.5363325363 * linearG + 0.0514459929 * linearB);
	const m = Math.cbrt(0.2119034982 * linearR + 0.6806995451 * linearG + 0.1073969566 * linearB);
	const s = Math.cbrt(0.0883024619 * linearR + 0.2817188376 * linearG + 0.6299787005 * linearB);
	return {
		l: 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
		a: 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
		b: 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
	};
}

function oklabToLinearRgb({ l, a, b }: OklabChannels): LinearRgbChannels {
	const lRoot = l + 0.3963377774 * a + 0.2158037573 * b;
	const mRoot = l - 0.1055613458 * a - 0.0638541728 * b;
	const sRoot = l - 0.0894841775 * a - 1.291485548 * b;
	const lValue = lRoot ** 3;
	const mValue = mRoot ** 3;
	const sValue = sRoot ** 3;
	return {
		r: 4.0767416621 * lValue - 3.3077115913 * mValue + 0.2309699292 * sValue,
		g: -1.2684380046 * lValue + 2.6097574011 * mValue - 0.3413193965 * sValue,
		b: -0.0041960863 * lValue - 0.7034186147 * mValue + 1.707614701 * sValue,
	};
}

function oklchToOklab({ l, c, h }: OklchChannels): OklabChannels {
	const radians = (h * Math.PI) / 180;
	return { l, a: c * Math.cos(radians), b: c * Math.sin(radians) };
}

function isInSrgbGamut({ r, g, b }: LinearRgbChannels): boolean {
	const epsilon = 1e-7;
	return r >= -epsilon && r <= 1 + epsilon && g >= -epsilon && g <= 1 + epsilon && b >= -epsilon && b <= 1 + epsilon;
}

function linearRgbToChannels({ r, g, b }: LinearRgbChannels): RgbChannels {
	return {
		r: Math.round(Math.max(0, Math.min(1, linearToSrgb(r))) * 255),
		g: Math.round(Math.max(0, Math.min(1, linearToSrgb(g))) * 255),
		b: Math.round(Math.max(0, Math.min(1, linearToSrgb(b))) * 255),
	};
}

function oklchToRgb(color: OklchChannels): RgbChannels {
	let linear = oklabToLinearRgb(oklchToOklab(color));
	if (isInSrgbGamut(linear)) return linearRgbToChannels(linear);

	let low = 0;
	let high = color.c;
	for (let index = 0; index < 20; index++) {
		const chroma = (low + high) / 2;
		const candidate = oklabToLinearRgb(oklchToOklab({ ...color, c: chroma }));
		if (isInSrgbGamut(candidate)) {
			low = chroma;
			linear = candidate;
		} else {
			high = chroma;
		}
	}
	return linearRgbToChannels(linear);
}

export function colorToRgb(color: Color): RgbChannels {
	switch (color.kind) {
		case "default":
			throw new Error("The terminal default color has no concrete RGB value");
		case "indexed":
			return indexedToRgb(color.index);
		case "rgb":
			return { r: color.r, g: color.g, b: color.b };
		case "oklch":
			return oklchToRgb(color);
	}
}

export function colorToOklch(color: Color): OklchChannels {
	if (color.kind === "default") throw new Error("The terminal default color has no concrete OKLCH value");
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

function colorDistance(first: RgbChannels, second: RgbChannels): number {
	const dr = first.r - second.r;
	const dg = first.g - second.g;
	const db = first.b - second.b;
	return dr * dr * 0.299 + dg * dg * 0.587 + db * db * 0.114;
}

function rgbToAnsi256(color: RgbChannels): number {
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

function rgbToAnsi16(color: RgbChannels): number {
	const target = rgbToOklab(color);
	let closestIndex = 0;
	let closestDistance = Infinity;
	for (let index = 0; index < BASIC_COLORS.length; index++) {
		const candidate = rgbToOklab(BASIC_COLORS[index]);
		const distance = (target.l - candidate.l) ** 2 + (target.a - candidate.a) ** 2 + (target.b - candidate.b) ** 2;
		if (distance < closestDistance) {
			closestIndex = index;
			closestDistance = distance;
		}
	}
	return closestIndex;
}

function basicAnsi(index: number, background: boolean): string {
	const base = background ? (index < 8 ? 40 : 100) : index < 8 ? 30 : 90;
	return `\x1b[${base + (index % 8)}m`;
}

function colorAnsi(color: Color, mode: TerminalColorMode, background: boolean): string {
	if (mode === "none") return "";
	if (color.kind === "default") return background ? "\x1b[49m" : "\x1b[39m";

	if (color.kind === "indexed" && mode !== "16color") {
		return `\x1b[${background ? 48 : 38};5;${color.index}m`;
	}

	const rgb = colorToRgb(color);
	if (mode === "truecolor") {
		return `\x1b[${background ? 48 : 38};2;${Math.round(rgb.r)};${Math.round(rgb.g)};${Math.round(rgb.b)}m`;
	}
	if (mode === "256color") {
		return `\x1b[${background ? 48 : 38};5;${rgbToAnsi256(rgb)}m`;
	}
	return basicAnsi(color.kind === "indexed" && color.index < 16 ? color.index : rgbToAnsi16(rgb), background);
}

export function foregroundAnsi(color: Color, mode: TerminalColorMode): string {
	return colorAnsi(color, mode, false);
}

export function backgroundAnsi(color: Color, mode: TerminalColorMode): string {
	return colorAnsi(color, mode, true);
}

export function styleText(text: string, options: TextStyle, mode: TerminalColorMode): string {
	if (mode === "none") return text;

	const prefix: string[] = [];
	const suffix: string[] = [];
	if (options.fg) {
		prefix.push(foregroundAnsi(options.fg, mode));
		suffix.unshift("\x1b[39m");
	}
	if (options.bg) {
		prefix.push(backgroundAnsi(options.bg, mode));
		suffix.unshift("\x1b[49m");
	}
	if (options.bold) prefix.push("\x1b[1m");
	if (options.dim) prefix.push("\x1b[2m");
	if (options.bold || options.dim) suffix.unshift("\x1b[22m");
	if (options.italic) {
		prefix.push("\x1b[3m");
		suffix.unshift("\x1b[23m");
	}
	if (options.underline) {
		prefix.push("\x1b[4m");
		suffix.unshift("\x1b[24m");
	}
	if (options.inverse) {
		prefix.push("\x1b[7m");
		suffix.unshift("\x1b[27m");
	}
	if (options.strikethrough) {
		prefix.push("\x1b[9m");
		suffix.unshift("\x1b[29m");
	}
	return `${prefix.join("")}${text}${suffix.join("")}`;
}

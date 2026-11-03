// Copied from coding-agent interactive/theme/theme.ts (Theme class, color resolution, appearance) and made
// per-instance (p2-tui-port.md section 5.3): no fs, watchers, globalThis, registries, env or Chalk. Terminal colors
// and the color mode are constructor data supplied by the launcher; built-in themes are bundled modules.
import {
	backgroundAnsi,
	type Color,
	colorToOklch,
	foregroundAnsi,
	mixColors,
	parseColor,
	type RgbColor,
	rgbColor,
	styleTextWithAnsi,
	type TerminalColorMode,
	type TerminalColors,
	type TextAttributes,
} from "@earendil-works/pi-tui";
import { common, createLowlight } from "lowlight";
import { DARK_THEME, LIGHT_THEME } from "./builtin-themes.ts";
import { generateSystemThemeColors, SYSTEM_THEME_NAME, terminalAppearance } from "./system-theme.ts";
import type { ThemeColorValue as ColorValue, ValidatedThemeJson as ThemeJson } from "./theme-schema.ts";
import {
	type ResolvedThemeColorValues,
	THEME_TOKENS,
	type ThemeBg,
	type ThemeColor,
	type ThemeColorValues,
	type ThemeToken,
} from "./theme-tokens.ts";

export { SYSTEM_THEME_NAME } from "./system-theme.ts";
export type { ValidatedThemeJson as ThemeJson } from "./theme-schema.ts";
export type { ThemeBg, ThemeColor, ThemeToken } from "./theme-tokens.ts";

export type TerminalTheme = "dark" | "light";
export type ThemeAppearance = TerminalTheme;
/** What the launcher learned about the visitor's terminal (section 3.2 `terminalColors`). */
export type TerminalState = {
	colors: TerminalColors;
	/** Light/dark report (mode 2031) or COLORFGBG, evaluated by the launcher. */
	scheme?: TerminalTheme;
	/** True until the launcher's color query completed or timed out: the system theme renders in grayscale. */
	pending?: boolean;
};
export const BUILTIN_THEMES: Readonly<Record<string, ThemeJson>> = { dark: DARK_THEME, light: LIGHT_THEME };

export interface ThemeStyle extends TextAttributes {
	fg?: ThemeColor | Color;
	bg?: ThemeBg | Color;
}

function resolveVarRefs(
	value: ColorValue,
	vars: Record<string, ColorValue>,
	visited = new Set<string>(),
): string | number {
	if (typeof value === "number" || value === "" || value.startsWith("#") || /^ok(lch|hsl)\(/i.test(value))
		return value;
	if (visited.has(value)) throw new Error(`Circular variable reference detected: ${value}`);
	const next = vars[value];
	if (next === undefined) throw new Error(`Variable reference not found: ${value}`);
	visited.add(value);
	return resolveVarRefs(next, vars, visited);
}

function withThemeTokenFallbacks<Value>(values: ThemeColorValues<Value>): ResolvedThemeColorValues<Value> {
	const resolved: Partial<Record<ThemeToken, Value>> = { ...values };
	for (const [name, descriptor] of Object.entries(THEME_TOKENS) as [ThemeToken, { fallback?: string }][]) {
		if (descriptor.fallback === undefined || resolved[name] !== undefined) continue;
		const fallback = resolved[descriptor.fallback as ThemeToken];
		if (fallback === undefined) throw new Error(`Theme token ${name} has unresolved fallback ${descriptor.fallback}`);
		resolved[name] = fallback;
	}
	return resolved as ResolvedThemeColorValues<Value>;
}

function splitThemeColors(colors: ResolvedThemeColorValues<string | number>): {
	fgColors: Record<ThemeColor, string | number>;
	bgColors: Record<ThemeBg, string | number>;
} {
	const fgColors = {} as Record<ThemeColor, string | number>;
	const bgColors = {} as Record<ThemeBg, string | number>;
	for (const [key, value] of Object.entries(colors) as [ThemeToken, string | number][]) {
		if (THEME_TOKENS[key].slot === "background") bgColors[key as ThemeBg] = value;
		else fgColors[key as ThemeColor] = value;
	}
	return { fgColors, bgColors };
}

const GUESSED_DEFAULT_COLORS: Record<ThemeAppearance, { foreground: Color; background: Color }> = {
	dark: { foreground: parseColor("#e5e5e7"), background: parseColor("#000000") },
	light: { foreground: parseColor("#000000"), background: parseColor("#ffffff") },
};

function averageLightness(colors: Color[]): number | undefined {
	const fixed = colors.filter((color) => color.kind !== "indexed" || color.index >= 16);
	if (fixed.length === 0) return undefined;
	return fixed.reduce((sum, color) => sum + colorToOklch(color).l, 0) / fixed.length;
}

function detectAppearance(foregrounds: Color[], backgrounds: Color[]): ThemeAppearance | undefined {
	const fg = averageLightness(foregrounds);
	const bg = averageLightness(backgrounds);
	if (fg !== undefined && bg !== undefined) return bg < fg ? "dark" : "light";
	if (bg !== undefined) return bg < 0.5 ? "dark" : "light";
	if (fg !== undefined) return fg > 0.5 ? "dark" : "light";
	return undefined;
}

/** Dark or light from the terminal's background, then its scheme report, then dark. */
export function detectTerminalTheme(terminal: TerminalState): TerminalTheme {
	const { background, foreground } = terminal.colors;
	if (background) return terminalAppearance(background, foreground);
	return terminal.scheme ?? "dark";
}

// Syntax highlighting: highlight.js scopes (via lowlight, already a p2 dependency) mapped to syntax* tokens,
// mirroring coding-agent's cli-highlight theme.
const lowlight = createLowlight(common);
const SCOPES: Record<string, ThemeColor | "italic" | "bold" | "underline"> = {
	keyword: "syntaxKeyword",
	built_in: "syntaxType",
	literal: "syntaxNumber",
	number: "syntaxNumber",
	regexp: "syntaxString",
	string: "syntaxString",
	subst: "text",
	comment: "syntaxComment",
	doctag: "syntaxComment",
	meta: "muted",
	function: "syntaxFunction",
	title: "syntaxFunction",
	class: "syntaxType",
	type: "syntaxType",
	tag: "syntaxPunctuation",
	name: "syntaxKeyword",
	attr: "syntaxVariable",
	variable: "syntaxVariable",
	params: "syntaxVariable",
	operator: "syntaxOperator",
	punctuation: "syntaxPunctuation",
	emphasis: "italic",
	strong: "bold",
	link: "underline",
	addition: "toolDiffAdded",
	deletion: "toolDiffRemoved",
};
const LANGUAGE_ALIASES: Record<string, string> = {
	mjs: "js",
	cjs: "js",
	mts: "ts",
	cts: "ts",
	jsonc: "json",
	zsh: "bash",
};
type HastNode = { type: string; value?: string; properties?: { className?: unknown }; children?: HastNode[] };

export class Theme {
	readonly name: string | undefined;
	readonly mode: TerminalColorMode;
	readonly terminal: TerminalState;
	private readonly fgAnsi = new Map<ThemeColor, string>();
	private readonly bgAnsi = new Map<ThemeBg, string>();
	private readonly concreteColors: Partial<Record<ThemeToken, Color>> = {};
	private readonly defaultForegroundTokens: ThemeToken[] = [];
	private readonly defaultBackgroundTokens: ThemeToken[] = [];
	private readonly dimTokens: ReadonlySet<ThemeColor>;
	private readonly ownAppearance: ThemeAppearance | undefined;
	private resolvedColors: Readonly<Record<ThemeToken, Color>> | undefined;

	constructor(
		fgColors: Pick<ThemeColorValues<string | number>, ThemeColor>,
		bgColors: Pick<ThemeColorValues<string | number>, ThemeBg>,
		options: {
			mode: TerminalColorMode;
			terminal?: TerminalState;
			name?: string;
			appearance?: ThemeAppearance;
			dim?: readonly ThemeColor[];
		},
	) {
		this.name = options.name;
		this.mode = options.mode;
		this.terminal = options.terminal ?? { colors: {} };
		this.dimTokens = new Set(options.dim);
		const { fgColors: foregrounds, bgColors: backgrounds } = splitThemeColors(
			withThemeTokenFallbacks({ ...fgColors, ...bgColors }),
		);
		const concreteForegrounds: Color[] = [];
		const concreteBackgrounds: Color[] = [];
		const addToken = (token: ThemeToken, value: string | number, isBackground: boolean): string => {
			if (value === "") {
				(isBackground ? this.defaultBackgroundTokens : this.defaultForegroundTokens).push(token);
				return isBackground ? "\x1b[49m" : "\x1b[39m";
			}
			const color = parseColor(value);
			this.concreteColors[token] = color;
			(isBackground ? concreteBackgrounds : concreteForegrounds).push(color);
			return isBackground ? backgroundAnsi(color, this.mode) : foregroundAnsi(color, this.mode);
		};
		for (const [token, value] of Object.entries(foregrounds) as [ThemeColor, string | number][])
			this.fgAnsi.set(token, addToken(token, value, false));
		for (const [token, value] of Object.entries(backgrounds) as [ThemeBg, string | number][])
			this.bgAnsi.set(token, addToken(token, value, true));
		this.ownAppearance = options.appearance ?? detectAppearance(concreteForegrounds, concreteBackgrounds);
	}

	/** Declared, detected from the theme colors, or (for colorless themes) this instance's terminal appearance. */
	get appearance(): ThemeAppearance {
		return this.ownAppearance ?? detectTerminalTheme(this.terminal);
	}

	/** Concrete colors for all tokens; "" tokens use this instance's terminal defaults (or a guess). */
	get colors(): Readonly<Record<ThemeToken, Color>> {
		if (!this.resolvedColors) {
			const guess = GUESSED_DEFAULT_COLORS[this.appearance];
			const toColor = (rgb: RgbColor | undefined, fallback: Color) =>
				rgb ? rgbColor(rgb.r, rgb.g, rgb.b) : fallback;
			const foreground = toColor(this.terminal.colors.foreground, guess.foreground);
			const background = toColor(this.terminal.colors.background, guess.background);
			const colors = { ...this.concreteColors };
			for (const token of this.defaultForegroundTokens) colors[token] = foreground;
			for (const token of this.defaultBackgroundTokens) colors[token] = background;
			for (const token of this.dimTokens) {
				const color = colors[token];
				if (color) colors[token] = mixColors(color, background, 0.4);
			}
			this.resolvedColors = Object.freeze(colors as Record<ThemeToken, Color>);
		}
		return this.resolvedColors;
	}

	style(text: string, options: ThemeStyle): string {
		const { fg, bg } = options;
		if (typeof fg === "string" && this.dimTokens.has(fg)) options = { ...options, dim: true };
		return styleTextWithAnsi(
			text,
			fg === undefined
				? undefined
				: typeof fg === "string"
					? this.tokenAnsi(this.fgAnsi, fg)
					: foregroundAnsi(fg, this.mode),
			bg === undefined
				? undefined
				: typeof bg === "string"
					? this.tokenAnsi(this.bgAnsi, bg)
					: backgroundAnsi(bg, this.mode),
			options,
		);
	}

	fg(color: ThemeColor, text: string): string {
		const ansi = this.tokenAnsi(this.fgAnsi, color);
		if (this.dimTokens.has(color)) return `${ansi}\x1b[2m${text}\x1b[22;39m`;
		return `${ansi}${text}\x1b[39m`;
	}

	bg(color: ThemeBg, text: string): string {
		return `${this.tokenAnsi(this.bgAnsi, color)}${text}\x1b[49m`;
	}

	private tokenAnsi<T extends ThemeToken>(ansi: Map<T, string>, token: T): string {
		const value = ansi.get(token);
		if (value === undefined) throw new Error(`Unknown theme color: ${token}`);
		return value;
	}

	// Plain SGR in place of Chalk: Chalk's color level is a process global (section 5.1).
	bold(text: string): string {
		return `\x1b[1m${text}\x1b[22m`;
	}
	italic(text: string): string {
		return `\x1b[3m${text}\x1b[23m`;
	}
	underline(text: string): string {
		return `\x1b[4m${text}\x1b[24m`;
	}
	inverse(text: string): string {
		return `\x1b[7m${text}\x1b[27m`;
	}
	strikethrough(text: string): string {
		return `\x1b[9m${text}\x1b[29m`;
	}

	getFgAnsi(color: ThemeColor): string {
		const ansi = this.tokenAnsi(this.fgAnsi, color);
		return this.dimTokens.has(color) ? `${ansi}\x1b[2m` : ansi;
	}
	getBgAnsi(color: ThemeBg): string {
		return this.tokenAnsi(this.bgAnsi, color);
	}
	getColorMode(): TerminalColorMode {
		return this.mode;
	}

	getThinkingBorderColor(level: string): (str: string) => string {
		const token: ThemeColor =
			level === "minimal"
				? "thinkingMinimal"
				: level === "low"
					? "thinkingLow"
					: level === "medium"
						? "thinkingMedium"
						: level === "high"
							? "thinkingHigh"
							: level === "xhigh"
								? "thinkingXhigh"
								: level === "max"
									? "thinkingMax"
									: "thinkingOff";
		return (str) => this.fg(token, str);
	}
	getBashModeBorderColor(): (str: string) => string {
		return (str) => this.fg("bashMode", str);
	}

	/** Highlight.js language for a fence info string or file path, if bundled. */
	static language(hint: string | undefined): string | undefined {
		if (!hint) return undefined;
		const name = hint.toLowerCase().split(/[\s{]/)[0]?.split(/[/\\]/).pop() ?? "";
		const key = name.includes(".") ? (name.split(".").pop() ?? "") : name;
		const language = LANGUAGE_ALIASES[key] ?? key;
		return language && lowlight.registered(language) ? language : undefined;
	}

	/** Syntax-highlighted lines; unknown languages (and huge inputs) use `mdCodeBlock` like coding-agent. */
	highlight(code: string, lang?: string): string[] {
		const language = Theme.language(lang);
		if (!language || code.length > 200_000) return code.split("\n").map((line) => this.fg("mdCodeBlock", line));
		let nodes: HastNode[];
		try {
			nodes = lowlight.highlight(language, code).children as unknown as HastNode[];
		} catch {
			return code.split("\n").map((line) => this.fg("mdCodeBlock", line));
		}
		const lines: string[] = [""];
		const emit = (text: string, styles: readonly (ThemeColor | "italic" | "bold" | "underline")[]): void => {
			const parts = text.split("\n");
			parts.forEach((part, index) => {
				if (index > 0) lines.push("");
				if (!part) return;
				let styled = part;
				for (const style of styles)
					styled =
						style === "italic"
							? this.italic(styled)
							: style === "bold"
								? this.bold(styled)
								: style === "underline"
									? this.underline(styled)
									: this.fg(style, styled);
				lines[lines.length - 1] += styled;
			});
		};
		const walk = (list: readonly HastNode[], styles: readonly (ThemeColor | "italic" | "bold" | "underline")[]) => {
			for (const node of list) {
				if (node.type === "text") emit(node.value ?? "", styles);
				else {
					const classes = Array.isArray(node.properties?.className) ? node.properties.className : [];
					const scope = classes
						.map((name) => (typeof name === "string" ? SCOPES[name.replace(/^hljs-/, "")] : undefined))
						.find((value) => value !== undefined);
					// The innermost color wins; it is applied first so outer styles wrap it.
					walk(node.children ?? [], scope ? [scope, ...styles] : styles);
				}
			}
		};
		walk(nodes, []);
		return lines;
	}
}

/** Build a theme from validated JSON for one terminal. Throws on unresolved variables or colors. */
export function createTheme(json: ThemeJson, mode: TerminalColorMode, terminal: TerminalState = { colors: {} }): Theme {
	const resolved: Record<string, string | number> = {};
	for (const [key, value] of Object.entries(json.colors) as [string, ColorValue][])
		resolved[key] = resolveVarRefs(value, json.vars ?? {});
	const { fgColors, bgColors } = splitThemeColors(
		withThemeTokenFallbacks(resolved as ThemeColorValues<string | number>),
	);
	return new Theme(fgColors, bgColors, { mode, terminal, name: json.name, appearance: json.appearance });
}

/** The system theme generated from this terminal's reported colors (grayscale while they are pending). */
export function createSystemTheme(mode: TerminalColorMode, terminal: TerminalState = { colors: {} }): Theme {
	const generated = generateSystemThemeColors({
		...terminal.colors,
		saturation: terminal.pending ? 0 : 1,
		appearanceHint: detectTerminalTheme(terminal),
	});
	const { fgColors, bgColors } = splitThemeColors(withThemeTokenFallbacks(generated.colors));
	return new Theme(fgColors, bgColors, {
		mode,
		terminal,
		name: SYSTEM_THEME_NAME,
		appearance: generated.appearance,
		dim: generated.dim,
	});
}

export function parseAutoThemeSetting(
	setting: string | undefined,
): { lightTheme: string; darkTheme: string } | undefined {
	if (!setting) return undefined;
	const slash = setting.indexOf("/");
	if (slash === -1 || setting.indexOf("/", slash + 1) !== -1) return undefined;
	const lightTheme = setting.slice(0, slash).trim();
	const darkTheme = setting.slice(slash + 1).trim();
	return lightTheme && darkTheme ? { lightTheme, darkTheme } : undefined;
}

export function resolveThemeSetting(setting: string | undefined, terminalTheme: TerminalTheme): string | undefined {
	const pair = parseAutoThemeSetting(setting);
	if (pair) return terminalTheme === "light" ? pair.lightTheme : pair.darkTheme;
	if (setting?.includes("/")) return undefined;
	return setting;
}

/**
 * The theme a setting selects for one terminal: a light/dark pair, a built-in, a custom theme supplied as data,
 * or the system theme. Unknown or invalid themes fall back to the system theme and report an error.
 */
export function resolveTheme(options: {
	setting: string | undefined;
	themes?: Readonly<Record<string, ThemeJson>>;
	mode: TerminalColorMode;
	terminal: TerminalState;
}): { theme: Theme; error?: string } {
	const name = resolveThemeSetting(options.setting, detectTerminalTheme(options.terminal)) ?? SYSTEM_THEME_NAME;
	if (name === SYSTEM_THEME_NAME) return { theme: createSystemTheme(options.mode, options.terminal) };
	const json = BUILTIN_THEMES[name] ?? options.themes?.[name];
	try {
		if (!json) throw new Error(`Theme not found: ${name}`);
		return { theme: createTheme(json, options.mode, options.terminal) };
	} catch (error) {
		return {
			theme: createSystemTheme(options.mode, options.terminal),
			error: error instanceof Error ? error.message : String(error),
		};
	}
}

const rgb = (value: unknown): RgbColor | undefined => {
	if (!value || typeof value !== "object") return undefined;
	const { r, g, b } = value as Record<string, unknown>;
	const channel = (n: unknown) => typeof n === "number" && Number.isInteger(n) && n >= 0 && n <= 255;
	return channel(r) && channel(g) && channel(b) ? { r: r as number, g: g as number, b: b as number } : undefined;
};
/** Validate a `terminalColors` launcher message body. */
export function parseTerminalState(raw: unknown): TerminalState {
	const value = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
	const colors = value.colors && typeof value.colors === "object" ? (value.colors as Record<string, unknown>) : {};
	const palette = Array.isArray(colors.palette) && colors.palette.length === 16 ? colors.palette.map(rgb) : undefined;
	const foreground = rgb(colors.foreground);
	const background = rgb(colors.background);
	return {
		colors: {
			...(foreground ? { foreground } : {}),
			...(background ? { background } : {}),
			...(palette?.every(Boolean) ? { palette: palette as RgbColor[] } : {}),
		},
		...(value.scheme === "dark" || value.scheme === "light" ? { scheme: value.scheme } : {}),
		...(value.pending === true ? { pending: true } : {}),
	};
}

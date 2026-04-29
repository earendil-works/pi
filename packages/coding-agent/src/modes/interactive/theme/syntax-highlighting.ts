import bash from "@shikijs/langs/bash";
import c from "@shikijs/langs/c";
import clojure from "@shikijs/langs/clojure";
import cmake from "@shikijs/langs/cmake";
import cpp from "@shikijs/langs/cpp";
import csharp from "@shikijs/langs/csharp";
import css from "@shikijs/langs/css";
import diff from "@shikijs/langs/diff";
import dockerfile from "@shikijs/langs/dockerfile";
import dotenv from "@shikijs/langs/dotenv";
import elixir from "@shikijs/langs/elixir";
import erlang from "@shikijs/langs/erlang";
import fish from "@shikijs/langs/fish";
import go from "@shikijs/langs/go";
import graphql from "@shikijs/langs/graphql";
import haskell from "@shikijs/langs/haskell";
import hcl from "@shikijs/langs/hcl";
import html from "@shikijs/langs/html";
import java from "@shikijs/langs/java";
import javascript from "@shikijs/langs/javascript";
import json from "@shikijs/langs/json";
import jsx from "@shikijs/langs/jsx";
import kotlin from "@shikijs/langs/kotlin";
import less from "@shikijs/langs/less";
import lua from "@shikijs/langs/lua";
import makefile from "@shikijs/langs/makefile";
import markdown from "@shikijs/langs/markdown";
import ocaml from "@shikijs/langs/ocaml";
import perl from "@shikijs/langs/perl";
import php from "@shikijs/langs/php";
import powershell from "@shikijs/langs/powershell";
import properties from "@shikijs/langs/properties";
import protobuf from "@shikijs/langs/protobuf";
import python from "@shikijs/langs/python";
import r from "@shikijs/langs/r";
import ruby from "@shikijs/langs/ruby";
import rust from "@shikijs/langs/rust";
import sass from "@shikijs/langs/sass";
import scala from "@shikijs/langs/scala";
import scss from "@shikijs/langs/scss";
import shellscript from "@shikijs/langs/shellscript";
import sql from "@shikijs/langs/sql";
import swift from "@shikijs/langs/swift";
import toml from "@shikijs/langs/toml";
import tsx from "@shikijs/langs/tsx";
import typescript from "@shikijs/langs/typescript";
import vim from "@shikijs/langs/vim";
import xml from "@shikijs/langs/xml";
import yaml from "@shikijs/langs/yaml";
import githubDark from "@shikijs/themes/github-dark";
import githubLight from "@shikijs/themes/github-light";
import type { LanguageRegistration, ThemeRegistration } from "shiki/core";
import { createHighlighterCore } from "shiki/core";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";

export const BUILTIN_SYNTAX_THEMES = ["github-dark", "github-light"] as const;
export type BuiltinSyntaxTheme = (typeof BUILTIN_SYNTAX_THEMES)[number];
export type CustomSyntaxTheme = Omit<ThemeRegistration, "name" | "type"> & {
	name: string;
	type: "dark" | "light";
};
export type SyntaxThemeInput = BuiltinSyntaxTheme | CustomSyntaxTheme;

export interface SyntaxDiffColors {
	added: string;
	removed: string;
	context: string;
	addedBg: string;
	removedBg: string;
}

type LanguageRegistrationInput = LanguageRegistration | LanguageRegistration[];
type TokenColorToAnsi = (hexColor: string) => string;
type SyntaxThemeRule = NonNullable<ThemeRegistration["settings"]>[number];

const LANGUAGE_REGISTRATIONS: Record<string, LanguageRegistrationInput> = {
	bash,
	c,
	clojure,
	cmake,
	cpp,
	csharp,
	css,
	diff,
	dockerfile,
	dotenv,
	elixir,
	erlang,
	fish,
	go,
	graphql,
	haskell,
	hcl,
	html,
	java,
	javascript,
	json,
	jsx,
	kotlin,
	less,
	lua,
	makefile,
	markdown,
	ocaml,
	perl,
	php,
	powershell,
	properties,
	protobuf,
	python,
	r,
	ruby,
	rust,
	sass,
	scala,
	scss,
	shellscript,
	sql,
	swift,
	toml,
	tsx,
	typescript,
	vim,
	xml,
	yaml,
};

const DEFAULT_SYNTAX_THEME: SyntaxThemeInput = "github-dark";
const MAX_HIGHLIGHT_CHARS = envPositiveInteger("PI_MAX_HIGHLIGHT_CHARS", 80000);
const CACHE_LIMIT = envPositiveInteger("PI_HIGHLIGHT_CACHE_LIMIT", 192);

let shikiHighlighter: Awaited<ReturnType<typeof createHighlighterCore>> | undefined;
let syntaxTheme: SyntaxThemeInput = DEFAULT_SYNTAX_THEME;
let syntaxThemeName = getSyntaxThemeName(DEFAULT_SYNTAX_THEME);
let syntaxThemeCacheKey = getSyntaxThemeCacheKey(DEFAULT_SYNTAX_THEME);
let initializationPromise: Promise<void> | undefined;
let initializationId = 0;
const loadedLanguages = new Set<string>();
const pendingLanguages = new Set<string>();
const languageLoadCallbacks = new Map<string, Set<() => void>>();
const initializationCallbacks = new Set<() => void>();
const renderCache = new Map<string, string[]>();

export function setSyntaxHighlightTheme(nextTheme: SyntaxThemeInput): void {
	const nextName = getSyntaxThemeName(nextTheme);
	const nextCacheKey = getSyntaxThemeCacheKey(nextTheme);
	if (nextCacheKey === syntaxThemeCacheKey) return;

	syntaxTheme = nextTheme;
	syntaxThemeName = nextName;
	syntaxThemeCacheKey = nextCacheKey;
	const previousHighlighter = shikiHighlighter;
	shikiHighlighter = undefined;
	initializationPromise = undefined;
	initializationCallbacks.clear();
	loadedLanguages.clear();
	pendingLanguages.clear();
	languageLoadCallbacks.clear();
	renderCache.clear();
	initializationId++;
	previousHighlighter?.dispose();
}

export function initializeSyntaxHighlighter(invalidate?: () => void): Promise<void> {
	if (initializationPromise) {
		if (invalidate) initializationCallbacks.add(invalidate);
		return initializationPromise;
	}
	if (invalidate) initializationCallbacks.add(invalidate);
	const requestId = ++initializationId;
	const themeForRequest = syntaxTheme;
	initializationPromise = createHighlighterCore({
		engine: createJavaScriptRegexEngine(),
		themes: [getSyntaxThemeRegistration(themeForRequest)],
		langs: [],
		warnings: false,
	})
		.then((nextHighlighter) => {
			if (requestId !== initializationId) {
				nextHighlighter.dispose();
				return;
			}
			const previousHighlighter = shikiHighlighter;
			shikiHighlighter = nextHighlighter;
			previousHighlighter?.dispose();
			renderCache.clear();
			loadedLanguages.clear();
			pendingLanguages.clear();
			languageLoadCallbacks.clear();
			const callbacks = [...initializationCallbacks];
			initializationCallbacks.clear();
			callbacks.forEach((callback) => {
				callback();
			});
		})
		.catch(() => {
			if (requestId !== initializationId) return;
			shikiHighlighter = undefined;
			initializationPromise = undefined;
		});
	return initializationPromise;
}

export function highlightCodeWithShiki(
	code: string,
	lang: string | undefined,
	fallbackColor: (text: string) => string,
	tokenColorToAnsi: TokenColorToAnsi,
	tokenColorCacheKey: string,
	invalidate?: () => void,
): string[] {
	const normalized = code.replace(/\t/g, "   ");
	const plain = () => normalized.split("\n").map((line) => fallbackColor(escapeControlChars(line)));
	if (!lang || shouldSkipHighlight(normalized)) return plain();
	if (!shikiHighlighter) {
		void initializeSyntaxHighlighter(invalidate);
		return plain();
	}
	return renderWithShiki(normalized, lang, tokenColorToAnsi, tokenColorCacheKey, invalidate) ?? plain();
}

export function renderWithShiki(
	code: string,
	lang: string | undefined,
	tokenColorToAnsi: TokenColorToAnsi,
	tokenColorCacheKey: string,
	invalidate?: () => void,
): string[] | undefined {
	if (!shikiHighlighter || !lang || shouldSkipHighlight(code)) return undefined;
	const shikiLang = normalizeShikiLanguage(lang);
	const cacheKey = `${syntaxThemeCacheKey}\0${tokenColorCacheKey}\0${shikiLang}\0${code}`;
	const cached = renderCache.get(cacheKey);
	if (cached) {
		renderCache.delete(cacheKey);
		renderCache.set(cacheKey, cached);
		return [...cached];
	}
	try {
		if (!loadedLanguages.has(shikiLang)) {
			if (!requestLanguageLoad(shikiLang, invalidate)) return undefined;
		}
		const tokens = shikiHighlighter.codeToTokensBase(code, {
			lang: shikiLang as never,
			theme: syntaxThemeName as never,
		});
		const rendered = tokens.map((line) => line.map((token) => ansiFromToken(token, tokenColorToAnsi)).join(""));
		cacheRendered(cacheKey, rendered);
		return [...rendered];
	} catch {
		return undefined;
	}
}

export function shouldSkipHighlight(text: string): boolean {
	return Number.isFinite(MAX_HIGHLIGHT_CHARS) && MAX_HIGHLIGHT_CHARS > 0 && text.length > MAX_HIGHLIGHT_CHARS;
}

export function normalizeShikiLanguage(lang: string): string {
	const normalized =
		lang
			.trim()
			.toLowerCase()
			.replace(/^language-/, "")
			.split(/\s+/, 1)[0] ?? "";
	if (normalized === "sh" || normalized === "shell" || normalized === "zsh") return "bash";
	if (
		normalized === "shell-session" ||
		normalized === "shellsession" ||
		normalized === "terminal" ||
		normalized === "console"
	)
		return "shellscript";
	if (normalized === "ts") return "typescript";
	if (normalized === "js") return "javascript";
	if (normalized === "md") return "markdown";
	if (normalized === "yml") return "yaml";
	if (normalized === "kt") return "kotlin";
	if (normalized === "ps1") return "powershell";
	if (normalized === "clj") return "clojure";
	if (normalized === "ex" || normalized === "exs") return "elixir";
	if (normalized === "erl") return "erlang";
	if (normalized === "hs") return "haskell";
	if (normalized === "ml") return "ocaml";
	if (normalized === "proto") return "protobuf";
	if (normalized === "tf") return "hcl";
	return normalized;
}

export function getSyntaxThemeName(theme: SyntaxThemeInput): string {
	return typeof theme === "string" ? theme : theme.name;
}

export function getSyntaxThemeCacheKey(theme: SyntaxThemeInput): string {
	return typeof theme === "string" ? theme : JSON.stringify(theme);
}

export interface HtmlSyntaxHighlighter {
	highlight(code: string, lang: string | undefined): Promise<string | undefined>;
	dispose(): void;
}

export async function createHtmlSyntaxHighlighter(theme: SyntaxThemeInput): Promise<HtmlSyntaxHighlighter> {
	const highlighter = await createHighlighterCore({
		engine: createJavaScriptRegexEngine(),
		themes: [getSyntaxThemeRegistration(theme)],
		langs: [],
		warnings: false,
	});
	const themeName = getSyntaxThemeName(theme);
	const htmlLoadedLanguages = new Set<string>();
	return {
		async highlight(code: string, lang: string | undefined): Promise<string | undefined> {
			const normalized = code.replace(/\t/g, "   ");
			if (!lang || shouldSkipHighlight(normalized)) return undefined;
			const shikiLang = normalizeShikiLanguage(lang);
			const language = LANGUAGE_REGISTRATIONS[shikiLang];
			if (!language) return undefined;
			if (!htmlLoadedLanguages.has(shikiLang)) {
				await highlighter.loadLanguage(language);
				htmlLoadedLanguages.add(shikiLang);
			}
			try {
				const tokens = highlighter.codeToTokensBase(normalized, {
					lang: shikiLang as never,
					theme: themeName as never,
				});
				return tokens.map((line) => line.map((token) => htmlFromToken(token)).join("")).join("\n");
			} catch {
				return undefined;
			}
		},
		dispose(): void {
			highlighter.dispose();
		},
	};
}

export function getSyntaxThemeDiffColors(theme: SyntaxThemeInput): SyntaxDiffColors {
	const registration = getSyntaxThemeRegistration(theme);
	const themeType = registration.type ?? (theme === "github-light" ? "light" : "dark");
	const fallbackBg = themeType === "light" ? "#ffffff" : "#24292e";
	const fallbackFg = themeType === "light" ? "#24292f" : "#e1e4e8";
	const colors = registration.colors ?? {};
	const background =
		firstResolvedColor([registration.bg, colors["editor.background"], colors["terminal.background"]], fallbackBg) ??
		fallbackBg;
	const foreground =
		firstResolvedColor(
			[registration.fg, colors["editor.foreground"], colors.foreground, colors["terminal.foreground"]],
			background,
		) ?? fallbackFg;
	const fallbackAdded = themeType === "light" ? "#22863a" : "#85e89d";
	const fallbackRemoved = themeType === "light" ? "#d73a49" : "#f97583";
	const added =
		findTokenForeground(registration, ["markup.inserted", "punctuation.definition.inserted"], background) ??
		firstResolvedColor([colors["editorGutter.addedBackground"], colors["terminal.ansiGreen"]], background) ??
		fallbackAdded;
	const removed =
		findTokenForeground(registration, ["markup.deleted", "punctuation.definition.deleted"], background) ??
		firstResolvedColor([colors["editorGutter.deletedBackground"], colors["terminal.ansiRed"]], background) ??
		fallbackRemoved;
	const context =
		firstResolvedColor(
			[colors.descriptionForeground, colors["editorLineNumber.foreground"], colors["terminal.ansiBrightBlack"]],
			background,
		) ?? mixColors(background, foreground, 0.55);
	const addedBg =
		firstResolvedColor(
			[colors["diffEditor.insertedTextBackground"], colors["diffEditor.insertedLineBackground"]],
			background,
		) ??
		findTokenBackground(registration, ["markup.inserted", "punctuation.definition.inserted"], background) ??
		mixColors(background, added, themeType === "light" ? 0.14 : 0.22);
	const removedBg =
		firstResolvedColor(
			[colors["diffEditor.removedTextBackground"], colors["diffEditor.removedLineBackground"]],
			background,
		) ??
		findTokenBackground(registration, ["markup.deleted", "punctuation.definition.deleted"], background) ??
		mixColors(background, removed, themeType === "light" ? 0.14 : 0.22);

	return {
		added,
		removed,
		context,
		addedBg,
		removedBg,
	};
}

function getSyntaxThemeRegistration(theme: SyntaxThemeInput): ThemeRegistration {
	if (theme === "github-dark") return githubDark;
	if (theme === "github-light") return githubLight;
	return theme;
}

function firstResolvedColor(candidates: Array<string | undefined>, background: string): string | undefined {
	for (const candidate of candidates) {
		if (!candidate) continue;
		const resolved = resolveThemeHexColor(candidate, background);
		if (resolved) return resolved;
	}
	return undefined;
}

function findTokenForeground(theme: ThemeRegistration, targetScopes: string[], background: string): string | undefined {
	return findTokenColor(theme, targetScopes, background, "foreground");
}

function findTokenBackground(theme: ThemeRegistration, targetScopes: string[], background: string): string | undefined {
	return findTokenColor(theme, targetScopes, background, "background");
}

function findTokenColor(
	theme: ThemeRegistration,
	targetScopes: string[],
	background: string,
	setting: "foreground" | "background",
): string | undefined {
	const rules = getSyntaxThemeRules(theme);
	for (let i = rules.length - 1; i >= 0; i--) {
		const rule = rules[i];
		if (!scopeMatches(rule.scope, targetScopes)) continue;
		const color = rule.settings?.[setting];
		if (!color) continue;
		const resolved = resolveThemeHexColor(color, background);
		if (resolved) return resolved;
	}
	return undefined;
}

function getSyntaxThemeRules(theme: ThemeRegistration): SyntaxThemeRule[] {
	return [...(theme.settings ?? []), ...(theme.tokenColors ?? [])];
}

function scopeMatches(ruleScope: string | string[] | undefined, targetScopes: string[]): boolean {
	if (!ruleScope) return false;
	const scopes = Array.isArray(ruleScope) ? ruleScope : [ruleScope];
	return scopes.some((scope) => {
		const parts = scope.split(/[\s,]+/).filter(Boolean);
		return parts.some((part) =>
			targetScopes.some((targetScope) => part === targetScope || part.startsWith(`${targetScope}.`)),
		);
	});
}

function resolveThemeHexColor(color: string, background: string): string | undefined {
	const parsed = parseHexColor(color);
	if (!parsed) return undefined;
	if (parsed.a >= 1) return rgbToHex(parsed);
	const parsedBackground = parseHexColor(background) ?? { r: 0, g: 0, b: 0, a: 1 };
	return rgbToHex(blendColors(parsed, parsedBackground));
}

function mixColors(background: string, foreground: string, amount: number): string {
	const parsedBackground = parseHexColor(background) ?? { r: 0, g: 0, b: 0, a: 1 };
	const parsedForeground = parseHexColor(foreground) ?? { r: 255, g: 255, b: 255, a: 1 };
	return rgbToHex({
		r: parsedBackground.r + (parsedForeground.r - parsedBackground.r) * amount,
		g: parsedBackground.g + (parsedForeground.g - parsedBackground.g) * amount,
		b: parsedBackground.b + (parsedForeground.b - parsedBackground.b) * amount,
	});
}

function blendColors(
	foreground: { r: number; g: number; b: number; a: number },
	background: { r: number; g: number; b: number; a: number },
): { r: number; g: number; b: number; a: number } {
	const alpha = foreground.a + background.a * (1 - foreground.a);
	if (alpha <= 0) return { r: 0, g: 0, b: 0, a: 1 };
	return {
		r: (foreground.r * foreground.a + background.r * background.a * (1 - foreground.a)) / alpha,
		g: (foreground.g * foreground.a + background.g * background.a * (1 - foreground.a)) / alpha,
		b: (foreground.b * foreground.a + background.b * background.a * (1 - foreground.a)) / alpha,
		a: 1,
	};
}

function parseHexColor(color: string): { r: number; g: number; b: number; a: number } | undefined {
	const trimmed = color.trim();
	const short = trimmed.match(/^#([0-9a-f])([0-9a-f])([0-9a-f])([0-9a-f])?$/i);
	if (short) {
		return {
			r: Number.parseInt(short[1] + short[1], 16),
			g: Number.parseInt(short[2] + short[2], 16),
			b: Number.parseInt(short[3] + short[3], 16),
			a: short[4] ? Number.parseInt(short[4] + short[4], 16) / 255 : 1,
		};
	}
	const long = trimmed.match(/^#([0-9a-f]{6})([0-9a-f]{2})?$/i);
	if (!long) return undefined;
	return {
		r: Number.parseInt(long[1].slice(0, 2), 16),
		g: Number.parseInt(long[1].slice(2, 4), 16),
		b: Number.parseInt(long[1].slice(4, 6), 16),
		a: long[2] ? Number.parseInt(long[2], 16) / 255 : 1,
	};
}

function rgbToHex(color: { r: number; g: number; b: number }): string {
	const toHex = (component: number) =>
		Math.min(255, Math.max(0, Math.round(component)))
			.toString(16)
			.padStart(2, "0");
	return `#${toHex(color.r)}${toHex(color.g)}${toHex(color.b)}`;
}

function cacheRendered(key: string, value: string[]): void {
	renderCache.set(key, [...value]);
	while (renderCache.size > CACHE_LIMIT) {
		const first = renderCache.keys().next().value;
		if (typeof first !== "string") break;
		renderCache.delete(first);
	}
}

function requestLanguageLoad(shikiLang: string, invalidate: (() => void) | undefined): boolean {
	const language = LANGUAGE_REGISTRATIONS[shikiLang];
	if (!language) return false;
	if (invalidate) {
		const callbacks = languageLoadCallbacks.get(shikiLang) ?? new Set<() => void>();
		callbacks.add(invalidate);
		languageLoadCallbacks.set(shikiLang, callbacks);
	}
	if (pendingLanguages.has(shikiLang)) return true;
	pendingLanguages.add(shikiLang);
	const requestId = initializationId;
	void shikiHighlighter
		?.loadLanguage(language)
		.then(() => {
			if (requestId !== initializationId) return;
			loadedLanguages.add(shikiLang);
			const callbacks = languageLoadCallbacks.get(shikiLang);
			languageLoadCallbacks.delete(shikiLang);
			callbacks?.forEach((callback) => {
				callback();
			});
		})
		.catch(() => {
			if (requestId !== initializationId) return;
			languageLoadCallbacks.delete(shikiLang);
		})
		.finally(() => {
			if (requestId !== initializationId) return;
			pendingLanguages.delete(shikiLang);
		});
	return true;
}

function envPositiveInteger(name: string, fallback: number): number {
	const value = Number.parseInt(process.env[name] ?? "", 10);
	return Number.isFinite(value) && value > 0 ? value : fallback;
}

function ansiFromToken(
	token: { content: string; color?: string; fontStyle?: number },
	tokenColorToAnsi: TokenColorToAnsi,
	forceUnderline = false,
): string {
	const tokenColor = token.color ? normalizeTokenColor(token.color) : undefined;
	const colorAnsi = tokenColor ? tokenColorToAnsi(tokenColor) : "";
	let open = colorAnsi;
	let close = colorAnsi ? "\x1b[39m" : "";
	const fontStyle = token.fontStyle !== undefined && token.fontStyle > 0 ? token.fontStyle : 0;
	if (fontStyle & 2) {
		open += "\x1b[1m";
		close = `\x1b[22m${close}`;
	}
	if (fontStyle & 1) {
		open += "\x1b[3m";
		close = `\x1b[23m${close}`;
	}
	if (fontStyle & 4 || forceUnderline) {
		open += "\x1b[4m";
		close = `\x1b[24m${close}`;
	}
	if (fontStyle & 8) {
		open += "\x1b[9m";
		close = `\x1b[29m${close}`;
	}
	return open + escapeControlChars(token.content) + close;
}

function htmlFromToken(token: { content: string; color?: string; fontStyle?: number }): string {
	const styles: string[] = [];
	const tokenColor = token.color ? normalizeTokenColor(token.color) : undefined;
	if (tokenColor) styles.push(`color:${tokenColor}`);
	const fontStyle = token.fontStyle !== undefined && token.fontStyle > 0 ? token.fontStyle : 0;
	if (fontStyle & 2) styles.push("font-weight:bold");
	if (fontStyle & 1) styles.push("font-style:italic");
	const textDecorations: string[] = [];
	if (fontStyle & 4) textDecorations.push("underline");
	if (fontStyle & 8) textDecorations.push("line-through");
	if (textDecorations.length > 0) styles.push(`text-decoration:${textDecorations.join(" ")}`);
	const content = escapeHtml(token.content);
	return styles.length > 0 ? `<span style="${styles.join(";")}">${content}</span>` : content;
}

function normalizeTokenColor(hex: string): string | undefined {
	const clean = hex.replace(/^#/, "").slice(0, 6);
	return /^[0-9a-f]{6}$/i.test(clean) ? `#${clean}` : undefined;
}

function escapeControlChars(text: string): string {
	return text.replace(
		/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g,
		(char) => `\\x${char.charCodeAt(0).toString(16).padStart(2, "0")}`,
	);
}

function escapeHtml(text: string): string {
	return text.replace(/[&<>"']/g, (char) => {
		switch (char) {
			case "&":
				return "&amp;";
			case "<":
				return "&lt;";
			case ">":
				return "&gt;";
			case '"':
				return "&quot;";
			case "'":
				return "&#39;";
			default:
				return char;
		}
	});
}

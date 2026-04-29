import { createHighlighter } from "shiki";

const PRELOADED_SHIKI_LANGUAGES = [
	"bash",
	"shellscript",
	"typescript",
	"tsx",
	"javascript",
	"jsx",
	"json",
	"markdown",
	"html",
	"css",
	"scss",
	"yaml",
	"toml",
	"python",
	"diff",
	"go",
	"rust",
	"java",
	"c",
	"cpp",
	"csharp",
	"php",
	"ruby",
	"sql",
	"dockerfile",
	"xml",
	"dotenv",
	"makefile",
	"properties",
] as const;

const DEFAULT_SHIKI_THEME = "github-dark";
const MAX_HIGHLIGHT_CHARS = envPositiveInteger("PI_MAX_HIGHLIGHT_CHARS", 80000);
const CACHE_LIMIT = envPositiveInteger("PI_HIGHLIGHT_CACHE_LIMIT", 192);

let shikiHighlighter: Awaited<ReturnType<typeof createHighlighter>> | undefined;
let shikiTheme = DEFAULT_SHIKI_THEME;
let initializationPromise: Promise<void> | undefined;
let initializationId = 0;
const loadedLanguages = new Set<string>();
const pendingLanguages = new Set<string>();
const languageLoadCallbacks = new Map<string, Set<() => void>>();
const initializationCallbacks = new Set<() => void>();
const renderCache = new Map<string, string[]>();
type TokenColorToAnsi = (hexColor: string) => string;

export function initializeSyntaxHighlighter(theme = DEFAULT_SHIKI_THEME, invalidate?: () => void): Promise<void> {
	if (initializationPromise && shikiTheme === theme) {
		if (invalidate) initializationCallbacks.add(invalidate);
		return initializationPromise;
	}
	shikiTheme = theme;
	initializationCallbacks.clear();
	if (invalidate) initializationCallbacks.add(invalidate);
	const requestId = ++initializationId;
	initializationPromise = createHighlighter({ themes: [theme], langs: [...PRELOADED_SHIKI_LANGUAGES] })
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
			for (const lang of PRELOADED_SHIKI_LANGUAGES) loadedLanguages.add(lang);
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
		void initializeSyntaxHighlighter(shikiTheme, invalidate);
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
	const cacheKey = `${shikiTheme}\0${tokenColorCacheKey}\0${shikiLang}\0${code}`;
	const cached = renderCache.get(cacheKey);
	if (cached) {
		renderCache.delete(cacheKey);
		renderCache.set(cacheKey, cached);
		return [...cached];
	}
	try {
		if (!loadedLanguages.has(shikiLang)) requestLanguageLoad(shikiLang, invalidate);
		const tokens = shikiHighlighter.codeToTokensBase(code, { lang: shikiLang as never, theme: shikiTheme as never });
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
	const normalized = lang.toLowerCase();
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
	return normalized;
}

function cacheRendered(key: string, value: string[]): void {
	renderCache.set(key, [...value]);
	while (renderCache.size > CACHE_LIMIT) {
		const first = renderCache.keys().next().value;
		if (typeof first !== "string") break;
		renderCache.delete(first);
	}
}

function requestLanguageLoad(shikiLang: string, invalidate: (() => void) | undefined): void {
	if (invalidate) {
		const callbacks = languageLoadCallbacks.get(shikiLang) ?? new Set<() => void>();
		callbacks.add(invalidate);
		languageLoadCallbacks.set(shikiLang, callbacks);
	}
	if (pendingLanguages.has(shikiLang)) return;
	pendingLanguages.add(shikiLang);
	void shikiHighlighter
		?.loadLanguage(shikiLang as never)
		.then(() => {
			loadedLanguages.add(shikiLang);
			const callbacks = languageLoadCallbacks.get(shikiLang);
			languageLoadCallbacks.delete(shikiLang);
			callbacks?.forEach((callback) => {
				callback();
			});
		})
		.catch(() => {
			languageLoadCallbacks.delete(shikiLang);
		})
		.finally(() => pendingLanguages.delete(shikiLang));
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
	const fontStyle = token.fontStyle ?? 0;
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
	return open + escapeControlChars(token.content) + close;
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

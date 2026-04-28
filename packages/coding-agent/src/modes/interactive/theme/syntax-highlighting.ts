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
const loadedLanguages = new Set<string>();
const pendingLanguages = new Set<string>();
const languageLoadCallbacks = new Map<string, Set<() => void>>();
const renderCache = new Map<string, string[]>();

export function initializeSyntaxHighlighter(theme = DEFAULT_SHIKI_THEME, invalidate?: () => void): Promise<void> {
	if (initializationPromise && shikiTheme === theme) return initializationPromise;
	shikiTheme = theme;
	initializationPromise = createHighlighter({ themes: [theme], langs: [...PRELOADED_SHIKI_LANGUAGES] })
		.then((nextHighlighter) => {
			const previousHighlighter = shikiHighlighter;
			shikiHighlighter = nextHighlighter;
			previousHighlighter?.dispose();
			renderCache.clear();
			loadedLanguages.clear();
			pendingLanguages.clear();
			languageLoadCallbacks.clear();
			for (const lang of PRELOADED_SHIKI_LANGUAGES) loadedLanguages.add(lang);
			invalidate?.();
		})
		.catch(() => {
			shikiHighlighter = undefined;
			initializationPromise = undefined;
		});
	return initializationPromise;
}

export function highlightCodeWithShiki(
	code: string,
	lang: string | undefined,
	fallbackColor: (text: string) => string,
	invalidate?: () => void,
): string[] {
	const normalized = code.replace(/\t/g, "   ");
	const plain = () => normalized.split("\n").map((line) => fallbackColor(escapeControlChars(line)));
	if (!lang || shouldSkipHighlight(normalized)) return plain();
	if (!shikiHighlighter && !initializationPromise) void initializeSyntaxHighlighter(undefined, invalidate);
	return renderWithShiki(normalized, lang, invalidate) ?? plain();
}

export function renderWithShiki(code: string, lang: string | undefined, invalidate?: () => void): string[] | undefined {
	if (!shikiHighlighter || !lang || shouldSkipHighlight(code)) return undefined;
	const shikiLang = normalizeShikiLanguage(lang);
	const cacheKey = `${shikiTheme}\0${shikiLang}\0${code}`;
	const cached = renderCache.get(cacheKey);
	if (cached) {
		renderCache.delete(cacheKey);
		renderCache.set(cacheKey, cached);
		return cached;
	}
	try {
		if (!loadedLanguages.has(shikiLang)) requestLanguageLoad(shikiLang, invalidate);
		const tokens = shikiHighlighter.codeToTokensBase(code, { lang: shikiLang as never, theme: shikiTheme as never });
		const rendered = tokens.map((line) => normalizeShikiContrast(line.map((token) => ansiFromToken(token)).join("")));
		cacheRendered(cacheKey, rendered);
		return rendered;
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
	renderCache.set(key, value);
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

function normalizeShikiContrast(ansi: string): string {
	return ansi.replace(/\x1b\[([0-9;]*)m/g, (seq, params: string) =>
		isLowContrastFg(params) ? "\x1b[38;2;139;148;158m" : seq,
	);
}

function isLowContrastFg(params: string): boolean {
	if (params === "30" || params === "90" || params === "38;5;0" || params === "38;5;8") return true;
	if (!params.startsWith("38;2;")) return false;
	const [, , r, g, b] = params.split(";").map(Number);
	if (![r, g, b].every(Number.isFinite)) return false;
	const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
	return luminance < 72;
}

function ansiFromToken(token: { content: string; color?: string; fontStyle?: number }, forceUnderline = false): string {
	let open = token.color ? ansiFg(token.color) : "";
	let close = token.color ? "\x1b[39m" : "";
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

const ansiFgCache = new Map<string, string>();

function ansiFg(hex: string): string {
	const cached = ansiFgCache.get(hex);
	if (cached !== undefined) return cached;
	const clean = hex.replace(/^#/, "").slice(0, 6);
	const n = Number.parseInt(clean, 16);
	const ansi = Number.isFinite(n) ? `\x1b[38;2;${(n >> 16) & 255};${(n >> 8) & 255};${n & 255}m` : "";
	ansiFgCache.set(hex, ansi);
	return ansi;
}

function escapeControlChars(text: string): string {
	return text.replace(
		/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g,
		(char) => `\\x${char.charCodeAt(0).toString(16).padStart(2, "0")}`,
	);
}

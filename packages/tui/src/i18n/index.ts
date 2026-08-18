/**
 * Lightweight i18n module for pi TUI and coding agent.
 *
 * Supports:
 * - Locale detection (env > system > default)
 * - Nested key access with dot notation
 * - String interpolation with {{variable}} syntax
 * - Lazy loading of locale files
 * - Fallback chain (missing keys fall back to English)
 * - Plural support via _one/_other suffixes
 * - Runtime locale switching via setLocale()
 * - Number/date formatting via Intl APIs
 */

import { existsSync, readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

// =============================================================================
// Types
// =============================================================================

export type Locale = "en" | "zh-CN";

export type LocaleChangeListener = (locale: Locale) => void;

export interface I18nOptions {
	/** Override locale (takes priority over detection) */
	locale?: Locale;
	/** Custom locale directory path */
	localeDir?: string;
}

// =============================================================================
// Locale Detection
// =============================================================================

const SUPPORTED_LOCALES: readonly Locale[] = ["en", "zh-CN"];

function detectLocale(): Locale {
	const piLocale = process.env.PI_LOCALE;
	if (piLocale && isSupportedLocale(piLocale)) {
		return piLocale;
	}

	const systemLang = process.env.LANG || process.env.LC_ALL || process.env.LC_MESSAGES;
	if (systemLang) {
		const normalized = normalizeSystemLocale(systemLang);
		if (normalized && isSupportedLocale(normalized)) {
			return normalized;
		}
	}

	if (process.platform === "win32") {
		const winLocale = detectWindowsLocale();
		if (winLocale && isSupportedLocale(winLocale)) {
			return winLocale;
		}
	}

	return "en";
}

function isSupportedLocale(locale: string): locale is Locale {
	return SUPPORTED_LOCALES.includes(locale as Locale);
}

function normalizeSystemLocale(lang: string): Locale | undefined {
	const base = lang.split(".")[0].trim();
	if (!base) return undefined;

	const normalized = base.replace("_", "-");

	if (isSupportedLocale(normalized)) {
		return normalized;
	}

	for (const supported of SUPPORTED_LOCALES) {
		if (normalized.startsWith(supported.split("-")[0])) {
			return supported;
		}
	}

	return undefined;
}

function detectWindowsLocale(): Locale | undefined {
	try {
		const systemLocales = Intl.DateTimeFormat().resolvedOptions().locale;
		return normalizeSystemLocale(systemLocales);
	} catch {
		return undefined;
	}
}

// =============================================================================
// Translation Loading
// =============================================================================

type TranslationDict = Record<string, string | Record<string, unknown>>;

let currentLocale: Locale = "en";
let translations: TranslationDict = {};
let fallbackTranslations: TranslationDict = {};
let isInitialized = false;
let storedLocaleDir: string | undefined;
const localeListeners: Set<LocaleChangeListener> = new Set();

export function initI18n(options: I18nOptions = {}): void {
	currentLocale = options.locale ?? detectLocale();
	storedLocaleDir = options.localeDir;
	translations = loadTranslations(currentLocale, options.localeDir);
	if (currentLocale !== "en") {
		fallbackTranslations = loadTranslations("en", options.localeDir);
	} else {
		fallbackTranslations = {};
	}
	isInitialized = true;
}

/**
 * Switch locale at runtime and notify listeners.
 */
export function setLocale(locale: Locale, localeDir?: string): void {
	if (!SUPPORTED_LOCALES.includes(locale)) return;
	if (locale === currentLocale && isInitialized) return;

	currentLocale = locale;
	const dir = localeDir ?? storedLocaleDir;
	translations = loadTranslations(locale, dir);
	if (locale !== "en") {
		fallbackTranslations = loadTranslations("en", dir);
	} else {
		fallbackTranslations = {};
	}

	for (const listener of localeListeners) {
		try {
			listener(locale);
		} catch {
			// Listener errors should not break i18n
		}
	}
}

/**
 * Subscribe to locale changes. Returns an unsubscribe function.
 */
export function onLocaleChange(listener: LocaleChangeListener): () => void {
	localeListeners.add(listener);
	return () => {
		localeListeners.delete(listener);
	};
}

function loadTranslations(locale: Locale, localeDir?: string): TranslationDict {
	const dir = localeDir ?? getDefaultLocaleDir();
	const filePath = join(dir, `${locale}.json`);

	if (!existsSync(filePath)) {
		if (locale !== "en") {
			return loadTranslations("en", localeDir);
		}
		return {};
	}

	try {
		const content = readFileSync(filePath, "utf-8");
		return JSON.parse(content) as TranslationDict;
	} catch {
		return {};
	}
}

function getDefaultLocaleDir(): string {
	return join(dirname(fileURLToPath(import.meta.url)), "locales");
}

// =============================================================================
// Translation API
// =============================================================================

export function t(key: string, params?: Record<string, string | number>): string {
	if (!isInitialized) {
		initI18n();
	}

	// Plural support: if params has count, try key_one/key_other first
	let resolvedKey = key;
	if (params?.count !== undefined) {
		const pluralKey = params.count === 1 ? `${key}_one` : `${key}_other`;
		if (getNestedValue(translations, pluralKey) !== undefined) {
			resolvedKey = pluralKey;
		}
	}

	let value = getNestedValue(translations, resolvedKey);

	// Fallback chain: if missing in current locale, try English
	if (value === undefined && currentLocale !== "en") {
		value = getNestedValue(fallbackTranslations, resolvedKey);
	}

	if (value === undefined) {
		return key;
	}

	if (typeof value !== "string") {
		return key;
	}

	if (!params) {
		return value;
	}

	return value.replace(/\{\{(\w+)\}\}/g, (_, name: string) => {
		return params[name] !== undefined ? String(params[name]) : `{{${name}}}`;
	});
}

function getNestedValue(obj: TranslationDict, path: string): string | Record<string, unknown> | undefined {
	const parts = path.split(".");
	let current: unknown = obj;

	for (const part of parts) {
		if (typeof current !== "object" || current === null) {
			return undefined;
		}
		current = (current as Record<string, unknown>)[part];
		if (current === undefined) return undefined;
	}

	if (typeof current === "string") {
		return current;
	}
	if (typeof current === "object" && current !== null) {
		return current as Record<string, unknown>;
	}
	return undefined;
}

export function getLocale(): Locale {
	if (!isInitialized) {
		initI18n();
	}
	return currentLocale;
}

export function isCJK(): boolean {
	const locale = getLocale();
	return locale.startsWith("zh") || locale.startsWith("ja") || locale.startsWith("ko");
}

// =============================================================================
// Intl Formatting Helpers
// =============================================================================

/**
 * Format a number according to the current locale.
 * @example formatNumber(1234.56) // "1,234.56" (en) or "1,234.56" (zh-CN)
 * @example formatNumber(1234.56, { style: "currency", currency: "USD" }) // "$1,234.56"
 */
export function formatNumber(value: number, options?: Intl.NumberFormatOptions): string {
	const locale = getLocale();
	return new Intl.NumberFormat(locale, options).format(value);
}

/**
 * Format a date according to the current locale.
 * @example formatDate(new Date()) // "8/18/2026" (en) or "2026/8/18" (zh-CN)
 */
export function formatDate(date: Date, options?: Intl.DateTimeFormatOptions): string {
	const locale = getLocale();
	return new Intl.DateTimeFormat(locale, options).format(date);
}

/**
 * Format a relative time (e.g., "3 hours ago").
 * @example formatRelativeTime(-3, "hour") // "3 hours ago" (en) or "3小时前" (zh-CN)
 */
export function formatRelativeTime(
	value: number,
	unit: Intl.RelativeTimeFormatUnit,
	options?: Intl.RelativeTimeFormatOptions,
): string {
	const locale = getLocale();
	return new Intl.RelativeTimeFormat(locale, options).format(value, unit);
}

/**
 * Reset i18n state (for testing).
 */
export function resetI18n(): void {
	currentLocale = "en";
	translations = {};
	fallbackTranslations = {};
	isInitialized = false;
	storedLocaleDir = undefined;
	localeListeners.clear();
}

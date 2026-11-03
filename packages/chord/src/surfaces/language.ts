// A language and rendering in it (decision "Messages and languages in the app kit" (1), (3), refined in the build): a
// `Language` is a locale with its text direction, the host's composed catalogs and where fallbacks are reported. A
// render is synchronous, and while one runs its language is the current one: a message function's own `formatTime` or a
// plain `t(...)` it calls renders in it. Outside a render there is no current language (a server, a test, a log line):
// `t` renders the first catalog. No module-wide setting (the current language exists only while a render runs): one
// process runs many hosts, and a server renders per recipient.

import { canonicalLocale, type TranslationIndex } from "./translations.ts";

/** A locale to render in: its direction, its fallback chain, the host's catalogs and the reports' destination. */
export type Language = {
	/** A canonical language tag (`de`, `pt-BR`). */
	readonly locale: string;
	readonly dir: "ltr" | "rtl";
	/** The locales tried in order before a namespace's first catalog: `pt-BR`, `pt`. */
	readonly chain: readonly string[];
	readonly translations: TranslationIndex;
	readonly report: (report: MessagesReport) => void;
};

/** What rendering reports: a key found only further down the chain, a contributed message that threw, a foreign message. */
export type MessagesReport =
	| {
			readonly kind: "fallback";
			readonly namespace: string;
			readonly locale: string;
			readonly key: string;
			/** The locale whose catalog had the key; `undefined`: the namespace's first catalog. */
			readonly used: string | undefined;
	  }
	| {
			readonly kind: "failed";
			readonly namespace: string;
			readonly locale: string;
			readonly key: string;
			/** The contributing plugin; `undefined`: the namespace's own catalogs (a message from a link that does not fit). */
			readonly plugin: string | undefined;
			readonly error: unknown;
	  }
	/** `t.render` got a message of another namespace or a key the catalogs do not have: it shows the key. */
	| { readonly kind: "unknown"; readonly namespace: string; readonly key: string; readonly expected: string };

/** The language `locale` (canonical) with the host's `translations`; `report` gets every report as it happens. */
export function createLanguage(
	locale: string,
	translations: TranslationIndex,
	report: (report: MessagesReport) => void,
): Language {
	return { locale, dir: directionOf(locale), chain: chainOf(locale), translations, report };
}

/** The language of the render under way; `undefined` outside one. */
let rendering: Language | undefined;

/** Runs `render` with `language` as the current language (synchronous: the language is gone when it returns). */
export function inLanguage<T>(language: Language | undefined, render: () => T): T {
	const outer = rendering;
	rendering = language;
	try {
		return render();
	} finally {
		rendering = outer;
	}
}

/** The current language: the render under way's, `undefined` outside one. */
export function currentLanguage(): Language | undefined {
	return rendering;
}

/**
 * The locale to use: the user's `pick` when a catalog offers it (or its base), else the first of the device's
 * `preferred` some catalog offers, else English (the source of truth) when offered, else the first offered, else `en`.
 */
export function resolveLocale(pick: string | null, preferred: readonly string[], offered: readonly string[]): string {
	return (
		matchLocale(pick === null ? [] : [pick], offered) ??
		matchLocale(preferred, offered) ??
		(offered.includes("en") ? "en" : (offered[0] ?? "en"))
	);
}

/**
 * The first of `preferred` that `offered` (canonical tags) has: itself, one of its bases (`de-CH` for `de-CH-1996`, then
 * `de`), or another of its language (`de-DE` for `de-AT`); `undefined` when none matches. Invalid tags are skipped
 * (the device's list is the platform's data).
 */
export function matchLocale(preferred: readonly string[], offered: readonly string[]): string | undefined {
	for (const wanted of preferred) {
		const locale = canonicalLocale(wanted);
		if (locale === undefined) continue;
		const exact = chainOf(locale).find((each) => offered.includes(each));
		if (exact !== undefined) return exact;
		const language = baseLanguage(locale);
		const related = offered.find((each) => baseLanguage(each) === language);
		if (related !== undefined) return related;
	}
	return undefined;
}

/** `locale` and its bases, longest first: `zh-Hant-TW`, `zh-Hant`, `zh`. */
function chainOf(locale: string): readonly string[] {
	const parts = locale.split("-");
	return parts.map((_, index) => parts.slice(0, parts.length - index).join("-"));
}

/** The language subtag of a canonical tag (`pt` of `pt-BR`). */
function baseLanguage(locale: string): string {
	return locale.split("-")[0]!;
}

/** The scripts written right to left (ISO 15924), as `Intl.Locale` maximizes a tag's script. */
const RTL_SCRIPTS = new Set(["Adlm", "Arab", "Hebr", "Mand", "Nkoo", "Rohg", "Samr", "Syrc", "Thaa", "Yezi"]);

/** The text direction of `locale`: right to left when its likely script is (Arabic for `ar`, `ur`, `fa`). */
function directionOf(locale: string): Language["dir"] {
	const script = new Intl.Locale(locale).maximize().script;
	return script !== undefined && RTL_SCRIPTS.has(script) ? "rtl" : "ltr";
}

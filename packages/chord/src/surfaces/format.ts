// Dates, times and numbers in the viewer's locale (decision "Messages and languages in the app kit" (1)): `Intl` with
// the current language's locale, so a message function's `formatTime(at)` follows the language it renders in. Outside a
// render the platform's default locale applies. A language's default formatters are made once, kept as long as it is.

import { currentLanguage, type Language } from "./language.ts";

/** A time (a `Date`, milliseconds, or an ISO string as messages carry it) in the current locale; `14:05` by default. */
export function formatTime(at: Date | number | string, options?: Intl.DateTimeFormatOptions): string {
	const language = currentLanguage();
	const format =
		options === undefined && language !== undefined
			? formattersOf(language).time
			: new Intl.DateTimeFormat(language?.locale, options ?? TIME);
	return format.format(new Date(at));
}

/** A number in the current locale (`1.234,5` in German). */
export function formatNumber(value: number, options?: Intl.NumberFormatOptions): string {
	const language = currentLanguage();
	const format =
		options === undefined && language !== undefined
			? formattersOf(language).number
			: new Intl.NumberFormat(language?.locale, options);
	return format.format(value);
}

/** `formatTime`'s default: hours and minutes. */
const TIME: Intl.DateTimeFormatOptions = { timeStyle: "short" };

/** A language's default formatters. */
type Formatters = { readonly time: Intl.DateTimeFormat; readonly number: Intl.NumberFormat };

/** The default formatters of each language, made at its first use: a formatter costs far more than a format. */
const FORMATTERS = new WeakMap<Language, Formatters>();

/** `language`'s default formatters. */
function formattersOf(language: Language): Formatters {
	let formatters = FORMATTERS.get(language);
	if (formatters === undefined) {
		formatters = {
			time: new Intl.DateTimeFormat(language.locale, TIME),
			number: new Intl.NumberFormat(language.locale),
		};
		FORMATTERS.set(language, formatters);
	}
	return formatters;
}

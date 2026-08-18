import type { Locale } from "@earendil-works/pi-tui";

export interface LocaleOption {
	value: Locale;
	label: string;
}

export const SUPPORTED_LOCALES: LocaleOption[] = [
	{ value: "en", label: "English" },
	{ value: "zh-CN", label: "简体中文" },
];

export const SUPPORTED_LOCALE_VALUES: readonly Locale[] = SUPPORTED_LOCALES.map((l) => l.value);

export function isValidLocale(value: string): value is Locale {
	return SUPPORTED_LOCALE_VALUES.includes(value as Locale);
}

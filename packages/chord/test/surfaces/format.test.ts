// Tests of the `Intl` helpers (decision "Messages and languages in the app kit" (1)): times and numbers in the current
// language's locale inside a render, the platform's outside one; a language's default formatters go with it.

import { describe, expect, it } from "vitest";
import { createLanguage, formatNumber, formatTime } from "../../src/index.ts";
import { inLanguage } from "../../src/surfaces/language.ts";
import { NO_TRANSLATIONS } from "../../src/surfaces/translations.ts";
import { expectCollected } from "../support.ts";

const language = (locale: string) => createLanguage(locale, NO_TRANSLATIONS, () => {});

const AT = new Date(2026, 10, 3, 14, 5);

describe("formatting in the current language", () => {
	it("formats times and numbers in the render's locale", () => {
		const de = language("de");
		expect(inLanguage(de, () => formatNumber(1234.5))).toBe("1.234,5");
		expect(inLanguage(language("en-US"), () => formatNumber(1234.5))).toBe("1,234.5");
		expect(inLanguage(de, () => formatTime(AT))).toBe("14:05");
		expect(inLanguage(language("en-US"), () => formatTime(AT.getTime()))).toBe("2:05 PM");
		expect(inLanguage(de, () => formatTime(AT.toISOString(), { hour: "numeric" }))).toBe("14 Uhr");
	});

	it("formats in the platform's default locale outside a render", () => {
		expect(formatNumber(1234.5)).toBe(new Intl.NumberFormat().format(1234.5));
		expect(formatTime(AT)).toBe(new Intl.DateTimeFormat(undefined, { timeStyle: "short" }).format(AT));
	});
});

describe("a language's formatters", () => {
	it("are collected with the language", async () => {
		const ref = (() => {
			const de = language("de");
			inLanguage(de, () => [formatTime(AT), formatNumber(1)]);
			return new WeakRef(de);
		})();
		await expectCollected(ref);
	});
});

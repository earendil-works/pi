// Tests of a language and rendering in it (decision "Messages and languages in the app kit" (3)): a language's
// direction and fallback chain; the locale resolved from the user's pick, the device's languages and the catalogs'
// locales; the render scope, current only while a render runs and nested renders restoring the outer one.

import { describe, expect, it } from "vitest";
import { createLanguage } from "../../src/index.ts";
import { currentLanguage, inLanguage, matchLocale, resolveLocale } from "../../src/surfaces/language.ts";
import { NO_TRANSLATIONS } from "../../src/surfaces/translations.ts";

const language = (locale: string) => createLanguage(locale, NO_TRANSLATIONS, () => {});

describe("a language", () => {
	it("has its locale's direction and its chain of bases", () => {
		expect(language("de").dir).toBe("ltr");
		expect(language("ar").dir).toBe("rtl");
		expect(language("he-IL").dir).toBe("rtl");
		expect(language("pt-BR").chain).toEqual(["pt-BR", "pt"]);
		expect(language("zh-Hant-TW").chain).toEqual(["zh-Hant-TW", "zh-Hant", "zh"]);
	});
});

describe("matching a locale", () => {
	it("takes the first preference offered: itself, a base, or another region of its language", () => {
		expect(matchLocale(["fr", "de"], ["de", "en"])).toBe("de");
		expect(matchLocale(["de-AT"], ["de", "en"])).toBe("de");
		expect(matchLocale(["de-AT"], ["de-DE", "en"])).toBe("de-DE");
		expect(matchLocale(["pt-br"], ["pt", "pt-BR"])).toBe("pt-BR");
		expect(matchLocale(["ja"], ["de", "en"])).toBeUndefined();
	});

	it("skips a device language that is no tag", () => {
		expect(matchLocale(["not a tag", "de"], ["de"])).toBe("de");
	});

	it("resolves the user's pick first, then the device's, then English, then the first offered", () => {
		expect(resolveLocale("fr", ["de"], ["de", "en", "fr"])).toBe("fr");
		expect(resolveLocale("it", ["de"], ["de", "en", "fr"])).toBe("de");
		expect(resolveLocale(null, ["ja"], ["de", "en"])).toBe("en");
		expect(resolveLocale(null, ["ja"], ["de", "fr"])).toBe("de");
		expect(resolveLocale(null, [], [])).toBe("en");
	});
});

describe("the render scope", () => {
	it("is current only while a render runs, and a nested render restores the outer", () => {
		const de = language("de");
		const fr = language("fr");
		expect(currentLanguage()).toBeUndefined();
		const seen = inLanguage(de, () => [
			currentLanguage(),
			inLanguage(fr, () => currentLanguage()),
			currentLanguage(),
		]);
		expect(seen).toEqual([de, fr, de]);
		expect(currentLanguage()).toBeUndefined();
		expect(() =>
			inLanguage(de, () => {
				throw new Error("render failed");
			}),
		).toThrow("render failed");
		expect(currentLanguage()).toBeUndefined();
	});
});

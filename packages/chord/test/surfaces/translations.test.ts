// Tests of the `Translations` registry (decision "Messages and languages in the app kit" (2)): one catalog per
// namespace and locale, the first by plugin name winning and the other reported, `override: true` winning over a
// catalog without it; locales canonical, invalid ones reported and left out; every locale offered listed; served on a
// host by the kit's facet.

import { describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT as context } from "../../src/context/index.ts";
import {
	createHost,
	defineFacet,
	defineMessages,
	type RegistryConflict,
	type Translation,
	Translations,
	translationsFacet,
} from "../../src/index.ts";
import { composeTranslations } from "../../src/surfaces/translations.ts";

const fr = (word: string, override?: true): Translation => ({
	namespace: "notes",
	locale: "fr",
	messages: { newNote: word },
	...(override === undefined ? {} : { override }),
});

/** The index of `contributions` (by plugin, in plugin-name order) and its reported conflicts. */
function compose(contributions: Record<string, readonly Translation[]>) {
	const conflicts: RegistryConflict[] = [];
	const table = Object.entries(contributions).map(([plugin, value]) => ({ plugin, version: 1, value }));
	const index = composeTranslations(table, { report: (conflict) => conflicts.push(conflict) });
	const word = (namespace: string, locale: string) =>
		index.catalogs.get(namespace)?.get(locale)?.value.messages.newNote;
	return { index, conflicts, word };
}

describe("composing translations", () => {
	it("keeps the first by plugin name for a namespace and locale, reporting the other", () => {
		const { word, conflicts } = compose({ "@a/fr": [fr("Nouvelle note")], "@b/fr": [fr("Note neuve")] });
		expect(word("notes", "fr")).toBe("Nouvelle note");
		expect(conflicts).toEqual([{ message: "notes in fr is contributed twice", plugins: ["@a/fr", "@b/fr"] }]);
	});

	it("lets `override: true` win over a catalog without it, unreported", () => {
		const { word, conflicts } = compose({ "@a/notes": [fr("Note")], "@b/better": [fr("Nouvelle note", true)] });
		expect(word("notes", "fr")).toBe("Nouvelle note");
		expect(conflicts).toEqual([]);
	});

	it("reports two overrides, the first by plugin name winning", () => {
		const { word, conflicts } = compose({ "@a/x": [fr("A", true)], "@b/y": [fr("B", true)] });
		expect(word("notes", "fr")).toBe("A");
		expect(conflicts.map(({ plugins }) => plugins)).toEqual([["@a/x", "@b/y"]]);
	});

	it("keys catalogs by canonical locale, leaves invalid ones out reported, lists the locales offered", () => {
		const { index, word, conflicts } = compose({
			"@a/notes": defineMessages("notes", { en: { newNote: "New note" }, "pt-br": { newNote: "Nova nota" } })
				.translations,
			"@b/bad": [{ namespace: "notes", locale: "not a tag", messages: {} }],
		});
		expect(word("notes", "pt-BR")).toBe("Nova nota");
		expect(index.locales).toEqual(["en", "pt-BR"]);
		expect(conflicts).toEqual([{ message: '"not a tag" is no locale (notes)', plugins: ["@b/bad"] }]);
	});
});

describe("the kit's facet", () => {
	it("serves the registry on a host, composing its plugins' contributions", async () => {
		const host = createHost({ onError: () => {} });
		await host.load(
			[
				{ name: "chord.translations", facet: translationsFacet() },
				{
					name: "@test/fr",
					facet: defineFacet((_host, self) => self.contribute(Translations, [fr("Nouvelle note")])),
				},
			],
			context,
		);
		const value = await host.registry(Translations, context);
		expect(value.value.locales).toEqual(["fr"]);
		await host.close(context);
	});
});

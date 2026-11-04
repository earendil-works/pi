// Tests of messages in code (decision "Messages and languages in the app kit" (1), (4)): `defineMessages` types every
// other catalog by the first (type errors for a missing, unknown or wrongly typed key) and checks its declaration; `t`
// renders down a language's chain (the host's catalog first, then the plugin's own, then the first catalog), reporting
// fallbacks; a contributed message that throws is reported and skipped; `t.message` builds typed data and `t.render`
// renders it, a foreign namespace or an unknown key showing the key.

import { describe, expect, it } from "vitest";
import {
	createLanguage,
	defineMessages,
	formatNumber,
	type MessageData,
	type MessageSchema,
	type MessagesOf,
	type MessagesReport,
	type Static,
	type Translation,
} from "../../src/index.ts";
import { composeTranslations } from "../../src/surfaces/translations.ts";

const notes = defineMessages("notes", {
	en: {
		newNote: "New note",
		empty: "No notes yet",
		count: (n: number) => (n === 1 ? "1 note" : `${formatNumber(n)} notes`),
		saved: (title: string, at: string) => `Saved "${title}" at ${at}`,
		when: (at: Date) => at.toISOString(),
	},
	de: {
		newNote: "Neue Notiz",
		empty: "Noch keine Notizen",
		count: (n) => (n === 1 ? "1 Notiz" : `${formatNumber(n)} Notizen`),
		saved: (title, at) => `„${title}“ um ${at} gespeichert`,
		when: (at) => at.toISOString(),
	},
	pt: { newNote: "Nova nota", empty: "Sem notas", count: (n) => `${n} notas`, saved: (t) => t, when: (at) => `${at}` },
});

const other = defineMessages("other", { en: { hello: "Hello" } });

/** A language for `locale` with the contributed `translations`, its reports collected in `reports`. */
function language(locale: string, translations: readonly Translation[] = [], reports: MessagesReport[] = []) {
	const index = composeTranslations([{ plugin: "@test/fr", version: 1, value: translations }], { report: () => {} });
	return createLanguage(locale, index, (report) => reports.push(report));
}

describe("defineMessages", () => {
	it("types every catalog by the first", () => {
		defineMessages("typed", {
			en: { a: "A", b: (n: number) => `${n}`, c: "C" },
			// @ts-expect-error a catalog without a key of the first
			de: { a: "A", b: (n) => `${n}` },
		});
		defineMessages("typed", {
			en: { a: "A", b: (n: number) => `${n}` },
			// @ts-expect-error a key's argument of another type
			de: { a: "A", b: (n: string) => n },
		});
		defineMessages("typed", {
			en: { a: "A" },
			// @ts-expect-error a key the first does not have
			de: { a: "A", c: "C" },
		});
		// Type checks only: never called.
		const calls = () => {
			// @ts-expect-error a wrong argument
			notes("count", "3");
			// @ts-expect-error an unknown key
			notes("svaed");
			// @ts-expect-error a missing argument
			notes("saved", "Plan");
		};
		const fr: MessagesOf<typeof notes> = {
			newNote: "Nouvelle note",
			empty: "Aucune note",
			count: (n) => `${n} notes`,
			saved: (title, at) => `« ${title} » ${at}`,
			when: (at) => at.toISOString(),
		};
		// @ts-expect-error a translation's type has every key
		const partial: MessagesOf<typeof notes> = { newNote: "Nouvelle note" };
		expect([fr.newNote, partial.newNote, typeof calls]).toEqual(["Nouvelle note", "Nouvelle note", "function"]);
	});

	it("refuses a namespace that is no name and a catalog key that is no language tag", () => {
		expect(() => defineMessages("Notes!", { en: { a: "A" } })).toThrow(/namespace/);
		expect(() => defineMessages("notes", { "not a tag": { a: "A" } })).toThrow(/no language tag/);
		expect(() => defineMessages("notes", {})).toThrow(/needs a catalog/);
	});

	it("lists its catalogs as contributions, by canonical locale", () => {
		const regional = defineMessages("regional", { en: { a: "A" }, "pt-br": { a: "Á" } });
		expect(regional.translations.map(({ namespace, locale }) => `${namespace} ${locale}`)).toEqual([
			"regional en",
			"regional pt-BR",
		]);
	});
});

describe("rendering in a language", () => {
	it("renders the first catalog outside a language", () => {
		expect(notes("count", 2)).toBe("2 notes");
		expect(notes.in(undefined)("newNote")).toBe("New note");
	});

	it("renders the plugin's own catalog of the language, values and functions", () => {
		const de = notes.in(language("de"));
		expect(de("newNote")).toBe("Neue Notiz");
		expect(de("count", 1234)).toBe("1.234 Notizen");
	});

	it("prefers the host's contributed catalog, falling back key by key down the chain, reported", () => {
		const reports: MessagesReport[] = [];
		const brazil = language(
			"pt-BR",
			[{ namespace: "notes", locale: "pt-BR", messages: { newNote: "Nova anotação" } }],
			reports,
		);
		const t = notes.in(brazil);
		expect(t("newNote")).toBe("Nova anotação");
		expect(t("empty")).toBe("Sem notas");
		expect(reports).toEqual([{ kind: "fallback", namespace: "notes", locale: "pt-BR", key: "empty", used: "pt" }]);
	});

	it("takes a key a partial contributed catalog lacks from the plugin's own of the same locale", () => {
		const reports: MessagesReport[] = [];
		const better = [
			{ namespace: "notes", locale: "de", messages: { newNote: "Neue Notiz!" }, override: true as const },
		];
		const t = notes.in(language("de", better, reports));
		expect([t("newNote"), t("empty")]).toEqual(["Neue Notiz!", "Noch keine Notizen"]);
		expect(reports).toEqual([]);
	});

	it("falls back to the first catalog when no catalog of the chain has the key", () => {
		const reports: MessagesReport[] = [];
		expect(notes.in(language("ja", [], reports))("newNote")).toBe("New note");
		expect(reports).toEqual([
			{ kind: "fallback", namespace: "notes", locale: "ja", key: "newNote", used: undefined },
		]);
	});

	it("reports a contributed message that throws and goes on (here: the plugin's own catalog)", () => {
		const reports: MessagesReport[] = [];
		const error = new Error("broken translation");
		const messages = {
			count: () => {
				throw error;
			},
		};
		const t = notes.in(language("de", [{ namespace: "notes", locale: "de", messages, override: true }], reports));
		expect(t("count", 2)).toBe("2 Notizen");
		expect(reports[0]).toEqual({
			kind: "failed",
			namespace: "notes",
			locale: "de",
			key: "count",
			plugin: "@test/fr",
			error,
		});
	});

	it("renders a plain `t` inside a message function in the language under way", () => {
		const outer = defineMessages("outer", {
			en: { line: (n: number) => `${notes("count", n)}!` },
			de: { line: (n) => `${notes("count", n)}!` },
		});
		expect(outer.in(language("de"))("line", 2)).toBe("2 Notizen!");
		expect(outer("line", 2)).toBe("2 notes!");
	});
});

describe("messages as data", () => {
	it("builds typed data for the keys whose arguments are data", () => {
		const saved = notes.message("saved", "Plan", "2026-11-03T10:00:00Z");
		expect(saved).toEqual({ namespace: "notes", key: "saved", params: ["Plan", "2026-11-03T10:00:00Z"] });
		const key: "saved" = saved.key;
		// @ts-expect-error a `Date` is no data: it would not cross a link
		notes.message("when", new Date());
		// @ts-expect-error a wrong argument
		notes.message("count", "2");
		expect(key).toBe("saved");
	});

	it("renders a message in the viewer's language", () => {
		const saved = notes.message("saved", "Plan", "10:00");
		expect(notes.in(language("de")).render(saved)).toBe("„Plan“ um 10:00 gespeichert");
		expect(notes.render(saved)).toBe('Saved "Plan" at 10:00');
		// @ts-expect-error a message of another namespace
		notes.render(other.message("hello"));
	});

	it("shows the key of a foreign or unknown message from a link, reported", () => {
		const reports: MessagesReport[] = [];
		const t = notes.in(language("de", [], reports));
		const foreign: Static<typeof MessageSchema> = { namespace: "other", key: "hello", params: [] };
		const unknown: MessageData = { namespace: "notes", key: "renamed", params: [] };
		expect(t.render(foreign)).toBe("hello");
		expect(t.render(unknown)).toBe("renamed");
		expect(reports).toEqual([
			{ kind: "unknown", namespace: "other", key: "hello", expected: "notes" },
			{ kind: "unknown", namespace: "notes", key: "renamed", expected: "notes" },
		]);
	});

	it("shows the key of a message whose params do not fit, reported", () => {
		const reports: MessagesReport[] = [];
		const wrong: MessageData = { namespace: "notes", key: "when", params: ["not a date"] };
		expect(notes.in(language("de", [], reports)).render(wrong)).toBe("when");
		expect(reports[0]).toMatchObject({ kind: "failed", namespace: "notes", key: "when", plugin: undefined });
	});
});

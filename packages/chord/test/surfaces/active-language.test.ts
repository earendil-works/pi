// Tests of the active language of a client (decision "Messages and languages in the app kit" (3)): a client follows
// the `Translations` registry, its principal's `LocaleChoice` and the device's languages; the host keeps the language
// as page state, set again only when the locale or the catalogs change; reports are passed on once each.

import { describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT as context } from "../../src/context/index.ts";
import {
	createHost,
	defineFacet,
	defineMessages,
	followActiveLanguage,
	hostKind,
	hostLanguage,
	type Language,
	LocaleChoice,
	localeChoiceFacet,
	type MessagesReport,
	memoryLinkPair,
	openStore,
	sqliteBackend,
	Translations,
	translationsFacet,
} from "../../src/index.ts";
import { openNodeSqliteDatabase } from "../../src/sqlite/node.ts";

type TestPrincipal = { readonly kind: "server" } | { readonly kind: "user"; readonly id: string };

const notes = defineMessages("notes", {
	en: { newNote: "New note", empty: "No notes" },
	de: { newNote: "Neue Notiz", empty: "Keine Notizen" },
});

/** A server with locale choices, and a client of `ada` whose plugins contribute the notes catalogs and `fr`. */
async function setup() {
	const store = await openStore(sqliteBackend(await openNodeSqliteDatabase(":memory:")), context);
	const server = createHost<TestPrincipal>({
		address: hostKind("server")(),
		principal: { kind: "server" },
		store,
		onError: () => {},
	});
	await server.load([{ name: "chord.locale.choice", facet: localeChoiceFacet<TestPrincipal>() }], context);
	const client = createHost<TestPrincipal>({ onError: () => {} });
	await client.load(
		[
			{ name: "chord.translations", facet: translationsFacet<TestPrincipal>() },
			{
				name: "@test/notes",
				facet: defineFacet<TestPrincipal>((_host, self) => self.contribute(Translations, notes.translations)),
			},
			{
				name: "@test/french",
				facet: defineFacet<TestPrincipal>((_host, self) =>
					self.contribute(Translations, [
						{ namespace: "notes", locale: "fr", messages: { newNote: "Nouvelle note" } },
					]),
				),
			},
		],
		context,
	);
	const [mine, theirs] = memoryLinkPair();
	server.accept(theirs, { principal: { kind: "user", id: "ada" } }, context);
	client.connect(mine, { principal: { kind: "server" } }, context);
	const close = async () => {
		await client.close(context);
		await server.close(context);
		await store.close(context);
	};
	return { client, close };
}

/** Waits until `check` holds. */
async function until(check: () => boolean): Promise<void> {
	for (let index = 0; index < 200 && !check(); index++) await new Promise((resolve) => setTimeout(resolve, 5));
	expect(check()).toBe(true);
}

describe("following the active language", () => {
	it("follows the device's languages, the principal's pick and the catalogs, kept as the host's page state", async () => {
		const { client, close } = await setup();
		const seen: Language[] = [];
		expect(hostLanguage(client).read()).toBeUndefined();
		const follower = await followActiveLanguage(
			client,
			["de-AT", "en"],
			(language) => seen.push(language),
			() => {},
			context,
		);
		expect(seen.at(-1)?.locale).toBe("de");
		expect(hostLanguage(client).read()).toBe(seen.at(-1));
		expect(notes.in(hostLanguage(client).read())("newNote")).toBe("Neue Notiz");
		const choice = await client.get(LocaleChoice, {}, context);
		await choice.choose("fr", context);
		await until(() => seen.at(-1)?.locale === "fr");
		follower.setDevice(["en"]);
		expect(seen.at(-1)?.locale).toBe("fr");
		await choice.choose(null, context);
		await until(() => seen.at(-1)?.locale === "en");
		const count = seen.length;
		follower.setDevice(["en-GB"]);
		expect(seen.length).toBe(count);
		follower.stop();
		choice.release();
		await close();
	});

	it("passes each distinct report on once", async () => {
		const { client, close } = await setup();
		const reports: MessagesReport[] = [];
		const follower = await followActiveLanguage(
			client,
			["fr"],
			() => {},
			(report) => reports.push(report),
			context,
		);
		const t = notes.in(hostLanguage(client).read());
		expect([t("empty"), t("empty"), t("newNote")]).toEqual(["No notes", "No notes", "Nouvelle note"]);
		expect(reports).toEqual([{ kind: "fallback", namespace: "notes", locale: "fr", key: "empty", used: undefined }]);
		follower.stop();
		await close();
	});
});

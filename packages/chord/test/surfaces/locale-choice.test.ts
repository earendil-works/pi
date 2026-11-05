// Tests of the locale choice (decision "Messages and languages in the app kit" (3)): a language tag or `null` per
// principal, kept by the kit's server facet; anything else refused.

import { describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT as context } from "../../src/context/index.ts";
import {
	createHost,
	hostKind,
	LocaleChoice,
	localeChoiceFacet,
	memoryLinkPair,
	openStore,
	sqliteBackend,
} from "../../src/index.ts";
import { openNodeSqliteDatabase } from "../../src/sqlite/node.ts";

type TestPrincipal = { readonly kind: "server" } | { readonly kind: "user"; readonly id: string };

describe("the locale choice", () => {
	it("keeps a language tag or null per principal and refuses anything else", async () => {
		const store = await openStore(sqliteBackend(await openNodeSqliteDatabase(":memory:")), context);
		const server = createHost<TestPrincipal>({
			address: hostKind("server")(),
			principal: { kind: "server" },
			store,
			onError: () => {},
		});
		await server.load([{ name: "chord.locale.choice", facet: localeChoiceFacet<TestPrincipal>() }], context);
		const client = createHost<TestPrincipal>({ onError: () => {} });
		await client.load([], context);
		const [mine, theirs] = memoryLinkPair();
		server.accept(theirs, { principal: { kind: "user", id: "ada" } }, context);
		client.connect(mine, { principal: { kind: "server" } }, context);
		const choice = await client.get(LocaleChoice, {}, context);
		expect(choice.pick.value).toBeNull();
		await choice.choose("pt-BR", context);
		await choice.choose(null, context);
		for (const bad of ["not a tag", "x".repeat(36), "de_DE"]) {
			await expect(choice.choose(bad, context)).rejects.toMatchObject({ code: "invalid", reason: "args" });
		}
		choice.release();
		await client.close(context);
		await server.close(context);
		await store.close(context);
	});
});

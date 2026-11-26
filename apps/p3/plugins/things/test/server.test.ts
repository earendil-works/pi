// The things plugin's server facet alone (`testPlugin`: built as production builds it, beside the test kind's plugin):
// nothing it asks for is unserved; Pi exists; a kind registers itself (`ThingKinds`, `ThingHooks`); a person made a
// thing and put in holds it with the ticks its grants give, a session's worker as its agent, and nobody else.

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT as context, type P3Principal } from "@earendil-works/p3/v1";
import { type TestedPlugin, testPlugin } from "@earendil-works/p3/v1/testing";
import { ThingsStore } from "../contract.server.ts";
import { BOARD, Board } from "./kinds.ts";

let t: TestedPlugin<P3Principal>;

beforeEach(async () => {
	t = await testPlugin(fileURLToPath(new URL("../", import.meta.url)), { kind: "server", stubs: [BOARD] }, context);
});

afterEach(() => t.close(context));

describe("the things plugin on the server", () => {
	it("holds a thing as its maker, as a session's agent put in, and denies anyone else", async () => {
		const store = await t.host.get(ThingsStore, {}, context);
		const pi = (await store.workspaces.children.page({ parent: "" }, 1, context)).items[0]!.workspace;
		const by = { kind: "plugin", plugin: "test" } as const;
		const ada = await store.createPerson({ name: "Ada", madeBy: by }, context);
		const ben = await store.createPerson({ name: "Ben", madeBy: by }, context);
		await store.putParty({ workspace: pi, party: { kind: "person", person: ada }, source: by }, context);
		await store.putParty({ workspace: pi, party: { kind: "agent", session: "s1" }, source: by }, context);
		const thing = await store.create(
			{ kind: Board.name, name: "b", workspace: pi, by: { kind: "person", person: ada } },
			context,
		);
		const granted = (principal: P3Principal) =>
			t.root(
				async (ctx) =>
					[...(await ctx.get(Board.contract, { workspace: pi, thing }, { readyTimeout: 300 })).granted].sort(),
				context,
				{ principal },
			);
		assert.deepEqual(await granted({ kind: "person", id: ada, name: "Ada" }), [
			"draw",
			"look",
			"moderate",
			"notes",
			"read",
			"write",
		]);
		assert.deepEqual(await granted({ kind: "worker", session: "s1" }), ["read"]);
		await assert.rejects(granted({ kind: "person", id: ben, name: "Ben" }), /nothing given here/);
		await assert.rejects(granted({ kind: "worker", session: "s2" }), /nothing given here/);
		assert.deepEqual(t.unserved(), []);
	});
});

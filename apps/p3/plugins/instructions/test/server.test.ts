// The instructions plugin on the server (`testPlugin`, beside the things plugin's server facet): the kind (made by
// people; the agents get Use by its default grants, a flag; a person is let in only with a tick or `@open`, and gets
// no flag: Use is for agents), the text and the language as plain state, the default before anyone set them, a
// change through the store (what `configure` writes) reaching a held reference live, and the settings dropped when the
// thing goes with its last link.

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
	type Ctx,
	BACKGROUND_CONTEXT as context,
	type P3Principal,
	type Reference,
	until,
} from "@earendil-works/p3/v1";
import { type TestedPlugin, testPlugin } from "@earendil-works/p3/v1/testing";
import { eventually, within } from "../../../test/until.ts";
import { OneThing, ThingHooks, ThingsStore } from "../../things/contract.server.ts";
import { OPEN, type Source } from "../../things/contract.ts";
import thingsServer from "../../things/server.ts";
import { Instructions, InstructionsKind } from "../contract.ts";
import { InstructionsStore } from "../store.ts";

/** Who sets things up in the tests. */
const BY: Source = { kind: "plugin", plugin: "test" };

/** The session whose agent the tests hold as. */
const SESSION = "s1";

let t: TestedPlugin<P3Principal>;
let things: Reference<typeof ThingsStore>;
let pi: string;

beforeEach(async () => {
	t = await testPlugin(
		fileURLToPath(new URL("../", import.meta.url)),
		{ kind: "server", stubs: [{ name: "@earendil-works/p3-things", facet: thingsServer }] },
		context,
	);
	things = await t.host.get(ThingsStore, {}, context);
	pi = (await things.workspaces.children.page({ parent: "" }, 1, context)).items[0]!.workspace;
	await things.putParty({ workspace: pi, party: { kind: "agent", session: SESSION }, source: BY }, context);
});

afterEach(() => t.close(context));

/** Makes instructions in Pi, by the test; links them with the kind's default grants. */
const make = () => things.create({ kind: InstructionsKind.name, name: "Coding", workspace: pi, by: BY }, context);

/** Runs `fn` with `principal`'s reference to instructions `thing` in Pi. */
function holding<T>(
	principal: P3Principal,
	thing: string,
	fn: (instructions: Reference<typeof Instructions>, ctx: Ctx<P3Principal>) => Promise<T>,
) {
	return t.root(
		async (ctx) => fn(await ctx.get(Instructions, { workspace: pi, thing }, { readyTimeout: 500 }), ctx),
		context,
		{ principal },
	);
}

const AGENT: P3Principal = { kind: "worker", session: SESSION };

describe("instructions", () => {
	it("give the agent Use and the default text before anyone set them; a person with @open gets no flag", async () => {
		const thing = await make();
		await holding(AGENT, thing, async (instructions) => {
			assert.deepEqual([...instructions.granted], ["use"]);
			assert.equal(instructions.language.value, "en");
			assert.match(instructions.text.value, /concise/);
		});
		const id = await things.createPerson({ name: "Ann", madeBy: BY }, context);
		const ann: P3Principal = { kind: "person", id, name: "Ann" };
		await things.putParty({ workspace: pi, party: { kind: "person", person: id }, source: BY }, context);
		const party = { kind: "person", person: id } as const;
		await things.setGrants(
			{ source: BY, grants: [{ workspace: pi, thing, party, tick: OPEN, gives: true }] },
			context,
		);
		await holding(ann, thing, async (instructions) => assert.deepEqual([...instructions.granted], []));
	});

	it("show a change of their settings live, and drop them with the thing", async () => {
		const thing = await make();
		const store = await t.host.get(InstructionsStore, {}, context);
		await holding(AGENT, thing, async (instructions, ctx) => {
			await store.set({ thing, text: "Sei freundlich.", language: "de" }, context);
			await until(instructions.text, (text) => text === "Sei freundlich.", within("the new text", ctx));
			assert.equal(instructions.language.value, "de");
		});
		await things.unlink({ workspace: pi, thing }, context);
		await eventually(
			async () => (await store.settings.of.page({ thing }, 1, context)).items.length,
			(count) => count === 0,
		);
	});

	it("are seeded once in Pi with the default text, and configure sets some settings, keeping the others", async () => {
		const seeded = await t.host.get(OneThing, { kind: InstructionsKind.name }, context);
		const seed = await until(seeded.thing, (thing) => thing !== "", within("the seed", context));
		await holding(AGENT, seed, async (instructions) => assert.match(instructions.text.value, /concise/));
		const hook = (await t.host.registry(ThingHooks, context)).value.get(InstructionsKind.name)?.value;
		assert.ok(hook?.configure !== undefined);
		await t.root((ctx) => hook.configure!(seed, { language: "de" }, ctx), context);
		await holding(AGENT, seed, async (instructions, ctx) => {
			await until(instructions.language, (language) => language === "de", within("the language", ctx));
			assert.match(instructions.text.value, /concise/, "the text kept");
		});
	});
});

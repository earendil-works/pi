// The notes plugin end to end (`kindE2E`: p3's real server on a copy of the built-in plugins, clients over `/chord`
// signed in as persons): Ann and Ben are put into Pi, a notebook is made there, Ben's Write withheld; both hold it
// open, Ann writes and Ben sees her note live, named, with no writing members of his own. A reload of the notes plugin
// (a real edit of its server facet, applied as `p3 apply` does, restarting both callers' objects) while both hold it
// keeps the notes and both holds: Ann writes again and Ben sees it; a second edit reloads again. The agent's tools on
// a session's notebooks come with sessions as session workspaces (ERNDL-704); their harness part is the worker test's.

import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { BACKGROUND_CONTEXT as context, type Reference, until } from "@earendil-works/p3/v1";
import { within } from "../../../test/until.ts";
import { type KindE2E, kindE2E, restarted } from "../../things/test/kind-e2e.ts";
import { Notes, NotesKind } from "../kind.ts";

let running: KindE2E | undefined;

afterEach(async () => {
	await running?.close();
	running = undefined;
});

/** Waits until `notes` shows `text` first, written by `name`. */
async function shows(notes: Reference<typeof Notes>, text: string, name: string): Promise<void> {
	await until(
		notes.list,
		({ rows: [first] }) => first?.text === text && first.author.kind === "person" && first.author.name === name,
		within(`"${text}" by ${name}`, context, 10_000),
	);
}

describe("the notes end to end", () => {
	it("shows a writer's note in a reader's open notebook live, also across a reload of the plugin", async () => {
		const e = await kindE2E(context);
		running = e;
		const [ann, ben] = [await e.person("Ann"), await e.person("Ben")];
		const thing = await e.thingIn(NotesKind.name, "Plan");
		await e.ticks(thing, { kind: "person", person: ben.id }, ["write"], false);
		const notebook = { workspace: e.pi, thing };
		const anns = await (await e.client(ann)).get(Notes, notebook, context);
		const bens = await (await e.client(ben)).get(Notes, notebook, context);
		assert.deepEqual([anns.name.value, [...anns.granted].sort()], ["Plan", ["add", "edit", "remove"]]);
		assert.deepEqual([bens.name.value, bens.add, bens.granted.size], ["Plan", undefined, 0]);
		await anns.add!({ text: "before the reload" }, context);
		await shows(bens, "before the reload", "Ann");
		const applied = await e.reload("notes", "@earendil-works/p3-notes");
		assert.equal(applied.stopped, undefined);
		assert.deepEqual(restarted(applied, NotesKind.name), { changed: ["@earendil-works/p3-notes"], restarted: 2 });
		await until(
			anns.state,
			(state) => state.kind === "live" && anns.add !== undefined,
			within("Ann live", context, 10_000),
		);
		await anns.add!({ text: "after the reload" }, context);
		await shows(bens, "after the reload", "Ann");
		// A second edit of the same file reloads again (Astra, round 3: a repeated export did not build).
		const again = await e.reload("notes", "@earendil-works/p3-notes");
		assert.deepEqual(restarted(again, NotesKind.name), { changed: ["@earendil-works/p3-notes"], restarted: 2 });
		await until(
			anns.state,
			(state) => state.kind === "live" && anns.add !== undefined,
			within("Ann live again", context, 10_000),
		);
		assert.deepEqual(
			bens.list.value.rows.map(({ text }) => text),
			["after the reload", "before the reload"],
		);
		assert.deepEqual(e.t.errors, []);
	});
});

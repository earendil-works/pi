// The checklist end to end (`kindE2E`: p3's real server on a copy of the built-in plugins, clients over `/chord`
// signed in as persons): Ann and Ben are put into Pi, a checklist is made there, Ben's Add and Tick withheld; both hold
// it open, Ann adds and ticks items and Ben sees them live, with neither member of his own. A reload of the checklist
// plugin (a real edit of its server facet, applied as `p3 apply` does, restarting both callers' objects) while both
// hold it keeps the items and both holds: Ann ticks again and Ben sees it. The agent's tools on a session's
// checklists come with sessions as session workspaces (ERNDL-704); their harness part is the worker test's.

import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { BACKGROUND_CONTEXT as context, type Reference, until } from "@earendil-works/p3/v1";
import { within } from "../../../test/until.ts";
import { type KindE2E, kindE2E, restarted } from "../../things/test/kind-e2e.ts";
import { Checklist, ChecklistKind } from "../contract.ts";

let running: KindE2E | undefined;

afterEach(async () => {
	await running?.close();
	running = undefined;
});

/** Waits until `list` shows which of its items are done, in order. */
async function shows(list: Reference<typeof Checklist>, done: readonly boolean[]): Promise<void> {
	await until(
		list.items,
		(items) => items.length === done.length && items.every((item, at) => item.done === done[at]),
		within(`the items done: ${done.join()}`, context, 10_000),
	);
}

describe("the checklist end to end", () => {
	it("shows a writer's ticks in a reader's open checklist live, also across a reload of the plugin", async () => {
		const e = await kindE2E(context);
		running = e;
		const [ann, ben] = [await e.person("Ann"), await e.person("Ben")];
		const thing = await e.thingIn(ChecklistKind.name, "Packing");
		await e.ticks(thing, { kind: "person", person: ben.id }, ["add", "tick"], false);
		const list = { workspace: e.pi, thing };
		const anns = await (await e.client(ann)).get(Checklist, list, context);
		const bens = await (await e.client(ben)).get(Checklist, list, context);
		assert.deepEqual([anns.name.value, [...anns.granted].sort()], ["Packing", ["addItem", "setDone"]]);
		assert.deepEqual([bens.name.value, bens.addItem, bens.granted.size], ["Packing", undefined, 0]);
		const tent = await anns.addItem!({ text: "tent" }, context);
		const stove = await anns.addItem!({ text: "stove" }, context);
		await anns.setDone!({ id: tent, done: true }, context);
		await shows(bens, [true, false]);
		const applied = await e.reload("checklist", "@earendil-works/p3-checklist");
		assert.equal(applied.stopped, undefined);
		assert.deepEqual(restarted(applied, ChecklistKind.name), {
			changed: ["@earendil-works/p3-checklist"],
			restarted: 2,
		});
		await until(
			anns.state,
			(state) => state.kind === "live" && anns.setDone !== undefined,
			within("Ann live", context, 10_000),
		);
		await anns.setDone!({ id: stove, done: true }, context);
		await shows(bens, [true, true]);
		assert.deepEqual(
			bens.items.value.map(({ text }) => text),
			["tent", "stove"],
		);
		assert.deepEqual(e.t.errors, []);
	});
});

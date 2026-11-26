// The checklist end to end (`testServer`: the real server with the built-in plugins, clients over `/chord` signed in
// as persons): Ann and Ben are put into Pi, a checklist is made there, Ben's Write withheld; both hold it open, Ann
// adds and ticks items and Ben sees them live, with no writing members of his own. A reload of the checklist plugin
// (a real edit of its server facet, applied as `p3 apply` does) while both hold it keeps the items and both holds:
// Ann ticks again and Ben sees it. The agent's tools on a session's checklists come with sessions as session
// workspaces (ERNDL-704); their harness part is the worker test's.

import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT as context, type Reference, until } from "@earendil-works/p3/v1";
import { type TestServer, testServer } from "@earendil-works/p3/v1/testing";
import { within } from "../../../test/until.ts";
import { ThingsStore } from "../../things/contract.server.ts";
import type { Source } from "../../things/contract.ts";
import { Checklist, ChecklistKind } from "../contract.ts";

/** Who sets things up in the test. */
const BY: Source = { kind: "plugin", plugin: "test" };

let running: TestServer | undefined;
const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
	await running?.close(context);
	running = undefined;
	for (const cleanup of cleanups.splice(0)) await cleanup();
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
		const dir = await mkdtemp(join(tmpdir(), "p3-checklist-reload-"));
		cleanups.push(() => rm(dir, { recursive: true, force: true }));
		const root = join(dir, "built-in");
		await cp(fileURLToPath(new URL("../../", import.meta.url)), root, { recursive: true });
		const t = await testServer({ builtIn: root }, context);
		running = t;
		const { ann, ben, list } = await t.host.root(async (ctx) => {
			const things = await ctx.get(ThingsStore, {});
			const pi = (await things.workspaces.children.page({ parent: "" }, 1, ctx)).items[0]!.workspace;
			const person = async (name: string) => {
				const id = await things.createPerson({ name, madeBy: BY }, ctx);
				await things.putParty({ workspace: pi, party: { kind: "person", person: id }, source: BY }, ctx);
				return { kind: "person", id, name } as const;
			};
			const [ann, ben] = [await person("Ann"), await person("Ben")];
			const thing = await things.create({ kind: ChecklistKind.name, name: "Packing", workspace: pi, by: BY }, ctx);
			const party = { kind: "person", person: ben.id } as const;
			await things.setGrants(
				{ source: BY, grants: [{ workspace: pi, thing, party, tick: "write", gives: false }] },
				ctx,
			);
			return { ann, ben, list: { workspace: pi, thing } };
		}, context);
		const anns = await (await t.client(context, ann)).get(Checklist, list, context);
		const bens = await (await t.client(context, ben)).get(Checklist, list, context);
		assert.deepEqual([anns.name.value, [...anns.granted].sort()], ["Packing", ["add", "tick"]]);
		assert.deepEqual([bens.name.value, bens.add, bens.granted.size], ["Packing", undefined, 0]);
		const tent = await anns.add!({ text: "tent" }, context);
		const stove = await anns.add!({ text: "stove" }, context);
		await anns.tick!({ id: tent, done: true }, context);
		await shows(bens, [true, false]);
		// A real edit of the server facet, applied as `p3 apply` does once the watcher saw it.
		const file = join(root, "checklist", "server.ts");
		await writeFile(file, `${await readFile(file, "utf8")}\n// edited\n`);
		await until(
			t.plugins,
			(marks) => marks.dirty.includes("@earendil-works/p3-checklist"),
			within("the watcher's marks", context, 10_000),
		);
		const applied = await t.apply(context);
		assert.equal(applied.stopped, undefined);
		await until(
			anns.state,
			(state) => state.kind === "live" && anns.tick !== undefined,
			within("Ann live", context, 10_000),
		);
		await anns.tick!({ id: stove, done: true }, context);
		await shows(bens, [true, true]);
		assert.deepEqual(
			bens.items.value.map(({ text }) => text),
			["tent", "stove"],
		);
		assert.deepEqual(t.errors, []);
	});
});

// The notes plugin end to end (`testServer`: the real server with the built-in plugins, clients over `/chord` signed in
// as persons): Ann and Ben are put into Pi, a notebook is made there, Ben's Write withheld; both hold it open, Ann
// writes and Ben sees her note live, named, with no writing members of his own. A reload of the notes plugin (a real
// edit of its server facet, applied as `p3 apply` does) while both hold it keeps the notes and both holds: Ann writes
// again and Ben sees it. The agent's tools on a session's notebooks come with sessions as session workspaces
// (ERNDL-704); their harness part is the worker test's.

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
import { Notes, NotesKind } from "../contract.ts";

/** Who sets things up in the test. */
const BY: Source = { kind: "plugin", plugin: "test" };

let running: TestServer | undefined;
const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
	await running?.close(context);
	running = undefined;
	for (const cleanup of cleanups.splice(0)) await cleanup();
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
		const dir = await mkdtemp(join(tmpdir(), "p3-notes-reload-"));
		cleanups.push(() => rm(dir, { recursive: true, force: true }));
		const root = join(dir, "built-in");
		await cp(fileURLToPath(new URL("../../", import.meta.url)), root, { recursive: true });
		const t = await testServer({ builtIn: root }, context);
		running = t;
		const { ann, ben, notebook } = await t.host.root(async (ctx) => {
			const things = await ctx.get(ThingsStore, {});
			const pi = (await things.workspaces.children.page({ parent: "" }, 1, ctx)).items[0]!.workspace;
			const person = async (name: string) => {
				const id = await things.createPerson({ name, madeBy: BY }, ctx);
				await things.putParty({ workspace: pi, party: { kind: "person", person: id }, source: BY }, ctx);
				return { kind: "person", id, name } as const;
			};
			const [ann, ben] = [await person("Ann"), await person("Ben")];
			const notebook = await things.create({ kind: NotesKind.name, name: "Plan", workspace: pi, by: BY }, ctx);
			const party = { kind: "person", person: ben.id } as const;
			await things.setGrants(
				{ source: BY, grants: [{ workspace: pi, thing: notebook, party, tick: "write", gives: false }] },
				ctx,
			);
			return { ann, ben, notebook: { workspace: pi, thing: notebook } };
		}, context);
		const anns = await (await t.client(context, ann)).get(Notes, notebook, context);
		const bens = await (await t.client(context, ben)).get(Notes, notebook, context);
		assert.deepEqual([anns.name.value, [...anns.granted].sort()], ["Plan", ["add", "edit", "remove"]]);
		assert.deepEqual([bens.name.value, bens.add, bens.granted.size], ["Plan", undefined, 0]);
		await anns.add!({ text: "before the reload" }, context);
		await shows(bens, "before the reload", "Ann");
		// A real edit of the server facet, applied as `p3 apply` does once the watcher saw it.
		const file = join(root, "notes", "server.ts");
		await writeFile(file, `${await readFile(file, "utf8")}\n// edited\n`);
		await until(
			t.plugins,
			(marks) => marks.dirty.includes("@earendil-works/p3-notes"),
			within("the watcher's marks", context, 10_000),
		);
		const applied = await t.apply(context);
		assert.equal(applied.stopped, undefined);
		await until(
			anns.state,
			(state) => state.kind === "live" && anns.add !== undefined,
			within("Ann live", context, 10_000),
		);
		await anns.add!({ text: "after the reload" }, context);
		await shows(bens, "after the reload", "Ann");
		assert.deepEqual(
			bens.list.value.rows.map(({ text }) => text),
			["after the reload", "before the reload"],
		);
		assert.deepEqual(t.errors, []);
	});
});

// The checklist end to end (`testServer`: the real server, the session's worker as a process, the tests' faux login
// under test, clients over `/chord`): a person makes a checklist in her session, adds an item and keeps it open; the
// agent's scripted answer calls `checklist_tick` and the item shows done in her view; with the agent's options set to
// no check, its next request offers no `checklist_tick`. A reload of the checklist plugin (server and worker facets)
// while her view is open keeps her items and her view.

import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
	BACKGROUND_CONTEXT as context,
	type Host,
	type P3Principal,
	SESSION_THINGS_WRITES,
	SessionThings,
	TRANSCRIPT_WRITES,
	Transcript,
	until,
} from "@earendil-works/p3/v1";
import { PeopleStore, SessionsStore } from "@earendil-works/p3/v1/server";
import { type TestServer, testServer } from "@earendil-works/p3/v1/testing";
import { assertGranted } from "../../../test/granted.ts";
import { FauxRequests, type Step } from "../../../test/plugins/faux-login/contract.ts";
import { scriptFaux } from "../../../test/support.ts";
import { within } from "../../../test/until.ts";
import { CHECKLIST_CHECKS, Checklist, ChecklistKind } from "../contract.ts";

/** The faux login plugin, a plugin under test of a root of its own. */
const FAUX = fileURLToPath(new URL("../../../test/plugins/faux-login/", import.meta.url));

let running: TestServer | undefined;
const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
	await running?.close(context);
	running = undefined;
	for (const cleanup of cleanups.splice(0)) await cleanup();
});

/** The agent's script: `@tick` ticks `item` of `checklist`; a tool's result and anything else get "ticked". */
function script(checklist: string, item: string): Step[] {
	const args = JSON.stringify({ checklist, item, done: true });
	return [
		{ when: "@tick", reply: [{ kind: "tool", name: "checklist_tick", args }] },
		{ when: "", reply: [{ kind: "text", text: "ticked" }] },
	];
}

/** Sends `text` to `session`'s transcript as the owner of `client`. */
async function send(client: Host<P3Principal>, session: string, text: string): Promise<void> {
	await client.root(async (ctx) => {
		const transcript = await ctx.get(Transcript, { session });
		assertGranted(transcript, ...TRANSCRIPT_WRITES);
		await transcript.send({ text, requestId: text }, ctx);
	}, context);
}

describe("the checklist end to end", () => {
	it(
		"shows the agent's tick in a person's open view; offers checklist_tick only while its options say check",
		{ skip: "until sessions are workspaces, ERNDL-704 push 3" },
		async () => {
			const t = await testServer({ plugins: [FAUX] }, context);
			running = t;
			const ann = await t.host.root(
				async (ctx) => (await ctx.get(PeopleStore, {})).createPerson({ name: "Ann" }, ctx),
				context,
			);
			const session = await t.host.root(
				async (ctx) =>
					(await ctx.get(SessionsStore, {})).create(
						{
							app: "coding",
							title: "Groceries",
							members: [{ kind: "person", id: ann, access: "write" }],
						},
						ctx,
					),
				context,
			);
			// Ann makes a checklist, adds an item and keeps it open.
			const client = await t.client(context, { kind: "person", id: ann, name: "Ann" });
			const things = await client.get(SessionThings, { session }, context);
			assertGranted(things, ...SESSION_THINGS_WRITES);
			const checklist = await things.create({ kind: ChecklistKind.name, name: "Groceries" }, context);
			const list = await client.get(Checklist, { session, thing: checklist }, context);
			assertGranted(list, ...CHECKLIST_CHECKS);
			const milk = await list.add({ text: "milk" }, context);
			// The session's faux login, made in its workspace by the server; its script needs the checklist's and the
			// item's ids.
			await scriptFaux(t.host, session, script(checklist, milk), context);
			const owner = await t.client(context);
			await send(owner, session, "@tick");
			await until(
				list.items,
				(items) => items.some(({ id, done }) => id === milk && done),
				within("the agent's tick", context, 20_000),
			);
			// The agent's own options: no check. Its next request offers no ticking.
			const managed = await owner.get(SessionThings, { session }, context);
			assertGranted(managed, ...SESSION_THINGS_WRITES);
			await managed.setOptions({ thing: checklist, for: { kind: "agent" }, options: { check: false } }, context);
			await send(owner, session, "plain");
			const requests = await owner.get(FauxRequests, { session }, context);
			const seen = await until(
				requests.requests,
				(all) => all.some(({ last }) => last === "plain"),
				within("the plain request", context, 20_000),
			);
			const plain = seen.find(({ last }) => last === "plain")!;
			assert.ok(plain.tools.includes("checklist_read"), plain.tools.join());
			assert.ok(!plain.tools.includes("checklist_tick"), plain.tools.join());
			assert.ok(seen.find(({ last }) => last === "@tick")?.tools.includes("checklist_tick"));
			assert.equal(list.granted.has("add") ? "checker" : "reader", "checker", "Ann's own options stay the default");
			assert.deepEqual(t.errors, []);
		},
	);

	it("keeps a person's items and open view through a reload of the plugin", async () => {
		const dir = await mkdtemp(join(tmpdir(), "p3-checklist-reload-"));
		cleanups.push(() => rm(dir, { recursive: true, force: true }));
		const root = join(dir, "built-in");
		await cp(fileURLToPath(new URL("../../", import.meta.url)), root, { recursive: true });
		const t = await testServer({ builtIn: root }, context);
		running = t;
		const owner = await t.client(context);
		const session = await t.host.root(
			async (ctx) => (await ctx.get(SessionsStore, {})).create({ app: "coding", title: "Reload" }, ctx),
			context,
		);
		const things = await owner.get(SessionThings, { session }, context);
		assertGranted(things, ...SESSION_THINGS_WRITES);
		const checklist = await things.create({ kind: ChecklistKind.name }, context);
		const list = await owner.get(Checklist, { session, thing: checklist }, context);
		assertGranted(list, ...CHECKLIST_CHECKS);
		await list.add({ text: "before" }, context);
		// Real edits of both facets, applied as `p3 apply` does once the watcher saw them.
		for (const facet of ["server.ts", "web.tsx"]) {
			const file = join(root, "checklist", facet);
			await writeFile(file, `${await readFile(file, "utf8")}\n// edited\n`);
		}
		await until(t.plugins, (marks) => marks.dirty.length > 0, within("the watcher's marks", context, 10_000));
		const applied = await t.apply(context);
		assert.equal(applied.stopped, undefined);
		await until(list.state, (state) => state.kind === "live", within("the list live again", context));
		await list.add({ text: "after" }, context);
		assert.deepEqual(
			list.items.value.map(({ text }) => text),
			["before", "after"],
		);
		assert.deepEqual(t.errors, []);
	});
});

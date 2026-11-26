// The notes plugin end to end (`testServer`: the real server, the session's worker as a process, the tests' faux
// login under test, clients over `/chord`): a person makes a notebook in her session and keeps it open; the agent's scripted
// answer calls `notes_write` and the note appears in her view, written by the agent; with the agent's options set to
// no edit, the next request offers `notes_read` only; a reload of the notes plugin (server and worker facets) while
// her view is open and the worker runs keeps the notes, and the agent writes again after it.

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
	type Reference,
	SESSION_THINGS_WRITES,
	SessionThings,
	TRANSCRIPT_WRITES,
	Transcript,
	thingOf,
	until,
} from "@earendil-works/p3/v1";
import { PeopleStore, SessionsStore } from "@earendil-works/p3/v1/server";
import { type TestServer, type TestServerOptions, testServer } from "@earendil-works/p3/v1/testing";
import { assertGranted } from "../../../test/granted.ts";
import { FauxLogin, FauxRequests, type Step } from "../../../test/plugins/faux-login/contract.ts";
import { within } from "../../../test/until.ts";
import { Notes, NotesKind } from "../contract.ts";

/** The faux login plugin, a plugin under test of a root of its own. */
const FAUX = fileURLToPath(new URL("../../../test/plugins/faux-login/", import.meta.url));

/**
 * The agent's script for notebook `notebook`: `@<tag>` writes a note `from the agent: <tag>` there; a tool's result
 * and anything else are answered with "noted".
 */
function script(notebook: string): Step[] {
	return [
		...["first", "second"].map((tag) => ({
			when: `@${tag}`,
			reply: [
				{
					kind: "tool" as const,
					name: "notes_write",
					args: JSON.stringify({ notebook, text: `from the agent: ${tag}` }),
				},
			],
		})),
		{ when: "", reply: [{ kind: "text" as const, text: "noted" }] },
	];
}

let running: TestServer | undefined;
const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
	await running?.close(context);
	running = undefined;
	for (const cleanup of cleanups.splice(0)) await cleanup();
});

/** A test server with the faux login under test. */
async function start(options: TestServerOptions = {}): Promise<TestServer> {
	running = await testServer({ plugins: [FAUX], ...options }, context);
	return running;
}

/**
 * On `t`: Ann, a coding session she writes in (following nobody) with a faux login, a notebook she makes there and
 * her client holding it open; then the login's script set for that notebook (the tools take the notebook's id, known
 * once it is made).
 */
async function annsNotebook(t: TestServer) {
	const id = await t.host.root(
		async (ctx) => (await ctx.get(PeopleStore, {})).createPerson({ name: "Ann" }, ctx),
		context,
	);
	const session = await t.host.root(
		async (ctx) =>
			(await ctx.get(SessionsStore, {})).create(
				{
					app: "coding",
					title: "Notes",
					members: [{ kind: "person", id, access: "write" }],
					things: [thingOf(FauxLogin)],
				},
				ctx,
			),
		context,
	);
	const client = await t.client(context, { kind: "person", id, name: "Ann" });
	const things = await client.get(SessionThings, { session }, context);
	assertGranted(things, ...SESSION_THINGS_WRITES);
	const thing = await things.create({ kind: NotesKind.name, name: "Ann's notebook" }, context);
	const notes = await client.get(Notes, { session, thing }, context);
	assert.equal(notes.granted.has("add") ? "editor" : "reader", "editor");
	await t.host.root(async (ctx) => {
		const store = await ctx.get(SessionsStore, {});
		const links = (await store.links.of.page({ session }, 10, ctx)).items;
		const login = links.find(({ kind }) => kind === FauxLogin.name)?.thing ?? assert.fail("no faux login");
		const options = { provider: "faux", script: script(thing), tool: false };
		await store.setOptions({ session, thing: login, for: { kind: "everyone" }, options }, ctx);
	}, context);
	return { session, thing, notes };
}

/** Sends `text` to `session`'s transcript as the owner of `client`. */
async function send(client: Host<P3Principal>, session: string, text: string): Promise<void> {
	await client.root(async (ctx) => {
		const transcript = await ctx.get(Transcript, { session });
		assertGranted(transcript, ...TRANSCRIPT_WRITES);
		await transcript.send({ text, requestId: text }, ctx);
	}, context);
}

/** Waits until `notes` shows the agent's note `from the agent: <tag>`, written by an agent. */
async function written(notes: Reference<typeof Notes>, tag: string): Promise<void> {
	await until(
		notes.list,
		(list) => list.rows.some((note) => note.text === `from the agent: ${tag}` && note.author.kind === "agent"),
		within(`the agent's note ${tag}`, context, 20_000),
	);
}

describe("the notes end to end", { skip: "until sessions are workspaces, ERNDL-704 push 3" }, () => {
	it("shows the agent's note in a person's open view; offers notes_write only while its options say edit", async () => {
		const t = await start();
		const { session, thing, notes } = await annsNotebook(t);
		const owner = await t.client(context);
		await send(owner, session, "@first");
		await written(notes, "first");
		// The agent's own options: no edit. Its next request offers reading only.
		const managed = await owner.get(SessionThings, { session }, context);
		assertGranted(managed, ...SESSION_THINGS_WRITES);
		await managed.setOptions({ thing, for: { kind: "agent" }, options: { edit: false } }, context);
		await send(owner, session, "plain");
		const requests = await owner.get(FauxRequests, { session }, context);
		const last = await until(
			requests.requests,
			(seen) => seen.some((request) => request.last === "plain"),
			within("the plain request", context, 20_000),
		);
		const plain = last.find((request) => request.last === "plain")!;
		assert.ok(plain.tools.includes("notes_read"), plain.tools.join());
		assert.ok(!plain.tools.includes("notes_write"), plain.tools.join());
		assert.ok(last.find((request) => request.last === "@first")?.tools.includes("notes_write"));
		assert.equal(
			notes.granted.has("add") ? "editor" : "reader",
			"editor",
			"Ann's own access stays as the default says",
		);
		assert.deepEqual(t.errors, []);
	});

	it("keeps the notes and a person's open view through a reload of the plugin while the worker runs", async () => {
		const dir = await mkdtemp(join(tmpdir(), "p3-notes-reload-"));
		cleanups.push(() => rm(dir, { recursive: true, force: true }));
		const root = join(dir, "built-in");
		await cp(fileURLToPath(new URL("../../", import.meta.url)), root, { recursive: true });
		const t = await start({ builtIn: root });
		const { session, notes } = await annsNotebook(t);
		const owner = await t.client(context);
		await send(owner, session, "@first");
		await written(notes, "first");
		// Real edits of both facets, applied as `p3 apply` does once the watcher saw them.
		for (const facet of ["server.ts", "worker.ts"]) {
			const file = join(root, "notes", facet);
			await writeFile(file, `${await readFile(file, "utf8")}\n// edited\n`);
		}
		await until(t.plugins, (marks) => marks.dirty.length > 0, within("the watcher's marks", context, 10_000));
		const applied = await t.apply(context);
		assert.equal(applied.stopped, undefined);
		await send(owner, session, "@second");
		await written(notes, "second");
		assert.deepEqual(
			notes.list.value.rows.map(({ text }) => text),
			["from the agent: second", "from the agent: first"],
		);
		assert.deepEqual(t.errors, []);
	});
});

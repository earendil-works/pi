// Tests of the kit's session workers (`session-workers.ts` on the server, `worker.ts` in the worker): a worker per
// session with its own directory and store, kept across its restarts; the route's admission asked before a worker
// starts; a worker base that does not build.

import assert from "node:assert/strict";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";
import { isChordError } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { method, remote, Session, str } from "@earendil-works/p3/v1";
import type { App } from "../../src/kit/app.ts";
import { kitApp, ROUTE, tempDir, WORKER } from "./support.ts";

/** The notes plugin's contract (`NOTES_PLUGIN`), declared again for the tests (contracts are data). */
const Notes = remote("test.notes", {
	version: 1,
	params: { id: str() },
	hostAddress: ({ id }) => Session({ id }),
	variants: { main: { state: { text: str(), address: str() }, methods: { write: method(str()) } } },
});

/** A plugin on each session's worker: a persisted document, and the worker's own address from `WorkerInfo`. */
const NOTES_PLUGIN = {
	"worker.ts": [
		'import { defineFacet, defineState, local, method, obj, remote, Session, str } from "@earendil-works/p3/v1";',
		'import { WorkerInfo } from "@earendil-works/p3/v1/worker";',
		'const Notes = remote("test.notes", { version: 1, params: { id: str() }, hostAddress: ({ id }) => Session({ id }),',
		"\tvariants: { main: { state: { text: str(), address: str() }, methods: { write: method(str()) } } } });",
		'const Text = defineState("test.text", { schema: obj({ text: str() }), version: 1, initial: () => ({ text: "" }), persist: true, checkpointWhen: () => false });',
		'const Store = local("test.store", { version: 1, params: {}, members: { text: str(), write: method(str()) } });',
		"export default defineFacet((host) => {",
		"\thost.serve(Store, (_params, self) => {",
		"\t\tconst text = self.state(Text);",
		"\t\treturn { text: self.derive([text], ([value]) => value.text),",
		"\t\t\twrite: async (next, ctx) => { await text.change((draft) => { draft.text = next; }, ctx); return null; } };",
		"\t});",
		"\thost.serve(Notes, (_params, _principal, self) => {",
		"\t\tconst store = self.get(Store, {});",
		"\t\tconst info = self.get(WorkerInfo, {});",
		'\t\treturn { variant: "main", members: { text: store.text, write: (next, ctx) => store.write(next, ctx),',
		"\t\t\taddress: self.derive([info.address], ([address]) => address.key) } };",
		"\t});",
		"});",
	].join("\n"),
};

/** The plugins of these tests: the notes on each worker, and a route that knows every session but `closed`. */
const PLUGINS = { notes: NOTES_PLUGIN, route: { "server.ts": ROUTE } };

/**
 * `Notes` of session `id` on `app`, live; rejects as soon as that session's worker fails its start (a hold alone would
 * wait a minute for it).
 */
async function notesOf(app: App, id: string) {
	const held = app.host.get(Notes, { id }, context);
	let settled = false;
	const failed = async (): Promise<never> => {
		for (;;) {
			const state = app.workers.state.value[Session({ id }).key];
			if (state?.status === "failed") throw new Error(`the worker of ${id} failed: ${state.error.message}`);
			if (settled) return held as never;
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
	};
	try {
		return await Promise.race([held, failed()]);
	} finally {
		settled = true;
		held.catch(() => {});
	}
}

describe("a worker's directory", () => {
	it("keeps its store in workers/<kind>/<key>/ across its process's restarts, each address its own", async () => {
		const { app, dataDir } = await kitApp({ plugins: PLUGINS });
		const notes = await notesOf(app, "s1");
		assert.equal(notes.address.value, "session|s1");
		await notes.write("kept", context);
		notes.release();
		const dir = join(dataDir, "workers", "session", "session%7Cs1");
		assert.ok((await readdir(dir)).includes("store.sqlite"));
		const mode = async (path: string) => (await stat(path)).mode & 0o777;
		assert.deepEqual(
			await Promise.all([dir, join(dir, ".."), join(dir, "store.sqlite")].map(mode)),
			[0o700, 0o700, 0o600],
		);
		await app.workers.stop(Session({ id: "s1" }), context);
		await app.workers.retry(Session({ id: "s1" }), context);
		const again = await notesOf(app, "s1");
		const other = await notesOf(app, "s2");
		// Each worker has its own directory: two sessions, two of them.
		assert.deepEqual((await readdir(join(dataDir, "workers", "session"))).sort(), ["session%7Cs1", "session%7Cs2"]);
		assert.deepEqual([again.text.value, other.text.value, other.address.value], ["kept", "", "session|s2"]);
	});
});

describe("the route's admission", () => {
	it("is asked before a worker starts: a session `SessionRoute` does not know starts none", async () => {
		const { app, dataDir } = await kitApp({ plugins: PLUGINS });
		await assert.rejects(app.host.get(Notes, { id: "closed" }, context), (error) => isChordError(error, "forbidden"));
		await notesOf(app, "open");
		// Before the admission, the route's `authorize`: a person reaches no worker, also a running one.
		const person = { kind: "person", id: "max", name: "Max" } as const;
		await assert.rejects(
			app.host.root(async (ctx) => ctx.get(Notes, { id: "open" }), context, { principal: person }),
			(error) => isChordError(error, "forbidden"),
		);
		assert.deepEqual(Object.keys(app.workers.state.value), ["session|open"]);
		assert.deepEqual(await readdir(join(dataDir, "workers", "session")), ["session%7Copen"]);
	});
});

describe("a worker base that does not build", () => {
	it("is reported and fails the workers at their start; the server runs on", async () => {
		const worker = { ...WORKER, entry: join(await tempDir(), "worker.ts") };
		const { app, errors } = await kitApp({ plugins: PLUGINS, worker });
		const notes = app.host.hold(Notes, { id: "s1" }, context);
		while (app.workers.state.value["session|s1"]?.status !== "failed") {
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
		assert.ok(errors.some((error) => error.kind === "base_build"));
		assert.equal(notes.state.value.kind, "failed");
		notes.release();
		// The server answers: its own objects are untouched.
		assert.match(app.ownerLink(), /^http:/);
	});
});

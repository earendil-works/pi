// Files' search walk (files/server.ts `searched`), over a stand-in machine whose host hides one folder of the test's
// own: a hidden folder and `.git` are not entered, a search that found more than it answers says so, and a cancelled
// search fails rather than answering what it found so far.

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { type Context, BACKGROUND_CONTEXT as context, type P3Principal, withCancel } from "@earendil-works/p3/v1";
import { FileError, NodeExecutionEnv } from "@earendil-works/p3/v1/server";
import { type TestedPlugin, testPlugin } from "@earendil-works/p3/v1/testing";
import { MACHINE_KIND } from "../../environments/contract.ts";
import environmentsServer from "../../environments/server.ts";
import { fakeMachine, fakeType } from "../../environments/test/fake-machine.ts";
import peopleServer from "../../people/server.ts";
import { OneThing, ThingsStore } from "../../things/contract.server.ts";
import thingsServer from "../../things/server.ts";
import { Files, FilesKind } from "../contract.ts";

/** The folder the stand-in host hides. */
let hiddenFolder = "";

/** While set, a listing of this folder waits until its call is cancelled; `entered` resolves when it began. */
let stuck = "";
let entered = Promise.withResolvers<void>();

/** The folders listed, in order. */
const listed: string[] = [];

/** A stand-in for this device's host: Node's files, `hiddenFolder` hidden, a listing of `stuck` waiting. */
const hiding = fakeType(
	() =>
		fakeMachine({
			env: new NodeExecutionEnv({ cwd: "/" }),
			hidden: [hiddenFolder],
			listNames: async (folder, max, context) => {
				listed.push(folder);
				if (folder === stuck) {
					entered.resolve();
					await new Promise((resolve) => context.abortSignal?.addEventListener("abort", resolve, { once: true }));
					return { ok: false, error: new FileError("aborted", "aborted") };
				}
				const names = (await readdir(folder, { withFileTypes: true })).map((entry) => ({
					name: entry.name,
					kind: entry.isDirectory() ? ("directory" as const) : ("file" as const),
				}));
				return { ok: true, value: { names: names.slice(0, max), more: names.length > max } };
			},
		}).host,
);

describe("Files' search", () => {
	let t: TestedPlugin<P3Principal>;
	let root: string;
	let search: (
		path: string,
		query: string,
		call?: Context,
	) => Promise<{ hits: { path: string; kind: string }[]; truncated: boolean }>;

	before(async () => {
		root = await mkdtemp(join(tmpdir(), "p3-files-search-"));
		hiddenFolder = join(root, "private");
		const stubs = [
			{ name: "@earendil-works/p3-a-hiding-machine", facet: hiding },
			{ name: "@earendil-works/p3-things", facet: thingsServer },
			{ name: "@earendil-works/p3-environments", facet: environmentsServer },
			{ name: "@earendil-works/p3-people", facet: peopleServer },
		];
		t = await testPlugin(fileURLToPath(new URL("../", import.meta.url)), { kind: "server", stubs }, context);
		const things = await t.host.get(ThingsStore, {}, context);
		const pi = (await things.workspaces.children.page({ parent: "" }, 1, context)).items[0]!.workspace;
		const thing = (await t.host.get(OneThing, { kind: FilesKind.name }, context)).thing.value;
		const machine = (await t.host.get(OneThing, { kind: MACHINE_KIND }, context)).thing.value;
		const by = { kind: "plugin", plugin: "test" } as const;
		const id = await things.createPerson({ name: "Ann", madeBy: by }, context);
		await things.putParty({ workspace: pi, party: { kind: "person", person: id }, source: by }, context);
		search = (path, query, call = context) =>
			t.root(
				async (ctx) =>
					(await ctx.get(Files, { workspace: pi, thing }, { readyTimeout: 500 })).search!(
						{ machine, path, query },
						ctx,
					),
				call,
				{ principal: { kind: "person", id, name: "Ann" } },
			);
	});

	after(async () => {
		await t.close(context);
		await rm(root, { recursive: true, force: true });
	});

	it("does not enter a hidden folder or .git, and does not answer them", async () => {
		for (const folder of ["private", ".git", "src"]) {
			await mkdir(join(root, folder, "needle-folder"), { recursive: true });
			await writeFile(join(root, folder, "needle-folder", "needle-file"), "");
		}
		const found = await search(root, "needle");
		assert.deepEqual(found.hits.map(({ path }) => path).sort(), [
			join(root, "src", "needle-folder"),
			join(root, "src", "needle-folder", "needle-file"),
		]);
		assert.equal(found.truncated, false);
		assert.deepEqual((await search(root, "private")).hits, [], "the hidden folder itself is no hit");
	});

	it("answers 200 hits of more and says it was truncated; exactly 200 are not", async () => {
		const many = join(root, "many");
		await mkdir(many);
		await Promise.all(Array.from({ length: 200 }, (_, i) => writeFile(join(many, `hit-${i}`), "")));
		assert.deepEqual(await search(many, "hit-").then(({ hits, truncated }) => [hits.length, truncated]), [
			200,
			false,
		]);
		await writeFile(join(many, "hit-200"), "");
		assert.deepEqual(await search(many, "hit-").then(({ hits, truncated }) => [hits.length, truncated]), [200, true]);
	});

	it("fails when it is cancelled while a folder is being read, and reads no folder after (astra round 2, should 11)", async () => {
		stuck = join(root, "a-slow");
		await mkdir(stuck, { recursive: true });
		await mkdir(join(root, "z-after"), { recursive: true });
		const { context: call, cancel } = withCancel(context);
		entered = Promise.withResolvers<void>();
		const searching = search(root, "anything", call);
		await entered.promise;
		const before = listed.length;
		cancel(new Error("the person went away"));
		await assert.rejects(searching);
		await new Promise<void>((resolve) => setImmediate(resolve));
		assert.deepEqual(listed.slice(before), [], "no folder read after the cancellation");
		stuck = "";
	});
});

// The files plugin on the server (`testPlugin`, beside the things, environments and people plugins' server facets):
// Files is made in Pi once and gives everyone there Read and Write; Read lists, searches and reads, Write uploads,
// renames and removes, and with no tick there is no member; both ticks are for people only. Every call reaches its
// machine as the caller: a machine hidden in the workspace is refused, so are relative paths, Pi's data folder and
// what holds it. A Files hidden below is not there. A held Files loses Read in the flush in which it is withheld.

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
	type Ctx,
	BACKGROUND_CONTEXT as context,
	isChordError,
	type P3Principal,
	type Reference,
	until,
} from "@earendil-works/p3/v1";
import { ServerRuntime } from "@earendil-works/p3/v1/server";
import { type TestedPlugin, testPlugin } from "@earendil-works/p3/v1/testing";
import { within } from "../../../test/until.ts";
import { MACHINE_KIND } from "../../environments/contract.ts";
import environmentsServer from "../../environments/server.ts";
import peopleServer from "../../people/server.ts";
import { OneThing, ThingsStore } from "../../things/contract.server.ts";
import type { Party, Source } from "../../things/contract.ts";
import thingsServer from "../../things/server.ts";
import { CHUNK, Files, FilesKind, PAGE } from "../contract.ts";

/** A person's principal. */
type Person = Extract<P3Principal, { kind: "person" }>;

/** Who sets things up in the tests. */
const BY: Source = { kind: "plugin", plugin: "test" };

/** What the files plugin's server facet uses of other plugins. */
const STUBS = [
	{ name: "@earendil-works/p3-things", facet: thingsServer },
	{ name: "@earendil-works/p3-environments", facet: environmentsServer },
	{ name: "@earendil-works/p3-people", facet: peopleServer },
];

let t: TestedPlugin<P3Principal>;
let things: Reference<typeof ThingsStore>;
let pi: string;
let files: string;
let machine: string;
let root: string;

beforeEach(async () => {
	t = await testPlugin(fileURLToPath(new URL("../", import.meta.url)), { kind: "server", stubs: STUBS }, context);
	things = await t.host.get(ThingsStore, {}, context);
	pi = (await things.workspaces.children.page({ parent: "" }, 1, context)).items[0]!.workspace;
	files = (await t.host.get(OneThing, { kind: FilesKind.name }, context)).thing.value;
	machine = (await t.host.get(OneThing, { kind: MACHINE_KIND }, context)).thing.value;
	root = await mkdtemp(join(tmpdir(), "p3-files-test-"));
	await mkdir(join(root, "src"));
	await writeFile(join(root, "src", "main.ts"), "console.log(1);\n");
	await writeFile(join(root, "README.md"), "# hello\n");
});

afterEach(async () => {
	await t.close(context);
	await rm(root, { recursive: true, force: true });
});

/** Makes person `name`, put into `workspace`; their principal. */
async function person(name: string, workspace = pi): Promise<Person> {
	const id = await things.createPerson({ name, madeBy: BY }, context);
	await things.putParty({ workspace, party: { kind: "person", person: id }, source: BY }, context);
	return { kind: "person", id, name };
}

/** Gives (or withholds, `gives: false`) `party` the ticks `ticks` on `thing` in `where`. */
const grant = (where: string, thing: string, party: Party, ticks: string[], gives = true) =>
	things.setGrants(
		{ source: BY, grants: ticks.map((tick) => ({ workspace: where, thing, party, tick, gives })) },
		context,
	);

/** Runs `fn` with `principal`'s Files held in `where`. */
function holding<T>(
	principal: P3Principal,
	where: string,
	fn: (files: Reference<typeof Files>, ctx: Ctx<P3Principal>) => Promise<T>,
): Promise<T> {
	return t.root(
		async (ctx) => fn(await ctx.get(Files, { workspace: where, thing: files }, { readyTimeout: 500 }), ctx),
		context,
		{ principal },
	);
}

/** Whether `promise` rejects with a ChordError of `code` whose message is `key`. */
async function refused(promise: Promise<unknown>, code: string, key?: string): Promise<void> {
	await assert.rejects(
		promise,
		(error: unknown) =>
			isChordError(error) &&
			error.code === code &&
			(key === undefined || JSON.stringify(error.details ?? null).includes(`"${key}"`)),
	);
}

describe("Files and its ticks", () => {
	it("is made in Pi once, and gives everyone there Read and Write; people only", async () => {
		const ann = await person("Ann");
		assert.deepEqual(await holding(ann, pi, async (f) => [...f.granted].sort()), [
			"download",
			"entries",
			"read",
			"remove",
			"rename",
			"search",
			"upload",
		]);
		assert.equal(
			(await t.host.get(OneThing, { kind: FilesKind.name }, context)).thing.value,
			files,
			"the same thing on a second hold",
		);
		await refused(grant(pi, files, { kind: "agents" }, ["read"]), "invalid");
		await things.putParty({ workspace: pi, party: { kind: "agent", session: "s1" }, source: BY }, context);
		await refused(
			holding({ kind: "worker", session: "s1" }, pi, async () => null),
			"forbidden",
		);
	});

	it("Read lists, searches and reads; without Write nothing changes; with no tick no member", async () => {
		const ann = await person("Ann");
		await grant(pi, files, { kind: "person", person: ann.id }, ["write"], false);
		await holding(ann, pi, async (f, ctx) => {
			const listed = await f.entries!({ machine, path: root }, ctx);
			assert.deepEqual(
				listed.entries.map(({ name, kind }) => [name, kind]),
				[
					["src", "directory"],
					["README.md", "file"],
				],
			);
			assert.equal(listed.next, undefined);
			const found = await f.search!({ machine, path: root, query: "MAIN" }, ctx);
			assert.deepEqual(found, { hits: [{ path: join(root, "src", "main.ts"), kind: "file" }], truncated: false });
			const read = await f.read!({ machine, path: join(root, "README.md"), offset: 2, length: 5 }, ctx);
			assert.deepEqual(read, { size: 8, data: Buffer.from("hello").toString("base64") });
			const url = new URL(await f.download!({ machine, path: join(root, "README.md") }, ctx), "http://p3");
			assert.equal(url.searchParams.get("path"), join(root, "README.md"));
			assert.equal(f.upload, undefined);
			assert.equal(f.rename, undefined);
			assert.equal(f.remove, undefined);
		});
		await grant(pi, files, { kind: "person", person: ann.id }, ["read"], false);
		assert.deepEqual(await holding(ann, pi, async (f) => [...f.granted]), []);
	});

	it("Write uploads in pieces, renames and removes", async () => {
		const ann = await person("Ann");
		const target = join(root, "upload.bin");
		const bytes = Buffer.alloc(CHUNK + 10, 7);
		await holding(ann, pi, async (f, ctx) => {
			const piece = (offset: number, end: number, last: boolean) =>
				f.upload!(
					{ machine, path: target, offset, data: bytes.subarray(offset, end).toString("base64"), last },
					ctx,
				);
			await piece(0, CHUNK, false);
			await refused(piece(5, CHUNK, false), "invalid", "uploadOutOfOrder");
			await piece(CHUNK, bytes.length, true);
			assert.deepEqual(await readFile(target), bytes);
			await f.rename!({ machine, from: target, to: join(root, "src", "moved.bin") }, ctx);
			await f.remove!({ machine, path: join(root, "src") }, ctx);
			const names = (await f.entries!({ machine, path: root }, ctx)).entries.map(({ name }) => name);
			assert.deepEqual(names, ["README.md"]);
		});
	});

	it("pages a folder of 10,000 entries: the first page in one call, the next after it", async () => {
		const ann = await person("Ann");
		const big = join(root, "big");
		await mkdir(big);
		await Promise.all(
			Array.from({ length: 10_000 }, (_, i) => writeFile(join(big, `f${String(i).padStart(5, "0")}`), "")),
		);
		await holding(ann, pi, async (f, ctx) => {
			const started = performance.now();
			const first = await f.entries!({ machine, path: big }, ctx);
			const took = performance.now() - started;
			assert.equal(first.entries.length, PAGE);
			assert.equal(first.entries[0]!.name, "f00000");
			const second = await f.entries!({ machine, path: big, after: first.next! }, ctx);
			assert.equal(second.entries[0]!.name, `f${String(PAGE).padStart(5, "0")}`);
			console.log(`files: the first page of 10,000 entries in ${took.toFixed(1)} ms`);
		});
	});
});

describe("where a call may reach", () => {
	it("refuses a machine hidden in the workspace, with its message", async () => {
		const child = await things.createWorkspace(
			{ kind: "things.workspace", name: "Family", parent: pi, by: BY },
			context,
		);
		const leo = await person("Leo", child);
		await holding(leo, child, async (f, ctx) => {
			await f.entries!({ machine, path: root }, ctx);
			await things.setSwitch({ workspace: child, item: { kind: "thing", thing: machine }, shown: false }, context);
			await until(f.state, (state) => state.kind === "live", within("the hold", ctx));
			await refused(f.entries!({ machine, path: root }, ctx), "forbidden", "notHere");
			await refused(f.entries!({ machine: "elsewhere", path: root }, ctx), "forbidden", "notHere");
		});
	});

	it("refuses relative paths, Pi's data folder, a link into it, and removing what holds it", async () => {
		const ann = await person("Ann");
		const dataDir = (await t.host.registry(ServerRuntime, context)).value.dataDir;
		await symlink(dataDir, join(root, "data"));
		await holding(ann, pi, async (f, ctx) => {
			await refused(f.entries!({ machine, path: "src" }, ctx), "invalid", "notAbsolute");
			await refused(f.entries!({ machine, path: dataDir }, ctx), "invalid", "hidden");
			await refused(f.entries!({ machine, path: join(root, "data") }, ctx), "invalid", "hidden");
			await refused(f.remove!({ machine, path: dirname(dataDir) }, ctx), "invalid", "hidden");
			await refused(f.remove!({ machine, path: "/" }, ctx), "invalid", "root");
			await refused(f.entries!({ machine, path: join(root, "nothing") }, ctx), "invalid", "notFound");
			const listed = await f.entries!({ machine, path: dirname(dataDir) }, ctx);
			assert.equal(
				listed.entries.some(({ path }) => path === dataDir),
				false,
			);
		});
	});

	it("is not there in a workspace below that hides it", async () => {
		const child = await things.createWorkspace(
			{ kind: "things.workspace", name: "Family", parent: pi, by: BY },
			context,
		);
		const leo = await person("Leo", child);
		await things.setSwitch({ workspace: child, item: { kind: "thing", thing: files }, shown: false }, context);
		await refused(
			holding(leo, child, async () => null),
			"forbidden",
		);
	});
});

describe("a held Files", () => {
	it("loses Read in the flush in which it is withheld: the next read fails", async () => {
		const ann = await person("Ann");
		await holding(ann, pi, async (f, ctx) => {
			const read = f.read!;
			await read({ machine, path: join(root, "README.md"), offset: 0, length: 1 }, ctx);
			await grant(pi, files, { kind: "person", person: ann.id }, ["read"], false);
			await until(f.state, (state) => state.kind === "live" && f.read === undefined, within("Read withheld", ctx));
			await refused(read({ machine, path: join(root, "README.md"), offset: 0, length: 1 }, ctx), "forbidden");
		});
	});
});

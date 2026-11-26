// The files plugin on the server (`testPlugin`, beside the things, environments and people plugins' server facets):
// Files is made in Pi once and gives everyone there Browse; Browse lists, searches and opens, Edit uploads, renames
// and removes, and with no tick there is no member; both ticks are for people only. Every call reaches its machine as
// the caller: a machine hidden in the workspace or with `@open` withheld is refused, so are relative paths, Pi's data
// folder and what holds it. Removing or moving a link acts on the link. The routes (called as the HTTP component
// calls them): a download reads one opened file to its end; an upload lands whole or not at all, beside nothing it
// did not make. A Files hidden below is not there. A held Files loses Browse in the flush in which it is withheld.

import assert from "node:assert/strict";
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
	type Context,
	type Ctx,
	BACKGROUND_CONTEXT as context,
	isChordError,
	type P3Principal,
	type Reference,
	until,
} from "@earendil-works/p3/v1";
import {
	type BinaryReader,
	FileError,
	Http,
	type HttpRequest,
	type HttpResponse,
	ServerRuntime,
} from "@earendil-works/p3/v1/server";
import { type TestedPlugin, testPlugin } from "@earendil-works/p3/v1/testing";
import { collected, eventually, within } from "../../../test/until.ts";
import { MachineHosts } from "../../environments/contract.server.ts";
import { MACHINE_KIND } from "../../environments/contract.ts";
import environmentsServer from "../../environments/server.ts";
import peopleServer from "../../people/server.ts";
import { Gives, OneThing, ThingsStore } from "../../things/contract.server.ts";
import { OPEN, type Party, type Source } from "../../things/contract.ts";
import thingsServer from "../../things/server.ts";
import { DOWNLOAD_PATH, Files, FilesKind, UPLOAD_PATH } from "../contract.ts";
import { StagingStore } from "../staging.ts";

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

/** The route `key` (`GET /files/download`, `PUT /files/upload`) as the HTTP component calls it. */
function route(key: string) {
	const entry = t
		.contributions(Http)
		.flatMap(({ value }) => Object.entries(value.routes ?? {}))
		.find(([name]) => name === key)![1];
	return typeof entry === "function" ? entry : entry.handler;
}

/** A request to `url` (an address a member answered) with `body`'s pieces as its body. */
function request(url: string, method: "GET" | "PUT", body: readonly Uint8Array[] = []): HttpRequest {
	const query = new URL(url, "http://p3").searchParams;
	return {
		method,
		query,
		body: async function* () {
			for (const piece of body) yield piece;
		},
	} as unknown as HttpRequest;
}

/** Downloads what `url` names as `ctx`'s caller: the route's answer and, for bytes, all of them. */
async function download(url: string, ctx: Ctx<P3Principal>): Promise<{ response: HttpResponse; bytes?: Buffer }> {
	const response = await route(`GET ${DOWNLOAD_PATH}`)(request(url, "GET"), ctx);
	if (response.kind !== "bytes") return { response };
	return { response, bytes: Buffer.from(await response.read(0, response.size!, ctx)) };
}

/** Uploads `body` to `path` as the caller of `f`: the route's answer. */
async function upload(f: Reference<typeof Files>, path: string, body: readonly Uint8Array[], ctx: Ctx<P3Principal>) {
	const { url } = await f.upload!({ machine, path }, ctx);
	return route(`PUT ${UPLOAD_PATH}`)(request(url, "PUT", body), ctx);
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
	it("is made in Pi once, and gives everyone there Browse only; people only", async () => {
		const ann = await person("Ann");
		assert.deepEqual(await holding(ann, pi, async (f) => [...f.granted].sort()), ["entries", "open", "search"]);
		assert.equal(
			(await t.host.get(OneThing, { kind: FilesKind.name }, context)).thing.value,
			files,
			"the same thing on a second hold",
		);
		await refused(grant(pi, files, { kind: "agents" }, ["browse"]), "invalid");
		await things.putParty({ workspace: pi, party: { kind: "agent", session: "s1" }, source: BY }, context);
		await refused(
			holding({ kind: "worker", session: "s1" }, pi, async () => null),
			"forbidden",
		);
	});

	it("Browse lists, searches and opens; without Edit nothing changes; with no tick no member", async () => {
		const ann = await person("Ann");
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
			const { url } = await f.open!({ machine, path: join(root, "README.md") }, ctx);
			assert.equal(new URL(url, "http://p3").searchParams.get("path"), join(root, "README.md"));
			assert.equal((await download(url, ctx)).bytes?.toString(), "# hello\n");
			assert.equal(f.upload, undefined);
			assert.equal(f.rename, undefined);
			assert.equal(f.remove, undefined);
		});
		await grant(pi, files, { kind: "person", person: ann.id }, ["browse"], false);
		assert.deepEqual(await holding(ann, pi, async (f) => [...f.granted]), []);
	});

	it("Edit uploads in one request, renames and removes", async () => {
		const ann = await person("Ann");
		await grant(pi, files, { kind: "person", person: ann.id }, ["edit"]);
		const target = join(root, "upload.bin");
		const bytes = Buffer.alloc(300 * 1024, 7);
		await holding(ann, pi, async (f, ctx) => {
			const answer = await upload(f, target, [bytes.subarray(0, 1000), bytes.subarray(1000)], ctx);
			assert.equal(answer.kind, "json");
			assert.deepEqual(await readFile(target), bytes);
			await f.rename!({ machine, from: target, to: join(root, "src", "moved.bin") }, ctx);
			await f.remove!({ machine, path: join(root, "src") }, ctx);
			const names = (await f.entries!({ machine, path: root }, ctx)).entries.map(({ name }) => name);
			assert.deepEqual(names, ["README.md"]);
		});
	});

	it("pages a folder of 10,000 entries: the first page in one call within 50 ms, the next after it", async () => {
		const ann = await person("Ann");
		const big = join(root, "big");
		await mkdir(big);
		await Promise.all(
			Array.from({ length: 10_000 }, (_, i) => writeFile(join(big, `f${String(i).padStart(5, "0")}`), "")),
		);
		await holding(ann, pi, async (f, ctx) => {
			const took: number[] = [];
			let first: Awaited<ReturnType<NonNullable<typeof f.entries>>> | undefined;
			for (let run = 0; run < 3; run++) {
				const started = performance.now();
				first = await f.entries!({ machine, path: big }, ctx);
				took.push(performance.now() - started);
			}
			assert.equal(first!.entries.length, 200);
			assert.equal(first!.entries[0]!.name, "f00000");
			const second = await f.entries!({ machine, path: big, after: first!.next! }, ctx);
			assert.equal(second.entries[0]!.name, "f00200");
			const bytes = Buffer.byteLength(JSON.stringify(first));
			console.log(
				`files: the first page of 10,000 entries in ${took.map((ms) => ms.toFixed(1)).join(", ")} ms; ${bytes} bytes`,
			);
			// The best of three: the budget is the page's work, not the machine's load meanwhile.
			assert.ok(Math.min(...took) < 50, `${Math.min(...took)} ms`);
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

	it("refuses the machine to a person `@open` is withheld from, and Files stays theirs (1172 test 1)", async () => {
		const leo = await person("Leo");
		await grant(pi, machine, { kind: "person", person: leo.id }, [OPEN], false);
		await holding(leo, pi, async (f, ctx) => {
			assert.deepEqual([...f.granted].sort(), ["entries", "open", "search"]);
			await refused(f.entries!({ machine, path: root }, ctx), "forbidden", "notHere");
			await refused(f.open!({ machine, path: join(root, "README.md") }, ctx), "forbidden", "notHere");
		});
	});

	it("refuses relative paths, Pi's data folder, a link into it, and removing what holds it", async () => {
		const ann = await person("Ann");
		await grant(pi, files, { kind: "person", person: ann.id }, ["edit"]);
		const dataDir = (await t.host.registry(ServerRuntime, context)).value.dataDir;
		await symlink(dataDir, join(root, "data"));
		await holding(ann, pi, async (f, ctx) => {
			await refused(f.entries!({ machine, path: "src" }, ctx), "invalid", "notAbsolute");
			await refused(f.entries!({ machine, path: dataDir }, ctx), "invalid", "hidden");
			await refused(f.entries!({ machine, path: join(root, "data") }, ctx), "invalid", "hidden");
			await refused(f.remove!({ machine, path: dirname(dataDir) }, ctx), "invalid", "hidden");
			await refused(f.remove!({ machine, path: "/" }, ctx), "invalid", "root");
			await refused(f.upload!({ machine, path: join(root, "data", "x") }, ctx), "invalid", "hidden");
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

describe("links: removing or moving one acts on the link", () => {
	it("removes a link, not the folder it points to; a dangling link too (opus repro)", async () => {
		const ann = await person("Ann");
		await grant(pi, files, { kind: "person", person: ann.id }, ["edit"]);
		await symlink(join(root, "src"), join(root, "shortcut"));
		await symlink(join(root, "gone"), join(root, "dangling"));
		await holding(ann, pi, async (f, ctx) => {
			await f.remove!({ machine, path: join(root, "shortcut") }, ctx);
			await f.remove!({ machine, path: join(root, "dangling") }, ctx);
		});
		assert.equal(await readFile(join(root, "src", "main.ts"), "utf8"), "console.log(1);\n");
		await assert.rejects(lstat(join(root, "shortcut")), { code: "ENOENT" });
		await assert.rejects(lstat(join(root, "dangling")), { code: "ENOENT" });
	});

	it("moves a link, not what it points to", async () => {
		const ann = await person("Ann");
		await grant(pi, files, { kind: "person", person: ann.id }, ["edit"]);
		await symlink(join(root, "src"), join(root, "shortcut"));
		await holding(ann, pi, (f, ctx) =>
			f.rename!({ machine, from: join(root, "shortcut"), to: join(root, "moved") }, ctx),
		);
		assert.equal((await lstat(join(root, "moved"))).isSymbolicLink(), true);
		assert.equal(await readFile(join(root, "src", "main.ts"), "utf8"), "console.log(1);\n");
	});
});

describe("the routes", () => {
	it("a download follows one opened file across an atomic save (astra repro)", async () => {
		const ann = await person("Ann");
		const file = join(root, "report");
		await writeFile(file, "A1A2");
		await holding(ann, pi, async (f, ctx) => {
			const { url } = await f.open!({ machine, path: file }, ctx);
			const response = await route(`GET ${DOWNLOAD_PATH}`)(request(url, "GET"), ctx);
			assert.equal(response.kind, "bytes");
			const head = await response.read(0, 2, ctx);
			await writeFile(`${file}.new`, "B1B2");
			await rename(`${file}.new`, file);
			const tail = await response.read(2, 2, ctx);
			assert.equal(Buffer.concat([head, tail]).toString(), "A1A2");
		});
	});

	it("a download refuses the next piece once Browse is withheld, and a stranger at once", async () => {
		const ann = await person("Ann");
		const file = join(root, "report");
		await writeFile(file, "A1A2");
		await holding(ann, pi, async (f, ctx) => {
			const { url } = await f.open!({ machine, path: file }, ctx);
			const response = await route(`GET ${DOWNLOAD_PATH}`)(request(url, "GET"), ctx);
			assert.equal(response.kind, "bytes");
			await response.read(0, 2, ctx);
			await grant(pi, files, { kind: "person", person: ann.id }, ["browse"], false);
			await until(f.state, () => f.open === undefined, within("Browse withheld", ctx));
			await assert.rejects(response.read(2, 2, ctx));
		});
		const stranger = await person(
			"Sam",
			await things.createWorkspace({ kind: "things.workspace", name: "Elsewhere", parent: pi, by: BY }, context),
		);
		const url = `${DOWNLOAD_PATH}?${new URLSearchParams({ workspace: pi, thing: files, machine, path: file })}`;
		const answer = await t.root((ctx) => route(`GET ${DOWNLOAD_PATH}`)(request(url, "GET"), ctx), context, {
			principal: stranger,
		});
		assert.deepEqual(answer, { kind: "error", status: 403 });
	});

	it("two uploads of one name never publish a mixture (astra repro)", async () => {
		const ann = await person("Ann");
		await grant(pi, files, { kind: "person", person: ann.id }, ["edit"]);
		const path = join(root, "report");
		await holding(ann, pi, async (f, ctx) => {
			const pieces = (a: string, b: string) => [Buffer.from(a), Buffer.from(b)];
			await Promise.all([upload(f, path, pieces("A1", "A2"), ctx), upload(f, path, pieces("B1", "B2"), ctx)]);
		});
		assert.ok(["A1A2", "B1B2"].includes(await readFile(path, "utf8")));
		assert.deepEqual((await readdir(root)).sort(), ["README.md", "report", "src"]);
	});

	it("an upload never changes another file: a sibling named like its partial, a link at the target (astra repro)", async () => {
		const ann = await person("Ann");
		await grant(pi, files, { kind: "person", person: ann.id }, ["edit"]);
		await writeFile(join(root, "draft.p3-upload"), "keep my file");
		await symlink(join(root, "README.md"), join(root, "linked"));
		await holding(ann, pi, async (f, ctx) => {
			await upload(f, join(root, "draft"), [Buffer.from("a")], ctx);
			await upload(f, join(root, "linked"), [Buffer.from("new")], ctx);
		});
		assert.equal(await readFile(join(root, "draft.p3-upload"), "utf8"), "keep my file");
		assert.equal(await readFile(join(root, "README.md"), "utf8"), "# hello\n");
		assert.equal(await readFile(join(root, "linked"), "utf8"), "new");
	});

	it("an upload that fails or loses Edit midway leaves nothing behind (astra repro)", async () => {
		const ann = await person("Ann");
		await grant(pi, files, { kind: "person", person: ann.id }, ["edit"]);
		await holding(ann, pi, async (f, ctx) => {
			const { url } = await f.upload!({ machine, path: join(root, "draft") }, ctx);
			const broken = {
				...request(url, "PUT"),
				body: async function* () {
					yield Buffer.from("a");
					throw new Error("the browser went away");
				},
			} as unknown as HttpRequest;
			await assert.rejects(route(`PUT ${UPLOAD_PATH}`)(broken, ctx), /went away/);
			const revoking = {
				...request(url, "PUT"),
				body: async function* () {
					yield Buffer.from("a");
					await grant(pi, files, { kind: "person", person: ann.id }, ["edit"], false);
					await until(f.state, () => f.upload === undefined, within("Edit withheld", ctx));
					yield Buffer.from("b");
				},
			} as unknown as HttpRequest;
			assert.deepEqual(await route(`PUT ${UPLOAD_PATH}`)(revoking, ctx), { kind: "error", status: 403 });
		});
		assert.deepEqual((await readdir(root)).sort(), ["README.md", "src"]);
	});
});

describe("a held Files", () => {
	it("keeps no answers of its caller once its hold is released (guide 8.7)", async () => {
		const ann = await person("Ann");
		const answers = await holding(ann, pi, async (f, ctx) => {
			await f.entries!({ machine, path: root }, ctx);
			const gives = await t.host.get(Gives, { workspace: pi, caller: `person:${ann.id}` }, context);
			const held = new WeakRef(gives.answers.value);
			gives.release();
			return held;
		});
		assert.ok(await collected([answers]));
	});

	it("loses Browse in the flush in which it is withheld: the next call fails", async () => {
		const ann = await person("Ann");
		await holding(ann, pi, async (f, ctx) => {
			const entries = f.entries!;
			await entries({ machine, path: root }, ctx);
			await grant(pi, files, { kind: "person", person: ann.id }, ["browse"], false);
			await until(
				f.state,
				(state) => state.kind === "live" && f.entries === undefined,
				within("Browse withheld", ctx),
			);
			await refused(entries({ machine, path: root }, ctx), "forbidden");
		});
	});
});

describe("a transfer's lifetime (round 2)", () => {
	/** The host of the test's machine, as the routes reach it (one connection, kept). */
	const hostOf = async () => (await (await t.host.registry(MachineHosts, context)).value(machine, context))!;

	/** Wraps the machine's `openBinaryReader` while `fn` runs: `wrap` gets each reader opened; the closes counted. */
	async function readers(
		wrap: (reader: BinaryReader) => BinaryReader,
		fn: (closes: () => number) => Promise<void>,
	): Promise<void> {
		const at = await hostOf();
		const original = at.env.openBinaryReader.bind(at.env);
		let closes = 0;
		at.env.openBinaryReader = async (...args) => {
			const opened = await original(...args);
			if (!opened.ok) return opened;
			const reader = wrap(opened.value);
			const close = reader.close.bind(reader);
			return {
				ok: true,
				value: Object.assign(Object.create(reader) as BinaryReader, {
					close: (ctx: Context) => {
						closes++;
						return close(ctx);
					},
				}),
			};
		};
		try {
			await fn(() => closes);
		} finally {
			at.env.openBinaryReader = original;
		}
	}

	it("closes the reader once when reading its size fails (astra round 2, must 3)", async () => {
		const ann = await person("Ann");
		const failing = (reader: BinaryReader) =>
			Object.assign(Object.create(reader) as BinaryReader, {
				info: async () => ({ ok: false as const, error: new FileError("unknown", "metadata I/O") }),
			});
		await readers(failing, async (closes) => {
			await holding(ann, pi, async (f, ctx) => {
				const { url } = await f.open!({ machine, path: join(root, "README.md") }, ctx);
				assert.equal((await route(`GET ${DOWNLOAD_PATH}`)(request(url, "GET"), ctx)).kind, "error");
				assert.equal(closes(), 1);
			});
			assert.equal(closes(), 1, "once, also when the request ends");
		});
	});

	it("closes a paused download's reader when Browse is withheld, without another read (astra round 2, must 2)", async () => {
		const ann = await person("Ann");
		await readers(
			(reader) => reader,
			async (closes) => {
				await holding(ann, pi, async (f, ctx) => {
					const { url } = await f.open!({ machine, path: join(root, "README.md") }, ctx);
					assert.equal((await route(`GET ${DOWNLOAD_PATH}`)(request(url, "GET"), ctx)).kind, "bytes");
					await grant(pi, files, { kind: "person", person: ann.id }, ["browse"], false);
					await until(f.state, () => f.open === undefined, within("Browse withheld", ctx));
					await eventually(
						async () => closes(),
						(n) => n === 1,
					);
				});
			},
		);
	});

	it("closes a paused download's reader when the machine is withheld from the person (must 2)", async () => {
		const ann = await person("Ann");
		await readers(
			(reader) => reader,
			async (closes) => {
				await holding(ann, pi, async (f, ctx) => {
					const { url } = await f.open!({ machine, path: join(root, "README.md") }, ctx);
					const response = await route(`GET ${DOWNLOAD_PATH}`)(request(url, "GET"), ctx);
					assert.equal(response.kind, "bytes");
					await grant(pi, machine, { kind: "person", person: ann.id }, [OPEN], false);
					await eventually(
						async () => closes(),
						(n) => n === 1,
					);
					if (response.kind === "bytes") await assert.rejects(response.read(0, 2, ctx));
				});
			},
		);
	});

	it("removes a stalled upload's staged file when Edit is withheld, without another piece (astra round 2, must 2)", async () => {
		const ann = await person("Ann");
		await grant(pi, files, { kind: "person", person: ann.id }, ["edit"]);
		await holding(ann, pi, async (f, ctx) => {
			const { url } = await f.upload!({ machine, path: join(root, "inert") }, ctx);
			const entered = Promise.withResolvers<void>();
			const finish = Promise.withResolvers<void>();
			const stalled = {
				...request(url, "PUT"),
				body: async function* () {
					yield Buffer.from("before the pause");
					entered.resolve();
					await finish.promise;
				},
			} as unknown as HttpRequest;
			const submitting = route(`PUT ${UPLOAD_PATH}`)(stalled, ctx);
			try {
				await entered.promise;
				assert.equal((await readdir(root)).length, 3, "the staged file is there");
				await grant(pi, files, { kind: "person", person: ann.id }, ["edit"], false);
				await eventually(
					async () => (await readdir(root)).sort(),
					(names) => names.join() === "README.md,src",
				);
				assert.deepEqual(await submitting, { kind: "error", status: 403 }, "answered before the body ends");
			} finally {
				finish.resolve();
			}
		});
	});

	it("refuses an upload once the machine is withheld from the person, and lands nothing (must 2)", async () => {
		const ann = await person("Ann");
		await grant(pi, files, { kind: "person", person: ann.id }, ["edit"]);
		await holding(ann, pi, async (f, ctx) => {
			const { url } = await f.upload!({ machine, path: join(root, "draft") }, ctx);
			const revoking = {
				...request(url, "PUT"),
				body: async function* () {
					yield Buffer.from("a");
					await grant(pi, machine, { kind: "person", person: ann.id }, [OPEN], false);
					yield Buffer.from("b");
				},
			} as unknown as HttpRequest;
			assert.deepEqual(await route(`PUT ${UPLOAD_PATH}`)(revoking, ctx), { kind: "error", status: 403 });
		});
		assert.deepEqual((await readdir(root)).sort(), ["README.md", "src"]);
	});

	it("uploads to a long valid name: the staged file's name is its own (astra round 2)", async () => {
		const ann = await person("Ann");
		await grant(pi, files, { kind: "person", person: ann.id }, ["edit"]);
		const path = join(root, "x".repeat(220));
		await writeFile(path, "old");
		await holding(ann, pi, async (f, ctx) => {
			assert.equal((await upload(f, path, [Buffer.from("new")], ctx)).kind, "json");
		});
		assert.equal(await readFile(path, "utf8"), "new");
	});

	it("stages at 0600, keeps a replaced file's bits without setuid, and gives a new file the default (must 4)", async () => {
		const ann = await person("Ann");
		await grant(pi, files, { kind: "person", person: ann.id }, ["edit"]);
		const script = join(root, "build");
		await writeFile(script, "old");
		await chmod(script, 0o4750);
		const fresh = join(root, "fresh");
		await holding(ann, pi, async (f, ctx) => {
			const { url } = await f.upload!({ machine, path: script }, ctx);
			const staged: number[] = [];
			const watching = {
				...request(url, "PUT"),
				body: async function* () {
					yield Buffer.from("new");
					for (const name of await readdir(root)) {
						if (name.startsWith(".p3-upload-")) staged.push((await lstat(join(root, name))).mode & 0o7777);
					}
				},
			} as unknown as HttpRequest;
			assert.equal((await route(`PUT ${UPLOAD_PATH}`)(watching, ctx)).kind, "json");
			assert.deepEqual(staged, [0o600]);
			assert.equal((await upload(f, fresh, [Buffer.from("x")], ctx)).kind, "json");
		});
		assert.equal((await lstat(script)).mode & 0o7777, 0o750);
		assert.equal((await lstat(fresh)).mode & 0o7777, 0o666 & ~process.umask());
	});

	it("removes an interrupted upload's staged file after its folder was renamed (astra round 2)", async () => {
		const ann = await person("Ann");
		await grant(pi, files, { kind: "person", person: ann.id }, ["edit"]);
		const folder = join(root, "notes");
		const moved = join(root, "renamed");
		await mkdir(folder);
		await holding(ann, pi, async (f, ctx) => {
			const { url } = await f.upload!({ machine, path: join(folder, "draft") }, ctx);
			const interrupted = {
				...request(url, "PUT"),
				body: async function* () {
					yield Buffer.from("new");
					await f.rename!({ machine, from: folder, to: moved }, ctx);
					throw new Error("end of connection");
				},
			} as unknown as HttpRequest;
			await assert.rejects(route(`PUT ${UPLOAD_PATH}`)(interrupted, ctx), /end of connection/);
		});
		assert.deepEqual(await readdir(moved), []);
	});

	it("removes the staged files an earlier server process left, at the next upload to the machine (should 8)", async () => {
		const ann = await person("Ann");
		await grant(pi, files, { kind: "person", person: ann.id }, ["edit"]);
		const left = join(root, ".p3-upload-0123456789ab");
		await writeFile(left, "a crash's partial");
		const staging = await t.host.get(StagingStore, {}, context);
		// Made before this process started: a crash's.
		const id = await staging.remember({ machine, path: left, at: 1 }, context);
		const before = Math.floor(performance.timeOrigin);
		assert.deepEqual(await staging.stale({ machine, before }, context), [{ id, path: left }]);
		await holding(ann, pi, async (f, ctx) => {
			assert.equal((await upload(f, join(root, "new"), [Buffer.from("x")], ctx)).kind, "json");
		});
		await assert.rejects(lstat(left), { code: "ENOENT" });
		assert.deepEqual(await staging.stale({ machine, before }, context), []);
	});

	it("takes raw bytes, bounded by the upload's limit (astra round 2)", async () => {
		const ann = await person("Ann");
		await grant(pi, files, { kind: "person", person: ann.id }, ["edit"]);
		const path = join(root, "raw");
		const raw = Uint8Array.of(0xff, 0, 63, 128, 10);
		await holding(ann, pi, async (f, ctx) => {
			const { url } = await f.upload!({ machine, path }, ctx);
			const bounded = {
				...request(url, "PUT"),
				body: async function* (limit?: number) {
					assert.equal(limit, 2 * 1024 ** 3);
					yield raw;
				},
			} as unknown as HttpRequest;
			assert.equal((await route(`PUT ${UPLOAD_PATH}`)(bounded, ctx)).kind, "json");
		});
		assert.deepEqual(await readFile(path), Buffer.from(raw));
	});
});

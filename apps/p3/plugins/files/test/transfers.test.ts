// Files' routes, end to end (p3's real server, browsers' cookies): a person put into Pi downloads a file at the address
// `open` answers and uploads one at the address `upload` answers (with Edit); no cookie, or a signed-in stranger's, is
// refused; a running download ends at the first piece after Browse is withheld from the person, or after the person is
// removed from the workspace (decision 25: the stream holds the person's own reference). A new session's default
// folder is outside the data folder, so Files lists it.

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { type Ctx, BACKGROUND_CONTEXT as context, type P3Principal, type Reference } from "@earendil-works/p3/v1";
import { PeopleStore, SessionsStore } from "@earendil-works/p3/v1/server";
import { type TestServer, testServer } from "@earendil-works/p3/v1/testing";
import { newSession } from "../../../test/support.ts";
import { eventually } from "../../../test/until.ts";
import { MachineHosts } from "../../environments/contract.server.ts";
import { MACHINE_KIND } from "../../environments/contract.ts";
import { seeded } from "../../environments/test/seeded.ts";
import { SignIns } from "../../sign-in/contract.ts";
import { OneThing, ThingsStore } from "../../things/contract.server.ts";
import type { Source } from "../../things/contract.ts";
import { DOWNLOAD_PATH, Files, FilesKind } from "../kind.ts";

/** A person's principal. */
type Person = Extract<P3Principal, { kind: "person" }>;

/** Who sets things up in the tests. */
const BY: Source = { kind: "plugin", plugin: "test" };

let t: TestServer;
let root: string;
let pi: string;
let files: string;
let machine: string;

before(async () => {
	t = await testServer({}, context);
	root = await mkdtemp(join(tmpdir(), "p3-transfers-test-"));
	await t.host.root(async (ctx) => {
		const things = await ctx.get(ThingsStore, {});
		pi = (await things.workspaces.children.page({ parent: "" }, 1, ctx)).items[0]!.workspace;
		// The owner, in Pi: the session below is theirs.
		const [owner] = (await (await ctx.get(PeopleStore, {})).persons.owner.page({}, 1, ctx)).items;
		await things.putParty({ workspace: pi, party: { kind: "person", person: owner!.id }, source: BY }, ctx);
		files = await seeded(await ctx.get(OneThing, { kind: FilesKind.name }), ctx);
		machine = await seeded(await ctx.get(OneThing, { kind: MACHINE_KIND }), ctx);
	}, context);
});

after(async () => {
	await t.close(context);
	await rm(root, { recursive: true, force: true });
});

/** Makes person `name` (put into Pi unless `inPi` is false) with a browser's sign-in: the person and their cookie. */
async function signedIn(name: string, inPi = true): Promise<{ person: Person; cookie: string }> {
	return t.host.root(async (ctx) => {
		const things = await ctx.get(ThingsStore, {});
		const id = await things.createPerson({ name, madeBy: BY }, ctx);
		if (inPi) await things.putParty({ workspace: pi, party: { kind: "person", person: id }, source: BY }, ctx);
		const person: Person = { kind: "person", id, name };
		const issued = await (await ctx.get(SignIns, {})).issue(
			{ principal: person, label: "test", kind: "browser" },
			ctx,
		);
		return { person, cookie: issued.cookie.split(";")[0]! };
	}, context);
}

/** Runs `change` on the things store as the server. */
function asServer(change: (things: Reference<typeof ThingsStore>, ctx: Ctx<P3Principal>) => Promise<unknown>) {
	return t.host.root(async (ctx) => change(await ctx.get(ThingsStore, {}), ctx), context);
}

/** The address of `path` on this device for the download route (what `open` answers). */
function downloadAddress(path: string): string {
	return `http://127.0.0.1:${t.port}${DOWNLOAD_PATH}?${new URLSearchParams({ workspace: pi, thing: files, machine, path })}`;
}

describe("the download route", () => {
	it("gives a person in Pi a file's bytes under its name; nobody without a sign-in, no stranger", async () => {
		const path = join(root, "notes.txt");
		await writeFile(path, "some notes\n");
		const ann = await signedIn("Ann");
		const answer = await fetch(downloadAddress(path), { headers: { cookie: ann.cookie } });
		assert.equal(answer.status, 200);
		assert.equal(await answer.text(), "some notes\n");
		assert.match(answer.headers.get("content-disposition") ?? "", /notes\.txt/);
		assert.equal((await fetch(downloadAddress(path))).status, 401);
		const sam = await signedIn("Sam", false);
		assert.equal((await fetch(downloadAddress(path), { headers: { cookie: sam.cookie } })).status, 403);
	});

	for (const [what, revoke] of [
		[
			"Browse is withheld",
			(person: Person) =>
				asServer((things, ctx) =>
					things.setGrants(
						{
							source: BY,
							grants: [
								{
									workspace: pi,
									thing: files,
									party: { kind: "person", person: person.id },
									tick: "browse",
									gives: false,
								},
							],
						},
						ctx,
					),
				),
		],
		[
			"the person is removed from the workspace (1173 test 3)",
			(person: Person) =>
				asServer((things, ctx) =>
					things.removeParty({ workspace: pi, party: { kind: "person", person: person.id } }, ctx),
				),
		],
	] as const) {
		it(`ends at the first piece after ${what}`, async () => {
			const path = join(root, "big.bin");
			const size = 32 * 1024 * 1024;
			await writeFile(path, Buffer.alloc(size, 1));
			const ann = await signedIn("Ann");
			const answer = await fetch(downloadAddress(path), { headers: { cookie: ann.cookie } });
			assert.equal(answer.status, 200);
			const reader = answer.body!.getReader();
			const received = { bytes: (await reader.read()).value?.length ?? 0 };
			await revoke(ann.person);
			await assert.rejects(async () => {
				for (let next = await reader.read(); !next.done; next = await reader.read())
					received.bytes += next.value.length;
			});
			assert.ok(received.bytes < size, `${received.bytes} of ${size} bytes`);
		});
	}
});

describe("the upload route", () => {
	it("puts a person's body in place with Edit, and refuses it without", async () => {
		const ann = await signedIn("Ann");
		const path = join(root, "sent.txt");
		const address = async () =>
			t.host.root(
				async (ctx) => {
					const held = await ctx.get(Files, { workspace: pi, thing: files });
					return `http://127.0.0.1:${t.port}${(await held.upload!({ machine, path }, ctx)).url}`;
				},
				context,
				{ principal: ann.person },
			);
		await assert.rejects(address());
		await asServer((things, ctx) =>
			things.setGrants(
				{
					source: BY,
					grants: [
						{
							workspace: pi,
							thing: files,
							party: { kind: "person", person: ann.person.id },
							tick: "edit",
							gives: true,
						},
					],
				},
				ctx,
			),
		);
		const url = await address();
		const sent = await fetch(url, { method: "PUT", headers: { cookie: ann.cookie }, body: "hello there" });
		assert.equal(sent.status, 200);
		assert.equal(await readFile(path, "utf8"), "hello there");
		const bob = await signedIn("Bob");
		assert.equal((await fetch(url, { method: "PUT", headers: { cookie: bob.cookie }, body: "x" })).status, 403);
		assert.equal(await readFile(path, "utf8"), "hello there");
	});
});

describe("a new session's folder", () => {
	it("is outside the data folder, so Files lists it (astra repro)", async () => {
		const client = await t.client(context);
		const id = await newSession(client, "new", context);
		const rows = await t.host.root(
			async (ctx) => (await ctx.get(SessionsStore, {})).sessions.one.page({ id }, 1, ctx),
			context,
		);
		const where = rows.items[0]!.location;
		const browser = await client.get(Files, { workspace: pi, thing: files }, context);
		const page = await browser.entries!({ machine: where.machine, path: where.folder }, context);
		assert.deepEqual(page.entries, []);
	});
});

describe("ranges (astra round 2, should 10)", () => {
	it("answers a resumed download's range from the one reader, and 416 for a range past the end", async () => {
		const path = join(root, "range");
		await writeFile(path, "onetwo");
		const ann = await signedIn("Ann");
		const part = await fetch(downloadAddress(path), { headers: { cookie: ann.cookie, Range: "bytes=3-5" } });
		assert.deepEqual([part.status, await part.text()], [206, "two"]);
		const past = await fetch(downloadAddress(path), { headers: { cookie: ann.cookie, Range: "bytes=10-" } });
		assert.equal(past.status, 416);
		await past.arrayBuffer();
		const head = await fetch(downloadAddress(path), { method: "HEAD", headers: { cookie: ann.cookie } });
		assert.deepEqual([head.status, head.headers.get("content-length")], [200, "6"]);
	});
});

describe("one reader per response (astra round 3)", () => {
	it("opens and closes one reader for HEAD, a range, a 416 and an empty file", async () => {
		const ann = await signedIn("Ann");
		const at = (await (await t.host.registry(MachineHosts, context)).value(machine, context))!;
		const original = at.env.openBinaryReader.bind(at.env);
		let opens = 0;
		let closes = 0;
		at.env.openBinaryReader = async (...args) => {
			const opened = await original(...args);
			if (!opened.ok) return opened;
			opens++;
			const close = opened.value.close.bind(opened.value);
			opened.value.close = async (ctx) => {
				closes++;
				return close(ctx);
			};
			return opened;
		};
		try {
			const path = join(root, "ranges-release");
			await writeFile(path, "abcdef");
			const probe = async (method: string, range: string | undefined, status: number, text: string) => {
				const headers = { cookie: ann.cookie, ...(range === undefined ? {} : { Range: range }) };
				const reply = await fetch(downloadAddress(path), { method, headers });
				assert.deepEqual([reply.status, await reply.text()], [status, text]);
				await eventually(
					() => closes,
					(count) => count === opens,
				);
			};
			await probe("HEAD", undefined, 200, "");
			await probe("GET", "bytes=1-2", 206, "bc");
			await probe("GET", "bytes=12-", 416, "");
			await writeFile(path, "");
			await probe("GET", undefined, 200, "");
			assert.deepEqual([opens, closes], [4, 4]);
		} finally {
			at.env.openBinaryReader = original;
		}
	});
});

describe("the test server's own folders (astra round 2, must 5)", () => {
	it("removes nothing beside the data directory it was given", async () => {
		const dataDir = join(root, "example");
		const sibling = `${dataDir}-work`;
		await mkdir(sibling);
		await writeFile(join(sibling, "sentinel"), "unrelated");
		const nested = await testServer({ dataDir }, context);
		await nested.close(context);
		assert.equal(await readFile(join(sibling, "sentinel"), "utf8"), "unrelated");
	});
});

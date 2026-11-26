// The download route, end to end (p3's real server, a browser's cookie): the owner, put into Pi, downloads a file at
// the address `download` answers; a stranger's cookie or none is refused; a running download ends at the first piece
// after Read is withheld (decision 25: the stream holds the person's own reference).

import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { BACKGROUND_CONTEXT as context, type P3Principal } from "@earendil-works/p3/v1";
import { PeopleStore } from "@earendil-works/p3/v1/server";
import { type TestServer, testServer } from "@earendil-works/p3/v1/testing";
import { MACHINE_KIND } from "../../environments/contract.ts";
import { OneThing, ThingsStore } from "../../things/contract.server.ts";
import { Files, FilesKind } from "../contract.ts";

let t: TestServer;
let root: string;
let owner: P3Principal & { kind: "person" };
let pi: string;
let files: string;
let machine: string;

before(async () => {
	t = await testServer({}, context);
	root = await mkdtemp(join(tmpdir(), "p3-download-test-"));
	await t.host.root(async (ctx) => {
		const [found] = (await (await ctx.get(PeopleStore, {})).persons.owner.page({}, 1, ctx)).items;
		owner = { kind: "person", id: found!.id, name: found!.name };
		const things = await ctx.get(ThingsStore, {});
		pi = (await things.workspaces.children.page({ parent: "" }, 1, ctx)).items[0]!.workspace;
		files = (await ctx.get(OneThing, { kind: FilesKind.name })).thing.value;
		machine = (await ctx.get(OneThing, { kind: MACHINE_KIND })).thing.value;
		const by = { kind: "plugin", plugin: "test" } as const;
		await things.putParty({ workspace: pi, party: { kind: "person", person: owner.id }, source: by }, ctx);
	}, context);
});

after(async () => {
	await t.close(context);
	await rm(root, { recursive: true, force: true });
});

/** The address `download` answers the owner for `path`. */
async function addressOf(path: string): Promise<string> {
	const client = await t.client(context);
	const held = await client.get(Files, { workspace: pi, thing: files }, context);
	return `http://127.0.0.1:${t.port}${await held.download!({ machine, path }, context)}`;
}

describe("the download route", () => {
	it("gives the owner a file's bytes under its name, and nobody without a sign-in", async () => {
		const path = join(root, "notes.txt");
		await writeFile(path, "some notes\n");
		const address = await addressOf(path);
		const cookie = await t.cookie(context);
		const answer = await fetch(address, { headers: { cookie } });
		assert.equal(answer.status, 200);
		assert.equal(await answer.text(), "some notes\n");
		assert.match(answer.headers.get("content-disposition") ?? "", /notes\.txt/);
		assert.equal((await fetch(address)).status, 401);
	});

	it("ends at the first piece after Read is withheld", async () => {
		const path = join(root, "big.bin");
		const size = 32 * 1024 * 1024;
		await writeFile(path, Buffer.alloc(size, 1));
		const answer = await fetch(await addressOf(path), { headers: { cookie: await t.cookie(context) } });
		assert.equal(answer.status, 200);
		const reader = answer.body!.getReader();
		let received = (await reader.read()).value?.length ?? 0;
		await t.host.root(async (ctx) => {
			const party = { kind: "person", person: owner.id } as const;
			const grant = { workspace: pi, thing: files, party, tick: "read", gives: false };
			await (await ctx.get(ThingsStore, {})).setGrants(
				{ source: { kind: "plugin", plugin: "test" }, grants: [grant] },
				ctx,
			);
		}, context);
		await assert.rejects(async () => {
			for (;;) {
				const { done, value } = await reader.read();
				if (done) break;
				received += value.length;
			}
		});
		assert.ok(received < size, `${received} of ${size} bytes`);
	});
});

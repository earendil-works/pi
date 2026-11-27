// Files' routes ask for a machine's host (which may connect to it) only for a caller let in (astra round 3, must 4):
// the person's Files member and their answer on the machine are checked first, over a stand-in machine type that
// counts its connections.

import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT as context, type P3Principal } from "@earendil-works/p3/v1";
import { Http, type HttpRequest, NodeExecutionEnv } from "@earendil-works/p3/v1/server";
import { type TestedPlugin, testPlugin } from "@earendil-works/p3/v1/testing";
import { MACHINE_KIND } from "../../environments/contract.ts";
import environmentsServer from "../../environments/server.ts";
import { fakeMachine, fakeType } from "../../environments/test/fake-machine.ts";
import { seeded } from "../../environments/test/seeded.ts";
import { OneThing, ThingsStore } from "../../things/contract.server.ts";
import { OPEN } from "../../things/contract.ts";
import thingsServer from "../../things/server.ts";
import { DOWNLOAD_PATH, FilesKind } from "../kind.ts";

/** How often the stand-in machine was connected to. */
let connections = 0;

/** A stand-in for this device's type (its plugin name sorts first): Node's files, its connections counted. */
const counting = fakeType(() => {
	connections++;
	return fakeMachine({ env: new NodeExecutionEnv({ cwd: "/" }) }).host;
});

describe("Files' routes and the machine's host", () => {
	let t: TestedPlugin<P3Principal>;
	let root: string;
	let address: string;
	let person: (name: string, withheld: string[]) => Promise<P3Principal>;

	before(async () => {
		root = await mkdtemp(join(tmpdir(), "p3-files-connect-"));
		await writeFile(join(root, "file"), "bytes");
		const stubs = [
			{ name: "@earendil-works/p3-a-counting-machine", facet: counting },
			{ name: "@earendil-works/p3-things", facet: thingsServer },
			{ name: "@earendil-works/p3-environments", facet: environmentsServer },
		];
		t = await testPlugin(fileURLToPath(new URL("../", import.meta.url)), { kind: "server", stubs }, context);
		const things = await t.host.get(ThingsStore, {}, context);
		const pi = (await things.workspaces.children.page({ parent: "" }, 1, context)).items[0]!.workspace;
		const files = await seeded(await t.host.get(OneThing, { kind: FilesKind.name }, context), context);
		const machine = await seeded(await t.host.get(OneThing, { kind: MACHINE_KIND }, context), context);
		const by = { kind: "plugin", plugin: "test" } as const;
		// Who may lets everyone in Pi browse, as the owner would: the kind gives nobody anything.
		const everyone = {
			workspace: pi,
			thing: files,
			party: { kind: "everyone" },
			tick: "browse",
			gives: true,
		} as const;
		await things.setGrants({ source: by, grants: [everyone] }, context);
		address = `${DOWNLOAD_PATH}?${new URLSearchParams({ workspace: pi, thing: files, machine, path: join(root, "file") })}`;
		person = async (name, withheld) => {
			const id = await things.createPerson({ name, madeBy: by }, context);
			await things.putParty({ workspace: pi, party: { kind: "person", person: id }, source: by }, context);
			const party = { kind: "person", person: id } as const;
			const grants = withheld.map((tick) => ({
				workspace: pi,
				thing: tick === OPEN ? machine : files,
				party,
				tick,
				gives: false,
			}));
			if (grants.length > 0) await things.setGrants({ source: by, grants }, context);
			return { kind: "person", id, name };
		};
	});

	after(async () => {
		await t.close(context);
		await rm(root, { recursive: true, force: true });
	});

	/** The download route's answer to `principal`. */
	const download = (principal: P3Principal) => {
		const entry = t
			.contributions(Http)
			.flatMap(({ value }) => Object.entries(value.routes ?? {}))
			.find(([name]) => name === `GET ${DOWNLOAD_PATH}`)![1];
		const handler = typeof entry === "function" ? entry : entry.handler;
		const request = { method: "GET", query: new URL(address, "http://p3").searchParams } as unknown as HttpRequest;
		return t.root((ctx) => handler(request, ctx), context, { principal });
	};

	it("connects for nobody without Browse or without the machine, then for a person let in", async () => {
		assert.deepEqual(await download(await person("Kim", ["browse"])), { kind: "error", status: 403 });
		assert.deepEqual(await download(await person("Leo", [OPEN])), { kind: "error", status: 403 });
		assert.equal(connections, 0);
		assert.equal((await download(await person("Ann", []))).kind, "bytes");
		assert.equal(connections, 1);
	});
});

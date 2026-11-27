// Terminals end to end on this device (`testServer`: p3's real server, this device's machine type with its real
// shell in pi-env's daemon, browsers' cookies, the attach socket over a real WebSocket): the owner opens a terminal,
// attaches to it with their browser's cookie, types into it, reads its output on the socket and with `backlog` (as the
// agent's read does), resizes it (the shell sees the size), and ends it (the socket closes 1000, the list is empty). No
// cookie, a page of another site, and a signed-in person without Watch or Use are refused.

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { type Ctx, BACKGROUND_CONTEXT as context, type P3Principal, until } from "@earendil-works/p3/v1";
import { type TestServer, testServer } from "@earendil-works/p3/v1/testing";
import { WebSocket } from "ws";
import { piOf } from "../../../test/support.ts";
import { within } from "../../../test/until.ts";
import { MACHINE_KIND } from "../../environments/contract.ts";
import { seeded } from "../../environments/test/seeded.ts";
import { SignIns } from "../../sign-in/contract.ts";
import { OneThing, ThingsStore } from "../../things/contract.server.ts";
import { SOCKET_REFUSED, Terminals, TerminalsKind } from "../kind.ts";

let t: TestServer;
let folder: string;

before(async () => {
	t = await testServer({}, context);
	folder = await mkdtemp(join(tmpdir(), "p3-terminals-e2e-"));
});

after(async () => {
	await t.close(context);
	await rm(folder, { recursive: true, force: true });
});

/** A browser's attach socket at `url` (what `attach` answered) with `headers`; its frames and its close. */
function attachSocket(url: string, headers: Record<string, string>) {
	const socket = new WebSocket(`ws://127.0.0.1:${t.port}${url}`, { headers });
	const told: unknown[] = [];
	let output = "";
	let seen: () => void = () => {};
	socket.on("message", (data, binary) => {
		// ws's default binary type: a Buffer per message.
		const text = (data as Buffer).toString();
		if (binary) output += text;
		else told.push(JSON.parse(text));
		seen();
	});
	const closed = new Promise<number>((resolve, reject) => {
		socket.on("close", (code) => resolve(code));
		socket.on("unexpected-response", (_request, response) => resolve(response.statusCode ?? 0));
		socket.on("error", (error) => reject(error));
	});
	/** Waits until the output so far matches `pattern`; the output then. */
	const printed = async (pattern: RegExp): Promise<string> => {
		const deadline = Date.now() + 10_000;
		while (!pattern.test(output)) {
			if (Date.now() > deadline) throw new Error(`no ${pattern} in ${JSON.stringify(output)}`);
			// The next frame, or a look at the deadline.
			await new Promise<void>((resolve) => {
				seen = resolve;
				setTimeout(resolve, 1_000);
			});
		}
		return output;
	};
	const opened = new Promise<void>((resolve) => socket.once("open", () => resolve()));
	return { socket, told, printed, closed, opened };
}

/** The origin a page of this server has. */
const origin = () => `http://127.0.0.1:${t.port}`;

/** A person, put into Pi with no tick on Terminals, and their browser's cookie. */
async function stranger(): Promise<string> {
	return t.host.root(async (ctx: Ctx<P3Principal>) => {
		const things = await ctx.get(ThingsStore, {});
		const by = { kind: "plugin", plugin: "test" } as const;
		const pi = (await things.workspaces.children.page({ parent: "" }, 1, ctx)).items[0]!.workspace;
		const id = await things.createPerson({ name: "Sam", madeBy: by }, ctx);
		await things.putParty({ workspace: pi, party: { kind: "person", person: id }, source: by }, ctx);
		const principal = { kind: "person", id, name: "Sam" } as const;
		const issued = await (await ctx.get(SignIns, {})).issue({ principal, label: "test", kind: "browser" }, ctx);
		return issued.cookie.split(";")[0]!;
	}, context);
}

describe("a terminal on this device", () => {
	it("runs the shell: typed into, read on the socket and as the agent reads, resized, ended", async () => {
		const owner = await t.client(context);
		const pi = await piOf(owner, context);
		const [thing, machine] = await t.host.root(
			async (ctx) => [
				await seeded(await ctx.get(OneThing, { kind: TerminalsKind.name }), ctx),
				await seeded(await ctx.get(OneThing, { kind: MACHINE_KIND }), ctx),
			],
			context,
		);
		const terminals = await owner.get(Terminals, { workspace: pi, thing }, context);
		const id = await terminals.open!({ machine, folder, columns: 80, rows: 24 }, context);
		const { url } = await terminals.attach!({ terminal: id }, context);
		const browser = attachSocket(url, { cookie: await t.cookie(context), origin: origin() });
		await browser.opened;
		browser.socket.send(Buffer.from("echo typed-$((6*7)) && pwd\r"));
		assert.match(await browser.printed(/typed-42/), new RegExp(folder));
		assert.deepEqual(browser.told.slice(0, 2), [
			{ kind: "kept", bytes: 0 },
			{ kind: "size", columns: 80, rows: 24 },
		]);
		browser.socket.send(JSON.stringify({ kind: "resize", columns: 100, rows: 30 }));
		// One socket: the resize reaches the program before the next keys do.
		browser.socket.send(Buffer.from("stty size\r"));
		await browser.printed(/30 100/);
		const { text, ended } = await terminals.backlog!({ terminal: id, wait: 5_000 }, context);
		assert.match(text, /typed-42/);
		assert.match(text, /30 100/);
		assert.equal(ended, false);
		browser.socket.send(Buffer.from("exit\r"));
		assert.equal(await browser.closed, 1000);
		await until(terminals.terminals!, (list) => list[0]?.exitCode === 0, within("the exit", context));
		await terminals.close!({ terminal: id }, context);
		await until(terminals.terminals!, (list) => list.length === 0, within("closed", context));
		assert.deepEqual(t.errors, []);
	});

	it("refuses a socket without a cookie, from another site's page, and to a person without Watch or Use", async () => {
		const owner = await t.client(context);
		const pi = await piOf(owner, context);
		const thing = await t.host.root(
			async (ctx) => seeded(await ctx.get(OneThing, { kind: TerminalsKind.name }), ctx),
			context,
		);
		const machine = await t.host.root(
			async (ctx) => seeded(await ctx.get(OneThing, { kind: MACHINE_KIND }), ctx),
			context,
		);
		const terminals = await owner.get(Terminals, { workspace: pi, thing }, context);
		const id = await terminals.open!({ machine, folder, columns: 80, rows: 24 }, context);
		const { url } = await terminals.attach!({ terminal: id }, context);
		assert.equal(await attachSocket(url, { origin: origin() }).closed, 401);
		const cookie = await t.cookie(context);
		assert.equal(await attachSocket(url, { cookie, origin: "https://elsewhere.example" }).closed, 403);
		assert.equal(await attachSocket(url, { cookie: await stranger(), origin: origin() }).closed, SOCKET_REFUSED);
		await terminals.close!({ terminal: id }, context);
	});
});

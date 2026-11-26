// The terminals plugin on the server (`testPlugin`, beside the things, environments and people plugins' server
// facets, and a stand-in machine host whose terminals are fake programs): Terminals is made in Pi once and gives
// everyone there Watch, the agents Use; Watch is for people, Use gives the list and the bytes too. One terminal, many
// viewers: what is typed reaches the program, its bytes reach every viewer at the address `attach` answers (kept
// output, then what follows) and the backlog; resize and close reach it, its exit shows in the list. Every call
// reaches the machine as the caller: a machine withheld from a person is refused and its terminals are not listed;
// closing needs only Use. A stream ends in the flush that withholds Watch and Use. A terminal outlives its viewers and
// the agent's Use; it ends with its machine, its Terminals thing, or the environments plugin's host.

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
	type Ctx,
	BACKGROUND_CONTEXT as context,
	defineFacet,
	isChordError,
	type P3Principal,
	type Reference,
	until,
} from "@earendil-works/p3/v1";
import { Http, type HttpRequest } from "@earendil-works/p3/v1/server";
import { type TestedPlugin, testPlugin } from "@earendil-works/p3/v1/testing";
import { within } from "../../../test/until.ts";
import { MachineHosts, type Pty, type PtyOptions, TERMINAL_BACKLOG } from "../../environments/contract.server.ts";
import { MACHINE_KIND } from "../../environments/contract.ts";
import environmentsServer from "../../environments/server.ts";
import peopleServer from "../../people/server.ts";
import { OneThing, ThingsStore } from "../../things/contract.server.ts";
import type { Party, Source } from "../../things/contract.ts";
import thingsServer from "../../things/server.ts";
import { ATTACH_PATH, Terminals, TerminalsKind } from "../contract.ts";

/** A person's principal. */
type Person = Extract<P3Principal, { kind: "person" }>;

/** A fake program in a terminal: what it was given, and `say`/`exit` to make it answer. */
type FakePty = {
	readonly options: PtyOptions;
	readonly typed: string[];
	size: [number, number];
	closed: boolean;
	/** Settles when the program is closed. */
	readonly ended: Promise<void>;
	say(text: string): void;
	exit(code: number): void;
};

/** Who sets things up in the tests. */
const BY: Source = { kind: "plugin", plugin: "test" };

/** The programs the stand-in machine host started, in order. */
const started: FakePty[] = [];

/** While set, the stand-in's `openPty` waits for it before it answers (an open under way). */
let gate: Promise<void> | undefined;

/**
 * A stand-in for this device's terminals: its plugin name sorts first, so its host answers for every machine before
 * the environments plugin's, whose terminals are pending.
 */
const fakeHost = defineFacet((_host, self) => {
	self.contribute(MachineHosts, () => ({
		env: undefined as never,
		hidden: [],
		listNames: async () => [],
		createFile: () => Promise.reject(new Error("no files here")),
		openPty: async (options) => {
			await gate;
			let exited: (code: number) => void = () => {};
			let ended: () => void = () => {};
			const fake: FakePty & Pty = {
				options,
				typed: [],
				size: [options.columns, options.rows],
				closed: false,
				say: (text) => options.onData(new TextEncoder().encode(text)),
				exit: (code) => exited(code),
				write: (data) => void fake.typed.push(data),
				resize: (columns, rows) => {
					fake.size = [columns, rows];
				},
				close: () => {
					fake.closed = true;
					ended();
				},
				ended: new Promise((resolve) => {
					ended = resolve;
				}),
				exited: new Promise((resolve) => {
					exited = resolve;
				}),
			};
			started.push(fake);
			return fake;
		},
	}));
});

/** What the terminals plugin's server facet uses of other plugins. */
const STUBS = [
	{ name: "@earendil-works/p3-a-fake-machine", facet: fakeHost },
	{ name: "@earendil-works/p3-things", facet: thingsServer },
	{ name: "@earendil-works/p3-environments", facet: environmentsServer },
	{ name: "@earendil-works/p3-people", facet: peopleServer },
];

/** The size the tests open terminals with. */
const SIZE = { columns: 80, rows: 24 };

let t: TestedPlugin<P3Principal>;
let things: Reference<typeof ThingsStore>;
let pi: string;
let terminals: string;
let machine: string;
/** Whether the test closed the host itself. */
let closed: boolean;

beforeEach(async () => {
	started.length = 0;
	gate = undefined;
	closed = false;
	t = await testPlugin(fileURLToPath(new URL("../", import.meta.url)), { kind: "server", stubs: STUBS }, context);
	things = await t.host.get(ThingsStore, {}, context);
	pi = (await things.workspaces.children.page({ parent: "" }, 1, context)).items[0]!.workspace;
	terminals = (await t.host.get(OneThing, { kind: TerminalsKind.name }, context)).thing.value;
	machine = (await t.host.get(OneThing, { kind: MACHINE_KIND }, context)).thing.value;
});

afterEach(async () => {
	if (!closed) await t.close(context);
});

/** Makes person `name`, put into `workspace`; their principal. */
async function person(name: string, workspace = pi): Promise<Person> {
	const id = await things.createPerson({ name, madeBy: BY }, context);
	await things.putParty({ workspace, party: { kind: "person", person: id }, source: BY }, context);
	return { kind: "person", id, name };
}

/** Session `session`'s agent, put into Pi; its worker's principal. */
async function agent(session: string): Promise<P3Principal> {
	await things.putParty({ workspace: pi, party: { kind: "agent", session }, source: BY }, context);
	return { kind: "worker", session };
}

/** Gives (or withholds, `gives: false`) `party` the ticks `ticks` on `thing` in `where`. */
const grant = (where: string, thing: string, party: Party, ticks: string[], gives = true) =>
	things.setGrants(
		{ source: BY, grants: ticks.map((tick) => ({ workspace: where, thing, party, tick, gives })) },
		context,
	);

/** Runs `fn` with `principal`'s Terminals held in `where`. */
function holding<T>(
	principal: P3Principal,
	fn: (terminals: Reference<typeof Terminals>, ctx: Ctx<P3Principal>) => Promise<T>,
	where = pi,
): Promise<T> {
	return t.root(
		async (ctx) => fn(await ctx.get(Terminals, { workspace: where, thing: terminals }, { readyTimeout: 500 }), ctx),
		context,
		{ principal },
	);
}

/** The attach route's bytes of terminal `id` as `ctx`'s caller: the next piece at each call ("" at the end). */
async function attached(r: Reference<typeof Terminals>, id: string, ctx: Ctx<P3Principal>) {
	const { url } = await r.attach!({ terminal: id }, ctx);
	const entry = t
		.contributions(Http)
		.flatMap(({ value }) => Object.entries(value.routes ?? {}))
		.find(([name]) => name === `GET ${ATTACH_PATH}`)![1];
	const handler = typeof entry === "function" ? entry : entry.handler;
	const request = { method: "GET", query: new URL(url, "http://p3").searchParams } as unknown as HttpRequest;
	const response = await handler(request, ctx);
	if (response.kind !== "bytes") throw new Error(`attach answered ${JSON.stringify(response)}`);
	let offset = 0;
	return async () => {
		const bytes = await response.read(offset, 256 * 1024, ctx);
		offset += bytes.length;
		return Buffer.from(bytes).toString();
	};
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

describe("Terminals and its ticks", () => {
	it("is made in Pi once, and gives everyone there Watch, the agents Use; Watch is for people", async () => {
		const ann = await person("Ann");
		assert.deepEqual(await holding(ann, async (r) => [...r.granted].sort()), ["attach", "backlog", "terminals"]);
		const worker = await agent("s1");
		const use = ["attach", "backlog", "close", "open", "resize", "terminals", "type"];
		assert.deepEqual(await holding(worker, async (r) => [...r.granted].sort()), use);
		await grant(pi, terminals, { kind: "person", person: ann.id }, ["use"]);
		await grant(pi, terminals, { kind: "person", person: ann.id }, ["watch"], false);
		assert.deepEqual(await holding(ann, async (r) => [...r.granted].sort()), use, "Use alone lists and attaches");
		await refused(grant(pi, terminals, { kind: "agents" }, ["watch"]), "invalid");
		assert.equal((await t.host.get(OneThing, { kind: TerminalsKind.name }, context)).thing.value, terminals);
	});

	it("Watch without Use sees the list and the bytes and cannot open, type or close; no tick, no member (1174 test 1)", async () => {
		const ann = await person("Ann");
		const kim = await person("Kim");
		await grant(pi, terminals, { kind: "person", person: ann.id }, ["use"]);
		const id = await holding(ann, (a, ctx) => a.open!({ machine, folder: "/tmp", ...SIZE }, ctx));
		started[0]!.say("hi");
		await holding(kim, async (k, ctx) => {
			await until(k.terminals!, (list) => list.length === 1, within("Kim's list", ctx));
			assert.equal(await (await attached(k, id, ctx))(), "hi");
			assert.equal(k.open, undefined);
			assert.equal(k.type, undefined);
			assert.equal(k.close, undefined);
		});
		await grant(pi, terminals, { kind: "person", person: kim.id }, ["watch"], false);
		assert.deepEqual(await holding(kim, async (k) => [...k.granted]), []);
	});
});

describe("one terminal, many viewers", () => {
	it("types into the program, shows its bytes to every viewer and in the backlog, resizes and closes it", async () => {
		const ann = await person("Ann");
		const kim = await person("Kim");
		await grant(pi, terminals, { kind: "person", person: ann.id }, ["use"]);
		await holding(ann, async (a, ctx) => {
			const id = await a.open!({ machine, folder: "/tmp", ...SIZE }, ctx);
			assert.equal(started.length, 1);
			assert.equal(started[0]!.options.cwd, "/tmp");
			started[0]!.say("hello ");
			await holding(kim, async (k, kctx) => {
				const next = await attached(k, id, kctx);
				assert.equal(await next(), "hello ");
				const backlog = await k.backlog!({ terminal: id }, kctx);
				assert.deepEqual(backlog, { data: Buffer.from("hello ").toString("base64") });
				await a.type!({ terminal: id, bytes: "ls\r" }, ctx);
				assert.deepEqual(started[0]!.typed, ["ls\r"]);
				started[0]!.say("world");
				assert.equal(await next(), "world");
			});
			await a.resize!({ terminal: id, columns: 100, rows: 30 }, ctx);
			assert.deepEqual(started[0]!.size, [100, 30]);
			started[0]!.exit(3);
			await until(a.terminals!, (list) => list[0]?.exitCode === 3, within("the exit", ctx));
			assert.equal(a.terminals!.value[0]!.columns, 100);
			await a.close!({ terminal: id }, ctx);
			assert.equal(started[0]!.closed, true);
			await until(a.terminals!, (list) => list.length === 0, within("closed", ctx));
			await refused(a.type!({ terminal: id, bytes: "x" }, ctx), "invalid", "noTerminal");
		});
	});

	it("gives each viewer their own stream: one viewer leaving leaves the other's running (1174 test 2)", async () => {
		const ann = await person("Ann");
		const kim = await person("Kim");
		const worker = await agent("s1");
		const id = await holding(worker, (w, ctx) => w.open!({ machine, folder: "/tmp", ...SIZE }, ctx));
		await holding(ann, async (a, ctx) => {
			const anns = await attached(a, id, ctx);
			await holding(kim, async (k, kctx) => {
				const kims = await attached(k, id, kctx);
				started[0]!.say("one");
				assert.equal(await kims(), "one");
			});
			assert.equal(await anns(), "one");
			started[0]!.say("two");
			assert.equal(await anns(), "two");
		});
		assert.equal(started[0]!.closed, false);
	});

	it("outlives its viewers, and ends with the environments plugin's host", async () => {
		const ann = await person("Ann");
		await grant(pi, terminals, { kind: "person", person: ann.id }, ["use"]);
		const id = await holding(ann, (a, ctx) => a.open!({ machine, folder: "/tmp", ...SIZE }, ctx));
		started[0]!.say("still here");
		await holding(ann, async (a, ctx) => {
			await until(a.terminals!, (list) => list.some((terminal) => terminal.id === id), within("the list", ctx));
			const { data } = await a.backlog!({ terminal: id }, ctx);
			assert.equal(Buffer.from(data, "base64").toString(), "still here");
		});
		assert.equal(started[0]!.closed, false);
		await t.close(context);
		closed = true;
		await started[0]!.ended;
	});

	it("keeps the last BACKLOG bytes exactly, however the program's output comes (astra repro)", async () => {
		const worker = await agent("s1");
		await holding(worker, async (w, ctx) => {
			const one = await w.open!({ machine, folder: "/tmp", ...SIZE }, ctx);
			started[0]!.options.onData(new Uint8Array(TERMINAL_BACKLOG + 1).fill(65));
			assert.equal(Buffer.from((await w.backlog!({ terminal: one }, ctx)).data, "base64").length, TERMINAL_BACKLOG);
			const two = await w.open!({ machine, folder: "/tmp", ...SIZE }, ctx);
			started[1]!.options.onData(new Uint8Array(TERMINAL_BACKLOG).fill(65));
			started[1]!.say("!");
			const tail = Buffer.from((await w.backlog!({ terminal: two }, ctx)).data, "base64");
			assert.equal(tail.length, TERMINAL_BACKLOG);
			assert.equal(tail.at(-1), "!".charCodeAt(0));
		});
	});

	it("gives a viewer that fell behind 10 MiB the kept tail, not everything (1174 test 8)", async () => {
		const ann = await person("Ann");
		const worker = await agent("s1");
		const id = await holding(worker, (w, ctx) => w.open!({ machine, folder: "/tmp", ...SIZE }, ctx));
		await holding(ann, async (a, ctx) => {
			const next = await attached(a, id, ctx);
			const piece = new Uint8Array(64 * 1024).fill(66);
			for (let sent = 0; sent < 10 * 1024 * 1024; sent += piece.length) started[0]!.options.onData(piece);
			let received = 0;
			while (received < TERMINAL_BACKLOG) received += (await next()).length;
			assert.equal(received, TERMINAL_BACKLOG);
			console.log(`terminals: 10 MiB printed, ${received} bytes sent to a viewer that fell behind`);
		});
	});
});

describe("where a call may reach", () => {
	it("refuses a machine withheld from a person and hides its terminals; refuses relative folders", async () => {
		const ann = await person("Ann");
		const kim = await person("Kim");
		await grant(pi, terminals, { kind: "person", person: ann.id }, ["use"]);
		await grant(pi, terminals, { kind: "person", person: kim.id }, ["use"]);
		await holding(ann, async (a, ctx) => {
			const id = await a.open!({ machine, folder: "/tmp", ...SIZE }, ctx);
			await refused(a.open!({ machine, folder: "tmp", ...SIZE }, ctx), "invalid", "notAbsolute");
			await refused(a.open!({ machine: "elsewhere", folder: "/tmp", ...SIZE }, ctx), "forbidden", "notHere");
			await grant(pi, machine, { kind: "person", person: kim.id }, ["@open"], false);
			await holding(kim, async (k, kctx) => {
				await until(k.terminals!, () => true, within("Kim's list", kctx));
				assert.deepEqual(k.terminals!.value, []);
				await refused(k.open!({ machine, folder: "/tmp", ...SIZE }, kctx), "forbidden", "notHere");
				await refused(k.type!({ terminal: id, bytes: "x" }, kctx), "forbidden", "notHere");
				await refused(k.attach!({ terminal: id }, kctx), "forbidden", "notHere");
				// Closing only ends a program: Use here is enough.
				await k.close!({ terminal: id }, kctx);
			});
			assert.equal(started[0]!.closed, true);
		});
	});

	it("lets an agent with Use open, type in and read any terminal here", async () => {
		const ann = await person("Ann");
		const worker = await agent("s1");
		await grant(pi, terminals, { kind: "person", person: ann.id }, ["use"]);
		const anns = await holding(ann, (a, ctx) => a.open!({ machine, folder: "/tmp", ...SIZE }, ctx));
		await holding(worker, async (w, ctx) => {
			const own = await w.open!({ machine, folder: "/tmp", ...SIZE }, ctx);
			started[1]!.say("$ ");
			assert.deepEqual(await w.backlog!({ terminal: own }, ctx), { data: Buffer.from("$ ").toString("base64") });
			await w.type!({ terminal: own, bytes: "pwd\r" }, ctx);
			assert.deepEqual(started[1]!.typed, ["pwd\r"]);
			await w.type!({ terminal: anns, bytes: "x" }, ctx);
			assert.deepEqual(started[0]!.typed, ["x"]);
			assert.deepEqual(await w.backlog!({ terminal: anns }, ctx), { data: "" });
		});
	});

	it("refuses an agent without Work here on the machine", async () => {
		const worker = await agent("s1");
		await grant(pi, machine, { kind: "agents" }, ["work"], false);
		await holding(worker, async (w, ctx) => {
			await refused(w.open!({ machine, folder: "/tmp", ...SIZE }, ctx), "forbidden", "noWork");
		});
	});

	it("is not there in a workspace below that hides it (1174 test 6)", async () => {
		const child = await things.createWorkspace(
			{ kind: "things.workspace", name: "Family", parent: pi, by: BY },
			context,
		);
		const leo = await person("Leo", child);
		await things.setSwitch({ workspace: child, item: { kind: "thing", thing: terminals }, shown: false }, context);
		await refused(
			holding(leo, async () => null, child),
			"forbidden",
		);
	});

	it("counts opens under way: two opens for one last slot start one program (astra repro)", async () => {
		const worker = await agent("s1");
		await holding(worker, async (w, ctx) => {
			for (let i = 0; i < 19; i++) await w.open!({ machine, folder: "/tmp", ...SIZE }, ctx);
			let open: () => void = () => {};
			gate = new Promise((resolve) => {
				open = resolve;
			});
			const both = Promise.allSettled([
				w.open!({ machine, folder: "/tmp", ...SIZE }, ctx),
				w.open!({ machine, folder: "/tmp", ...SIZE }, ctx),
			]);
			open();
			const [first, second] = await both;
			assert.deepEqual([first.status, second.status].sort(), ["fulfilled", "rejected"]);
			assert.equal(started.length, 20);
		});
	});
});

describe("a terminal's lifetime", () => {
	it("keeps running when the agents lose Use; people can still close it (1174 test 5)", async () => {
		const ann = await person("Ann");
		const worker = await agent("s1");
		await grant(pi, terminals, { kind: "person", person: ann.id }, ["use"]);
		const id = await holding(worker, (w, ctx) => w.open!({ machine, folder: "/tmp", ...SIZE }, ctx));
		await grant(pi, terminals, { kind: "agents" }, ["use"], false);
		assert.deepEqual(await holding(worker, async (w) => [...w.granted]), []);
		assert.equal(started[0]!.closed, false);
		await holding(ann, (a, ctx) => a.close!({ terminal: id }, ctx));
		assert.equal(started[0]!.closed, true);
	});

	it("ends when its machine goes (astra repro)", async () => {
		const worker = await agent("s1");
		await holding(worker, (w, ctx) => w.open!({ machine, folder: "/tmp", ...SIZE }, ctx));
		await things.unlink({ workspace: pi, thing: machine }, context);
		await started[0]!.ended;
	});

	it("ends when its Terminals thing goes (astra repro)", async () => {
		const worker = await agent("s1");
		await holding(worker, (w, ctx) => w.open!({ machine, folder: "/tmp", ...SIZE }, ctx));
		await things.unlink({ workspace: pi, thing: terminals }, context);
		await started[0]!.ended;
	});
});

describe("a held Terminals", () => {
	it("loses the list and its streams in the flush in which Watch is withheld (1174 test 3)", async () => {
		const ann = await person("Ann");
		const worker = await agent("s1");
		const id = await holding(worker, (w, ctx) => w.open!({ machine, folder: "/tmp", ...SIZE }, ctx));
		await holding(ann, async (a, ctx) => {
			const next = await attached(a, id, ctx);
			const waiting = next();
			await grant(pi, terminals, { kind: "person", person: ann.id }, ["watch"], false);
			assert.equal(await waiting, "", "the stream ended");
			await until(
				a.state,
				(state) => state.kind === "live" && a.terminals === undefined,
				within("Watch withheld", ctx),
			);
		});
	});
});

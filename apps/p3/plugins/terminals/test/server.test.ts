// The terminals plugin on the server (`testPlugin`, beside the things, environments and people plugins' server
// facets, and a stand-in machine host whose terminals are fake programs): Terminals is made in Pi once and gives
// everyone there Watch and Use, the agents Use. One terminal, many viewers: what is typed reaches the program, its
// output reaches every watcher as events and as the backlog; resize and close reach it, its exit shows in the list.
// Every call reaches the machine as the caller: a machine withheld from a person is refused and its terminals are
// not listed. An agent with Use types in and reads any terminal here. Watch withheld takes the list and the
// output away at once. A terminal outlives its viewers and ends with the plugin's host.

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
import { type TestedPlugin, testPlugin } from "@earendil-works/p3/v1/testing";
import { within } from "../../../test/until.ts";
import { MachineHosts, type Pty, type PtyOptions } from "../../environments/contract.server.ts";
import { MACHINE_KIND } from "../../environments/contract.ts";
import environmentsServer from "../../environments/server.ts";
import peopleServer from "../../people/server.ts";
import { OneThing, ThingsStore } from "../../things/contract.server.ts";
import type { Party, Source } from "../../things/contract.ts";
import thingsServer from "../../things/server.ts";
import { type Output, Terminals, TerminalsKind } from "../contract.ts";

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

/**
 * A stand-in for this device's terminals: its plugin name sorts first, so its host answers for every machine before
 * the environments plugin's, whose terminals are pending.
 */
const fakeHost = defineFacet((_host, self) => {
	self.contribute(MachineHosts, () => ({
		env: undefined as never,
		hidden: [],
		openPty: async (options) => {
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

/** The text of `output`'s pieces of terminal `terminal`, in order. */
function textOf(output: readonly Output[], terminal: string): string {
	return output
		.filter((piece) => piece.terminal === terminal)
		.map((piece) => Buffer.from(piece.data, "base64").toString())
		.join("");
}

describe("Terminals and its ticks", () => {
	it("is made in Pi once, and gives everyone there Watch and Use, the agents Use", async () => {
		const ann = await person("Ann");
		assert.deepEqual(await holding(ann, async (r) => [...r.granted].sort()), [
			"backlog",
			"close",
			"input",
			"open",
			"output",
			"resize",
			"terminals",
		]);
		const worker = await agent("s1");
		assert.deepEqual(await holding(worker, async (r) => [...r.granted].sort()), [
			"backlog",
			"close",
			"input",
			"open",
			"resize",
		]);
		assert.equal((await t.host.get(OneThing, { kind: TerminalsKind.name }, context)).thing.value, terminals);
	});
});

describe("one terminal, many viewers", () => {
	it("types into the program, shows its output to every watcher and in the backlog, resizes and closes it", async () => {
		const ann = await person("Ann");
		const kim = await person("Kim");
		await holding(ann, async (a, ctx) => {
			const id = await a.open!({ machine, folder: "/tmp", ...SIZE }, ctx);
			assert.equal(started.length, 1);
			assert.equal(started[0]!.options.cwd, "/tmp");
			started[0]!.say("hello ");
			await holding(kim, async (k, kctx) => {
				const seen: Output[] = [];
				await k.output!.on(({ value }) => seen.push(value), kctx);
				const backlog = await k.backlog!({ terminal: id }, kctx);
				assert.deepEqual(backlog, { seq: 1, data: Buffer.from("hello ").toString("base64") });
				await k.input!({ terminal: id, data: "ls\r" }, kctx);
				assert.deepEqual(started[0]!.typed, ["ls\r"]);
				started[0]!.say("world");
				await until(k.terminals!, (list) => list.length === 1, within("Kim's list", kctx));
				await until(k.terminals!, () => textOf(seen, id) === "world", within("Kim's output", kctx));
				assert.equal(seen[0]!.seq, 2);
			});
			await a.resize!({ terminal: id, columns: 100, rows: 30 }, ctx);
			assert.deepEqual(started[0]!.size, [100, 30]);
			started[0]!.exit(3);
			await until(a.terminals!, (list) => list[0]?.exitCode === 3, within("the exit", ctx));
			assert.equal(a.terminals!.value[0]!.columns, 100);
			await a.close!({ terminal: id }, ctx);
			assert.equal(started[0]!.closed, true);
			await until(a.terminals!, (list) => list.length === 0, within("closed", ctx));
			await refused(a.input!({ terminal: id, data: "x" }, ctx), "invalid", "noTerminal");
		});
	});

	it("outlives its viewers, and ends with the plugin's host", async () => {
		const ann = await person("Ann");
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
});

describe("where a call may reach", () => {
	it("refuses a machine withheld from a person and hides its terminals; refuses relative folders", async () => {
		const ann = await person("Ann");
		const kim = await person("Kim");
		await holding(ann, async (a, ctx) => {
			const id = await a.open!({ machine, folder: "/tmp", ...SIZE }, ctx);
			await refused(a.open!({ machine, folder: "tmp", ...SIZE }, ctx), "invalid", "notAbsolute");
			await refused(a.open!({ machine: "elsewhere", folder: "/tmp", ...SIZE }, ctx), "forbidden", "notHere");
			await grant(pi, machine, { kind: "person", person: kim.id }, ["@open"], false);
			await holding(kim, async (k, kctx) => {
				await until(k.terminals!, () => true, within("Kim's list", kctx));
				assert.deepEqual(k.terminals!.value, []);
				await refused(k.open!({ machine, folder: "/tmp", ...SIZE }, kctx), "forbidden", "notHere");
				await refused(k.input!({ terminal: id, data: "x" }, kctx), "forbidden", "notHere");
			});
		});
	});

	it("lets an agent with Use only open, type in and read any terminal here", async () => {
		const ann = await person("Ann");
		const worker = await agent("s1");
		const anns = await holding(ann, (a, ctx) => a.open!({ machine, folder: "/tmp", ...SIZE }, ctx));
		await holding(worker, async (w, ctx) => {
			const own = await w.open!({ machine, folder: "/tmp", ...SIZE }, ctx);
			started[1]!.say("$ ");
			assert.deepEqual(await w.backlog!({ terminal: own }, ctx), {
				seq: 1,
				data: Buffer.from("$ ").toString("base64"),
			});
			await w.input!({ terminal: own, data: "pwd\r" }, ctx);
			assert.deepEqual(started[1]!.typed, ["pwd\r"]);
			await w.input!({ terminal: anns, data: "x" }, ctx);
			assert.deepEqual(started[0]!.typed, ["x"]);
			assert.deepEqual(await w.backlog!({ terminal: anns }, ctx), { seq: 0, data: "" });
		});
	});

	it("refuses an agent without Work here on the machine", async () => {
		const worker = await agent("s1");
		await grant(pi, machine, { kind: "agents" }, ["work"], false);
		await holding(worker, async (w, ctx) => {
			await refused(w.open!({ machine, folder: "/tmp", ...SIZE }, ctx), "forbidden", "noWork");
		});
	});
});

describe("a held Terminals", () => {
	it("loses the list and the output in the flush in which Watch is withheld", async () => {
		const ann = await person("Ann");
		await holding(ann, async (a, ctx) => {
			await a.open!({ machine, folder: "/tmp", ...SIZE }, ctx);
			await grant(pi, terminals, { kind: "person", person: ann.id }, ["read"], false);
			await until(
				a.state,
				(state) => state.kind === "live" && a.output === undefined && a.terminals === undefined,
				within("Watch withheld", ctx),
			);
			assert.notEqual(a.open, undefined, "Use stays");
		});
	});
});

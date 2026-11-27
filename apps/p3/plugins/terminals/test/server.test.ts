// The terminals plugin on the server (`testPlugin`, beside the things, environments and people plugins' server
// facets, and a stand-in machine host whose terminals are fake programs): Terminals is made in Pi once and gives the
// agents Use, people nothing until Who may gives them a tick; Watch is for people, Use gives the list and the bytes too. One terminal, many
// viewers: what is typed reaches the program, its bytes reach every viewer at the address `attach` answers (kept
// output, then what follows) and the backlog; resize and close reach it, its exit shows in the list. Every call
// reaches the machine as the caller: a machine withheld from a person is refused and its terminals are not listed;
// closing needs only Use. A stream ends in the flush that withholds Watch and Use. A terminal outlives its viewers and
// the agent's Use; it ends with its machine, its Terminals thing, its workspace, or the environments plugin's host.

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
	type Ctx,
	BACKGROUND_CONTEXT as context,
	type P3Principal,
	type Reference,
	until,
} from "@earendil-works/p3/v1";
import { Http, type HttpRequest } from "@earendil-works/p3/v1/server";
import { type TestedPlugin, testPlugin } from "@earendil-works/p3/v1/testing";
import { collected, within } from "../../../test/until.ts";
import { TERMINAL_BACKLOG } from "../../environments/contract.terminal-host.server.ts";
import { MACHINE_KIND } from "../../environments/contract.ts";
import environmentsServer from "../../environments/server.ts";
import { fakeMachine, fakeType } from "../../environments/test/fake-machine.ts";
import { seeded } from "../../environments/test/seeded.ts";
import peopleServer from "../../people/server.ts";
import { OneThing, ThingsStore } from "../../things/contract.server.ts";
import type { Party, Source } from "../../things/contract.ts";
import thingsServer from "../../things/server.ts";
import { refused } from "../../things/test/kind-server.ts";
import { ATTACH_PATH, Terminals, TerminalsKind } from "../kind.ts";

/** A person's principal. */
type Person = Extract<P3Principal, { kind: "person" }>;

/** Who sets things up in the tests. */
const BY: Source = { kind: "plugin", plugin: "test" };

/** The stand-in machine of each test: this device's, whose programs are fakes. */
let fake = fakeMachine();

/** Its programs, in the order they started. */
const started = () => fake.started;

/** What the terminals plugin's server facet uses of other plugins. */
const STUBS = [
	// Sorts first, so its type wins this device's name over the environments plugin's, whose terminals are pending.
	{ name: "@earendil-works/p3-a-fake-machine", facet: fakeType(() => fake.host) },
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
	fake = fakeMachine();
	closed = false;
	t = await testPlugin(fileURLToPath(new URL("../", import.meta.url)), { kind: "server", stubs: STUBS }, context);
	things = await t.host.get(ThingsStore, {}, context);
	pi = (await things.workspaces.children.page({ parent: "" }, 1, context)).items[0]!.workspace;
	terminals = await seeded(await t.host.get(OneThing, { kind: TerminalsKind.name }, context), context);
	machine = await seeded(await t.host.get(OneThing, { kind: MACHINE_KIND }, context), context);
	// Who may lets everyone in Pi watch, as the owner would: the kind gives people nothing ("the defaults").
	await grant(pi, terminals, { kind: "everyone" }, ["watch"]);
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

describe("Terminals and its ticks", () => {
	it("is made in Pi once, and gives everyone there Watch, the agents Use; Watch is for people", async () => {
		const ann = await person("Ann");
		assert.deepEqual(await holding(ann, async (r) => [...r.granted].sort()), ["attach", "terminals"]);
		const worker = await agent("s1");
		const use = ["attach", "backlog", "close", "open", "resize", "terminals", "type"];
		assert.deepEqual(await holding(worker, async (r) => [...r.granted].sort()), use);
		await grant(pi, terminals, { kind: "person", person: ann.id }, ["use"]);
		await grant(pi, terminals, { kind: "person", person: ann.id }, ["watch"], false);
		assert.deepEqual(await holding(ann, async (r) => [...r.granted].sort()), use, "Use alone lists and attaches");
		await refused(grant(pi, terminals, { kind: "agents" }, ["watch"]), "invalid");
		assert.equal(await seeded(await t.host.get(OneThing, { kind: TerminalsKind.name }, context), context), terminals);
	});

	it("Watch without Use sees the list and the bytes and cannot open, type or close; no tick, no member (1174 test 1)", async () => {
		const ann = await person("Ann");
		const kim = await person("Kim");
		await grant(pi, terminals, { kind: "person", person: ann.id }, ["use"]);
		const id = await holding(ann, (a, ctx) => a.open!({ machine, folder: "/tmp", ...SIZE }, ctx));
		started()[0]!.say("hi");
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

describe("the owner, guests and the one thing (slice 1's rules)", () => {
	it("gives the owner Use without being put in, also where Watch is withheld from everyone", async () => {
		const id = await things.createPerson({ name: "Olga", madeBy: BY }, context);
		await things.setOwner({ person: id, owner: true }, context);
		await grant(pi, terminals, { kind: "everyone" }, ["watch"], false);
		assert.deepEqual(await holding({ kind: "person", id, name: "Olga" }, async (r) => [...r.granted].sort()), [
			"attach",
			"backlog",
			"close",
			"open",
			"resize",
			"terminals",
			"type",
		]);
	});

	// Round 5 (Opus M2): a terminal shows what runs on the machine; people get it only once Who may lets them.
	it("gives the agents Use by default, and no person, guest or not", async () => {
		assert.deepEqual(TerminalsKind.info.defaultGrants, { agents: ["use"] });
		// What Who may gave in this file's setup, reset: the kind's defaults alone.
		await things.setTick(
			{ workspace: pi, thing: terminals, party: { kind: "everyone" }, tick: "watch", source: BY },
			context,
		);
		await refused(
			holding(await person("Ann"), async () => null),
			"forbidden",
		);
		const link = await things.createInvite({ workspace: pi, name: "Grandma", as: "guest", by: BY }, context);
		const grandma = (await things.redeemInvite({ secret: link }, context))!;
		await refused(
			holding({ kind: "person", id: grandma.person, name: grandma.name }, async () => null),
			"forbidden",
		);
		assert.ok((await holding(await agent("s1"), async (w) => [...w.granted])).includes("open"));
	});

	it("is made again with a new id when its last link goes, its terminals ended", async () => {
		const worker = await agent("s1");
		await holding(worker, (w, ctx) => w.open!({ machine, folder: "/tmp", ...SIZE }, ctx));
		await things.unlink({ workspace: pi, thing: terminals }, context);
		await started()[0]!.ended;
		const again = await t.host.get(OneThing, { kind: TerminalsKind.name }, context);
		const next = await until(
			again.thing,
			(id) => id !== "" && id !== terminals,
			within("the new Terminals", context),
		);
		terminals = next;
		assert.deepEqual(await holding(worker, async (w) => w.terminals!.value), []);
	});
});

describe("one terminal, many viewers", () => {
	it("types into the program, shows its bytes to every viewer and in the backlog, resizes and closes it", async () => {
		const ann = await person("Ann");
		const kim = await person("Kim");
		await grant(pi, terminals, { kind: "person", person: ann.id }, ["use"]);
		await holding(ann, async (a, ctx) => {
			const id = await a.open!({ machine, folder: "/tmp", ...SIZE }, ctx);
			assert.equal(started().length, 1);
			assert.equal(started()[0]!.options.cwd, "/tmp");
			started()[0]!.say("hello ");
			await holding(kim, async (k, kctx) => {
				const next = await attached(k, id, kctx);
				assert.equal(await next(), "hello ");
				assert.equal(k.backlog, undefined, "the backlog is Use's");
				const backlog = await a.backlog!({ terminal: id, max: 3 }, ctx);
				assert.deepEqual(backlog, { data: Buffer.from("lo ").toString("base64") }, "at most `max` bytes");
				await a.type!({ terminal: id, bytes: "ls\r" }, ctx);
				assert.deepEqual(started()[0]!.typed, ["ls\r"]);
				started()[0]!.say("world");
				assert.equal(await next(), "world");
			});
			await a.resize!({ terminal: id, columns: 100, rows: 30 }, ctx);
			assert.deepEqual(started()[0]!.size, [100, 30]);
			started()[0]!.exit(3);
			await until(a.terminals!, (list) => list[0]?.exitCode === 3, within("the exit", ctx));
			await refused(a.type!({ terminal: id, bytes: "x" }, ctx), "invalid", "notRunning");
			await a.close!({ terminal: id }, ctx);
			assert.equal(started()[0]!.closed, true);
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
				started()[0]!.say("one");
				assert.equal(await kims(), "one");
			});
			assert.equal(await anns(), "one");
			started()[0]!.say("two");
			assert.equal(await anns(), "two");
		});
		assert.equal(started()[0]!.closed, false);
	});

	it("outlives its viewers, and ends with the environments plugin's host", async () => {
		const ann = await person("Ann");
		await grant(pi, terminals, { kind: "person", person: ann.id }, ["use"]);
		const id = await holding(ann, (a, ctx) => a.open!({ machine, folder: "/tmp", ...SIZE }, ctx));
		started()[0]!.say("still here");
		await holding(ann, async (a, ctx) => {
			await until(a.terminals!, (list) => list.some((terminal) => terminal.id === id), within("the list", ctx));
			const { data } = await a.backlog!({ terminal: id }, ctx);
			assert.equal(Buffer.from(data, "base64").toString(), "still here");
		});
		assert.equal(started()[0]!.closed, false);
		await t.close(context);
		closed = true;
		await started()[0]!.ended;
	});

	it("keeps the last BACKLOG bytes exactly, however the program's output comes (astra repro)", async () => {
		const worker = await agent("s1");
		await holding(worker, async (w, ctx) => {
			const one = await w.open!({ machine, folder: "/tmp", ...SIZE }, ctx);
			started()[0]!.options.onData(new Uint8Array(TERMINAL_BACKLOG + 1).fill(65));
			assert.equal(Buffer.from((await w.backlog!({ terminal: one }, ctx)).data, "base64").length, TERMINAL_BACKLOG);
			const two = await w.open!({ machine, folder: "/tmp", ...SIZE }, ctx);
			started()[1]!.options.onData(new Uint8Array(TERMINAL_BACKLOG).fill(65));
			started()[1]!.say("!");
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
			for (let sent = 0; sent < 10 * 1024 * 1024; sent += piece.length) started()[0]!.options.onData(piece);
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
			assert.equal(started()[0]!.closed, true);
		});
	});

	it("lets an agent with Use open, type in and read any terminal here", async () => {
		const ann = await person("Ann");
		const worker = await agent("s1");
		await grant(pi, terminals, { kind: "person", person: ann.id }, ["use"]);
		const anns = await holding(ann, (a, ctx) => a.open!({ machine, folder: "/tmp", ...SIZE }, ctx));
		await holding(worker, async (w, ctx) => {
			const own = await w.open!({ machine, folder: "/tmp", ...SIZE }, ctx);
			started()[1]!.say("$ ");
			assert.deepEqual(await w.backlog!({ terminal: own }, ctx), { data: Buffer.from("$ ").toString("base64") });
			await w.type!({ terminal: own, bytes: "pwd\r" }, ctx);
			assert.deepEqual(started()[1]!.typed, ["pwd\r"]);
			await w.type!({ terminal: anns, bytes: "x" }, ctx);
			assert.deepEqual(started()[0]!.typed, ["x"]);
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
			fake.gate = new Promise((resolve) => {
				open = resolve;
			});
			const both = Promise.allSettled([
				w.open!({ machine, folder: "/tmp", ...SIZE }, ctx),
				w.open!({ machine, folder: "/tmp", ...SIZE }, ctx),
			]);
			open();
			const [first, second] = await both;
			assert.deepEqual([first.status, second.status].sort(), ["fulfilled", "rejected"]);
			assert.equal(started().length, 20);
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
		assert.equal(started()[0]!.closed, false);
		await holding(ann, (a, ctx) => a.close!({ terminal: id }, ctx));
		assert.equal(started()[0]!.closed, true);
	});

	it("ends when its machine goes (astra repro)", async () => {
		const worker = await agent("s1");
		await holding(worker, (w, ctx) => w.open!({ machine, folder: "/tmp", ...SIZE }, ctx));
		await things.unlink({ workspace: pi, thing: machine }, context);
		await started()[0]!.ended;
	});

	it("ends when its Terminals thing goes (astra repro)", async () => {
		const worker = await agent("s1");
		await holding(worker, (w, ctx) => w.open!({ machine, folder: "/tmp", ...SIZE }, ctx));
		await things.unlink({ workspace: pi, thing: terminals }, context);
		await started()[0]!.ended;
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

describe("a stream holds what lets its viewer in (round 2)", () => {
	it("ends when the machine is withheld from the person, with nothing printed after (opus round 2, M1)", async () => {
		const ann = await person("Ann");
		const worker = await agent("s1");
		const id = await holding(worker, (w, ctx) => w.open!({ machine, folder: "/tmp", ...SIZE }, ctx));
		await holding(ann, async (a, ctx) => {
			const next = await attached(a, id, ctx);
			started()[0]!.say("before ");
			assert.equal(await next(), "before ");
			await grant(pi, machine, { kind: "person", person: ann.id }, ["@open"], false);
			await until(a.terminals!, (rows) => rows.length === 0, within("the list without it", ctx));
			await refused(a.attach!({ terminal: id }, ctx), "forbidden", "notHere");
			started()[0]!.say("secret");
			assert.equal(await next(), "", "the stream ended");
		});
	});

	it("ends a read under way when its terminal leaves the person's list, with no output meanwhile (astra round 2)", async () => {
		const ann = await person("Ann");
		const worker = await agent("s1");
		const id = await holding(worker, (w, ctx) => w.open!({ machine, folder: "/tmp", ...SIZE }, ctx));
		await holding(ann, async (a, ctx) => {
			const next = await attached(a, id, ctx);
			const waiting = next();
			await grant(pi, machine, { kind: "person", person: ann.id }, ["@open"], false);
			await until(a.terminals!, (rows) => !rows.some((row) => row.id === id), within("the list", ctx));
			assert.equal(await waiting, "");
		});
	});

	it("ends when the person leaves the workspace", async () => {
		const ann = await person("Ann");
		const worker = await agent("s1");
		const id = await holding(worker, (w, ctx) => w.open!({ machine, folder: "/tmp", ...SIZE }, ctx));
		await holding(ann, async (a, ctx) => {
			const next = await attached(a, id, ctx);
			const waiting = next();
			await things.removeParty({ workspace: pi, party: { kind: "person", person: ann.id } }, context);
			assert.equal(await waiting, "");
			started()[0]!.say("after");
			assert.equal(await next(), "");
		});
		assert.equal(started()[0]!.closed, false, "the terminal runs on");
	});

	it("does not start when the terminal is not in the person's list", async () => {
		const ann = await person("Ann");
		const worker = await agent("s1");
		const id = await holding(worker, (w, ctx) => w.open!({ machine, folder: "/tmp", ...SIZE }, ctx));
		await holding(ann, async (a, ctx) => {
			const { url } = await a.attach!({ terminal: id }, ctx);
			await grant(pi, machine, { kind: "person", person: ann.id }, ["@open"], false);
			await until(a.terminals!, (rows) => rows.length === 0, within("the list", ctx));
			const entry = t
				.contributions(Http)
				.flatMap(({ value }) => Object.entries(value.routes ?? {}))
				.find(([name]) => name === `GET ${ATTACH_PATH}`)![1];
			const handler = typeof entry === "function" ? entry : entry.handler;
			const request = { method: "GET", query: new URL(url, "http://p3").searchParams } as unknown as HttpRequest;
			assert.deepEqual(await handler(request, ctx), { kind: "error", status: 403 });
		});
	});
});

describe("terminals of a workspace that went", () => {
	// The things plugin tells the kind (`workspaceGone`, ERNDL-1143); nothing waits for the next open (deck2).
	it("are closed once the workspace is removed, those of other workspaces kept", async () => {
		const child = await things.createWorkspace(
			{ kind: "things.workspace", name: "Family", parent: pi, by: BY },
			context,
		);
		await things.putParty({ workspace: child, party: { kind: "agent", session: "s1" }, source: BY }, context);
		const worker = await agent("s1");
		await holding(worker, (w, ctx) => w.open!({ machine, folder: "/tmp", ...SIZE }, ctx), child);
		await holding(worker, (w, ctx) => w.open!({ machine, folder: "/tmp", ...SIZE }, ctx));
		const [there, here] = started();
		await things.removeWorkspace({ workspace: child }, context);
		await there!.ended;
		assert.equal(here!.closed, false);
	});
});

describe("caches and holds", () => {
	it("keeps nothing of a viewer once their hold is released: their list is collected (guide 8.7)", async () => {
		const ann = await person("Ann");
		const worker = await agent("s1");
		await holding(worker, (w, ctx) => w.open!({ machine, folder: "/tmp", ...SIZE }, ctx));
		const list = await holding(ann, async (a, ctx) => {
			await until(a.terminals!, (rows) => rows.length === 1, within("the list", ctx));
			return new WeakRef(a.terminals!.value);
		});
		assert.ok(await collected([list]));
	});
});

// The terminals plugin on the server (plugin.ts: `testPlugin` beside the things and environments plugins' server
// facets, and a stand-in machine host whose terminals are fake programs): Terminals is made in Pi once and gives
// the agents Use, people nothing until Who may gives them a tick; Watch is for people and lists and attaches, Use also
// opens, types, reads the kept output (at once, or once it went quiet) and closes. Every call reaches the
// machine as the caller: a machine withheld from a person is refused and its terminals are not listed; closing needs
// only Use. A terminal outlives its viewers and the agent's Use; it ends with its machine, its Terminals thing, its
// workspace, or the environments plugin's host. The attach socket's own cases are socket.test.ts's.

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
	type Ctx,
	BACKGROUND_CONTEXT as context,
	type P3Principal,
	type Reference,
	until,
} from "@earendil-works/p3/v1";
import type { TestedPlugin } from "@earendil-works/p3/v1/testing";
import { collected, within } from "../../../test/until.ts";
import { TERMINAL_BACKLOG } from "../../environments/contract.terminal-host.server.ts";
import type { FakeMachine } from "../../environments/test/fake-machine.ts";
import { seeded } from "../../environments/test/seeded.ts";
import { OneThing, type ThingsStore } from "../../things/contract.server.ts";
import type { Party } from "../../things/contract.ts";
import { refused } from "../../things/test/kind-server.ts";
import { QUIET, type Terminals, TerminalsKind } from "../kind.ts";
import { BY, type Person, SIZE, type TerminalsPlugin, terminalsPlugin } from "./plugin.ts";

let p: TerminalsPlugin;
let t: TestedPlugin<P3Principal>;
let things: Reference<typeof ThingsStore>;
let pi: string;
let terminals: string;
let machine: string;
let fake: FakeMachine;
/** Whether the test closed the host itself. */
let closed: boolean;

beforeEach(async () => {
	closed = false;
	p = await terminalsPlugin();
	({ t, things, pi, terminals, machine, fake } = p);
});

afterEach(async () => {
	if (!closed) await t.close(context);
});

/** The stand-in machine's programs, in the order they started. */
const started = () => fake.started;

/** Makes person `name`, put into `workspace`; their principal. */
const person = (name: string, workspace?: string): Promise<Person> => p.person(name, workspace);

/** Session `session`'s agent, put into Pi; its worker's principal. */
const agent = (session: string) => p.agent(session);

/** Gives (or withholds, `gives: false`) `party` the ticks `ticks` on `thing` in `where`. */
const grant = (where: string, thing: string, party: Party, ticks: string[], gives = true) =>
	p.grant(where, thing, party, ticks, gives);

/** Runs `fn` with `principal`'s Terminals held in `where`. */
const holding = <T>(
	principal: P3Principal,
	fn: (terminals: Reference<typeof Terminals>, ctx: Ctx<P3Principal>) => Promise<T>,
	where = pi,
) => p.holding(principal, fn, where);

describe("Terminals and its ticks", () => {
	it("is made in Pi once; Who may's Watch lists and attaches, the agents' Use does all; Watch is for people", async () => {
		const ann = await person("Ann");
		assert.deepEqual(await holding(ann, async (r) => [...r.granted].sort()), ["attach", "terminals"]);
		const worker = await agent("s1");
		const use = ["attach", "backlog", "close", "open", "terminals", "type"];
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
			const socket = await p.socket(k, id, ctx);
			assert.equal(await socket.next(), "hi");
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
		p.terminals = next;
		assert.deepEqual(await holding(worker, async (w) => w.terminals!.value), []);
	});
});

describe("a terminal's calls", () => {
	it("types into the program, reads its kept output, shows its exit and closes it", async () => {
		const ann = await person("Ann");
		const kim = await person("Kim");
		await grant(pi, terminals, { kind: "person", person: ann.id }, ["use"]);
		await holding(ann, async (a, ctx) => {
			const id = await a.open!({ machine, folder: "/tmp", ...SIZE }, ctx);
			assert.equal(started().length, 1);
			assert.equal(started()[0]!.options.cwd, "/tmp");
			started()[0]!.say("hello ");
			await holding(kim, async (k) => assert.equal(k.backlog, undefined, "the backlog is Use's"));
			const backlog = await a.backlog!({ terminal: id, max: 3 }, ctx);
			assert.deepEqual(backlog, { text: "lo ", ended: false }, "at most `max` bytes");
			await a.type!({ terminal: id, bytes: "ls\r" }, ctx);
			assert.deepEqual(started()[0]!.typed, ["ls\r"]);
			started()[0]!.exit(3);
			await until(a.terminals!, (list) => list[0]?.exitCode === 3, within("the exit", ctx));
			assert.deepEqual(await a.backlog!({ terminal: id }, ctx), { text: "hello ", ended: true });
			await refused(a.type!({ terminal: id, bytes: "x" }, ctx), "invalid", "notRunning");
			await a.close!({ terminal: id }, ctx);
			assert.equal(started()[0]!.closed, true);
			await until(a.terminals!, (list) => list.length === 0, within("closed", ctx));
			await refused(a.type!({ terminal: id, bytes: "x" }, ctx), "invalid", "noTerminal");
		});
	});

	// Hack review, terminals item 5: the agent's read slept `wait_ms` and then read.
	it("reads once the output went quiet, waiting no longer than asked, and at once when the program ends", async () => {
		const worker = await agent("s1");
		await holding(worker, async (w, ctx) => {
			const id = await w.open!({ machine, folder: "/tmp", ...SIZE }, ctx);
			const program = started()[0]!;
			const quiet = w.backlog!({ terminal: id, wait: 10_000 }, ctx);
			program.say("one ");
			const more = setTimeout(() => program.say("two"), QUIET / 2);
			assert.deepEqual(await quiet, { text: "one two", ended: false });
			clearTimeout(more);
			const began = Date.now();
			const talking = setInterval(() => program.say("."), QUIET / 4);
			await w.backlog!({ terminal: id, wait: QUIET * 2 }, ctx);
			clearInterval(talking);
			assert.ok(Date.now() - began < QUIET * 4, "no longer than `wait`, though it never went quiet");
			const ending = w.backlog!({ terminal: id, wait: 10_000 }, ctx);
			program.exit(0);
			assert.equal((await ending).ended, true);
		});
	});

	// Astra, round 1, M4: a waiting read checked the machine before the wait, not before it read.
	it("refuses a waiting read once the machine is withheld from the caller meanwhile", async () => {
		const ann = await person("Ann");
		await grant(pi, terminals, { kind: "person", person: ann.id }, ["use"]);
		await holding(ann, async (a, ctx) => {
			const id = await a.open!({ machine, folder: "/tmp", ...SIZE }, ctx);
			const reading = a.backlog!({ terminal: id, wait: 10_000 }, ctx);
			started()[0]!.say("secret");
			await grant(pi, machine, { kind: "person", person: ann.id }, ["@open"], false);
			const began = Date.now();
			await refused(reading, "forbidden", "notHere");
			assert.ok(Date.now() - began < 5_000, "ended by the loss, not by the wait");
		});
	});

	// Fable, round 2: the case above ends by going quiet; a program that keeps printing shows what ends the wait.
	it("ends a waiting read of a terminal that keeps printing once the machine is withheld, long before its wait", async () => {
		const ann = await person("Ann");
		await grant(pi, terminals, { kind: "person", person: ann.id }, ["use"]);
		await holding(ann, async (a, ctx) => {
			const id = await a.open!({ machine, folder: "/tmp", ...SIZE }, ctx);
			// Never quiet: a piece every 100 ms.
			const printing = setInterval(() => started()[0]!.say("."), 100);
			try {
				const reading = a.backlog!({ terminal: id, wait: 20_000 }, ctx);
				await grant(pi, machine, { kind: "person", person: ann.id }, ["@open"], false);
				const began = Date.now();
				await refused(reading, "forbidden", "notHere");
				assert.ok(Date.now() - began < 5_000, `ended by the loss, not by the wait: ${Date.now() - began} ms`);
			} finally {
				clearInterval(printing);
			}
		});
	});

	it("outlives its viewers, and ends with the environments plugin's host", async () => {
		const ann = await person("Ann");
		await grant(pi, terminals, { kind: "person", person: ann.id }, ["use"]);
		const id = await holding(ann, (a, ctx) => a.open!({ machine, folder: "/tmp", ...SIZE }, ctx));
		started()[0]!.say("still here");
		await holding(ann, async (a, ctx) => {
			await until(a.terminals!, (list) => list.some((terminal) => terminal.id === id), within("the list", ctx));
			assert.equal((await a.backlog!({ terminal: id }, ctx)).text, "still here");
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
			assert.equal((await w.backlog!({ terminal: one }, ctx)).text.length, TERMINAL_BACKLOG);
			const two = await w.open!({ machine, folder: "/tmp", ...SIZE }, ctx);
			started()[1]!.options.onData(new Uint8Array(TERMINAL_BACKLOG).fill(65));
			started()[1]!.say("!");
			const tail = (await w.backlog!({ terminal: two }, ctx)).text;
			assert.equal(tail.length, TERMINAL_BACKLOG);
			assert.equal(tail.at(-1), "!");
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
			assert.deepEqual(await w.backlog!({ terminal: own }, ctx), { text: "$ ", ended: false });
			await w.type!({ terminal: own, bytes: "pwd\r" }, ctx);
			assert.deepEqual(started()[1]!.typed, ["pwd\r"]);
			await w.type!({ terminal: anns, bytes: "x" }, ctx);
			assert.deepEqual(started()[0]!.typed, ["x"]);
			assert.deepEqual(await w.backlog!({ terminal: anns }, ctx), { text: "", ended: false });
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

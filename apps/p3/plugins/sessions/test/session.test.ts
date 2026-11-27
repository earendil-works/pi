// The session kind (`session.ts`) and the session defaults kind (`defaults.ts`) on the server, case by case of
// ERNDL-704's tests: making a session needs Make sessions in the parent, the maker gets every tick, the agents only
// Make (1); archiving with Manage, unlinking with Link in the parent (2); a private session (3); a conversation moved
// only to a machine the agents have Work on, by Manage or by the session's worker (8); no app, no member table (9);
// and the defaults: the nearest of two applies, shared gives everyone Read and Send, private hides people
// from above, "opens with" becomes the session's own view, the model its row's. Every call goes through `Workspace` or
// the session's object as its caller would make it, on the things plugin's world with the sessions plugin's server
// facet, the environments plugin's (where a session works) and a stand-in of the base's runtime (its data directory).

import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
	type Ctx,
	BACKGROUND_CONTEXT as context,
	defineFacet,
	isChordError,
	type P3Principal,
	type Reference,
	Session,
	SessionFacts,
	until,
	withGranted,
} from "@earendil-works/p3/v1";
import {
	type ServerRuntime,
	ServerRuntime as ServerRuntimeRegistry,
	WorkerRunners,
} from "@earendil-works/p3/v1/server";
import { eventually, within } from "../../../test/until.ts";
import { MACHINE_KIND } from "../../environments/contract.ts";
import environmentsServer from "../../environments/server.ts";
import { seeded } from "../../environments/test/seeded.ts";
import { Gives, OneThing, ThingsStore } from "../../things/contract.server.ts";
import { makeTick, OPEN, type Party, type Source } from "../../things/contract.ts";
import { refused } from "../../things/test/kind-server.ts";
import { Board, SESSION, SPACES } from "../../things/test/kinds.ts";
import { type World, world } from "../../things/test/world.ts";
import { Workspace } from "../../things/workspace.ts";
import { WorkspaceKind } from "../../things/workspaces.ts";
import { SessionsStore } from "../contract.server.ts";
import type { SessionDefaults } from "../contract.ts";
import { nearestDefaults } from "../defaults.ts";
import { SessionDefaultsKind, SessionKind, SessionObject } from "../kind.ts";
import sessionsServer from "../server.ts";

const BY: Source = { kind: "plugin", plugin: "test" };

let w: World;
let store: Reference<typeof ThingsStore>;
let pi: string;
let dataDir: string;

beforeEach(async () => {
	dataDir = await mkdtemp(join(tmpdir(), "p3-sessions-"));
	const runtime = {
		dataDir,
		workRoot: join(dataDir, "work"),
		machine: { user: "test", hostname: "test" },
	} as ServerRuntime;
	SESSION.gone.length = 0;
	SESSION.goneFails = 0;
	w = await world(context, [
		// A kind whose `workspaceGone` hook records: what a session's archive and unlink tell the kinds.
		SPACES,
		{
			name: "p3.server",
			facet: defineFacet((host) => {
				host.serve(ServerRuntimeRegistry, { compose: () => runtime });
				// No runner: the plugin tier starts no worker, and a removal deletes no worker's data.
				host.serve(WorkerRunners, { compose: () => undefined });
			}),
		},
		{ name: "@earendil-works/p3-environments", facet: environmentsServer },
		{ name: "@earendil-works/p3-sessions", facet: sessionsServer },
	]);
	store = await w.host.get(ThingsStore, {}, context);
	pi = (await store.workspaces.children.page({ parent: "" }, 10, context)).items[0]!.workspace;
});

afterEach(async () => {
	await w.close(context);
	await rm(dataDir, { recursive: true, force: true });
});

type Person = Extract<P3Principal, { kind: "person" }>;

/** A person principal. */
async function person(name: string): Promise<Person> {
	return { kind: "person", id: await store.createPerson({ name, madeBy: BY }, context), name };
}

const party = (who: Person): Party => ({ kind: "person", person: who.id });

/** Puts `who` into `workspace`. */
const put = (workspace: string, who: Person) => store.putParty({ workspace, party: party(who), source: BY }, context);

/** Gives `who` `ticks` on workspace `workspace`'s own thing. */
const own = (workspace: string, who: Party, ticks: string[]) =>
	store.setGrants(
		{ source: BY, grants: ticks.map((tick) => ({ workspace, thing: workspace, party: who, tick, gives: true })) },
		context,
	);

/** Runs `fn` as `principal`. */
function as<T>(principal: P3Principal, fn: (ctx: Ctx<P3Principal>) => Promise<T>): Promise<T> {
	return w.host.root(fn, context, { principal });
}

/** A new session titled `title` in `parent`, made by `who` through `Workspace.make`; answers its id. */
function makeSession(who: P3Principal, parent: string, title: string, input: object = {}): Promise<string> {
	return as(who, async (ctx) => {
		const workspace = withGranted(await ctx.get(Workspace, { workspace: parent }), "make")!;
		return workspace.make({ kind: SessionKind.name, name: title, input }, ctx);
	});
}

/** `caller`'s answer on session `session`'s own thing now (`undefined`: nothing given). */
async function answerOn(session: string, caller: string) {
	return (await w.host.get(Gives, { workspace: session, caller }, context)).answers.value[session];
}

/** Family under Pi with Leo in it, who may make sessions there. */
async function family() {
	const leo = await person("Leo");
	const fam = await store.createWorkspace({ kind: WorkspaceKind.name, name: "Family", parent: pi, by: BY }, context);
	await put(fam, leo);
	await own(fam, party(leo), [makeTick(SessionKind)]);
	return { leo, fam };
}

/** A defaults thing in `workspace` set to `defaults`; answers its id. */
async function defaultsIn(workspace: string, defaults: SessionDefaults): Promise<string> {
	const thing = await store.create({ kind: SessionDefaultsKind.name, name: "d", workspace, by: BY }, context);
	await store.configure({ thing, settings: { defaults } }, context);
	return thing;
}

const PRIVATE: SessionDefaults = { model: null, shared: false, opensWith: null };

describe("making a session (1)", () => {
	it("needs Make sessions in the parent; the maker gets every tick, the agents Make only", async () => {
		const { leo, fam } = await family();
		const kim = await person("Kim");
		await put(fam, kim);
		await as(kim, async (ctx) => assert.equal((await ctx.get(Workspace, { workspace: fam })).make, undefined));
		const session = await makeSession(leo, fam, "Fix the build");
		const mine = await answerOn(session, `person:${leo.id}`);
		for (const tick of ["read", "send", "stop", "manage", "link", "configure", "manageAccess"]) {
			assert.ok(mine?.ticks.includes(tick), `the maker's ${tick}`);
		}
		const agent = await answerOn(session, `worker:${session}`);
		assert.deepEqual(agent?.ticks, []);
		assert.ok(agent?.makes !== undefined && agent.makes.length > 0 && !agent.makes.includes(SessionKind.name));
	});

	it("writes the row: this device in a folder of its own, settled, no model; a given machine must be one its maker may use", async () => {
		const { leo, fam } = await family();
		const session = await makeSession(leo, fam, "one");
		const row = await as(leo, async (ctx) => {
			const held = await ctx.get(SessionObject, { workspace: session, thing: session });
			return until(held.row, () => true, within("the row", ctx));
		});
		assert.deepEqual(Object.keys(row).sort(), [
			"archivedAt",
			"createdAt",
			"id",
			"lastTouch",
			"location",
			"model",
			"state",
		]);
		assert.deepEqual([row.id, row.state, row.archivedAt, row.model], [session, "settled", null, null]);
		// Its name and place are its thing's (Fable, round 1).
		const placed = (await store.workspaces.one.page({ workspace: session }, 1, context)).items[0];
		assert.deepEqual([placed?.name, placed?.parent], ["one", fam]);
		const machine = await seeded(await w.host.get(OneThing, { kind: MACHINE_KIND }, context), context);
		assert.deepEqual(row.location, { machine, folder: join(dataDir, "work", pi, session) });
		assert.ok((await stat(row.location.folder)).isDirectory());
		await assert.rejects(
			makeSession(leo, fam, "two", { location: { machine: "nowhere", folder: "/tmp" } }),
			// R41: no answer on a thing not here (Opus M1, round 1); the store's kind check is behind it.
			/machine nowhere is not available/,
		);
	});

	// Opus, round 5: a session on a machine its maker is not let in on could not show them its files or terminals.
	it("refuses a location on a machine its maker is not let in on where the session is made", async () => {
		const { leo, fam } = await family();
		const machine = await seeded(await w.host.get(OneThing, { kind: MACHINE_KIND }, context), context);
		const at = { location: { machine, folder: "/tmp" } };
		await makeSession(leo, fam, "one", at);
		const party = { kind: "person", person: leo.id } as const;
		await store.setGrants(
			{ source: BY, grants: [{ workspace: fam, thing: machine, party, tick: OPEN, gives: false }] },
			context,
		);
		await assert.rejects(makeSession(leo, fam, "two", at), /machine .* is not available/);
	});
});

describe("archiving and unlinking (2)", () => {
	it("archives with the session's Manage; unlinks with Link in the parent, the row going with it", async () => {
		const { leo, fam } = await family();
		const kim = await person("Kim");
		await put(fam, kim);
		const session = await makeSession(leo, fam, "one");
		await as(kim, async (ctx) => {
			const held = await ctx.get(SessionObject, { workspace: session, thing: session });
			assert.equal(held.archive, undefined);
			assert.equal(held.setModel, undefined);
		});
		await as(leo, async (ctx) => {
			const held = withGranted(await ctx.get(SessionObject, { workspace: session, thing: session }), "archive")!;
			await held.archive(ctx);
			await until(held.row, (row) => row.archivedAt !== null, within("the archive", ctx));
		});
		const sessions = await w.host.get(SessionsStore, {}, context);
		assert.equal((await sessions.sessions.one.page({ id: session }, 1, context)).items.length, 1);
		await own(fam, party(leo), ["link"]);
		await as(leo, async (ctx) => {
			const workspace = withGranted(await ctx.get(Workspace, { workspace: fam }), "unlink")!;
			await workspace.unlink({ thing: session }, ctx);
		});
		// The row goes with the workspace's thing (its delete hook, after the removal's commits); the kinds are told once.
		await eventually(
			async () => (await sessions.sessions.one.page({ id: session }, 1, context)).items.length,
			(rows) => rows === 0,
		);
		await eventually(
			() => SESSION.gone.filter((gone) => gone === session).length,
			(told) => told === 1,
		);
	});

	// Astra, round 1 (must 4), as decided: an archive is one commit of the row; the kinds keep what they keep for the
	// session (its terminals) until it is unlinked, so a restore is immediate and finds them.
	it("archives and restores in one commit each, telling no kind; the model is set with Manage", async () => {
		const { leo, fam } = await family();
		const session = await makeSession(leo, fam, "one");
		const model = { login: "a-login", model: "claude", thinking: "high" } as const;
		await as(leo, async (ctx) => {
			const held = withGranted(
				await ctx.get(SessionObject, { workspace: session, thing: session }),
				"archive",
				"restore",
				"setModel",
			)!;
			await held.archive(ctx);
			await until(held.row, (row) => row.archivedAt !== null, within("the archive", ctx));
			await held.restore(ctx);
			await until(held.row, (row) => row.archivedAt === null, within("the restore", ctx));
			await held.setModel({ model }, ctx);
			await until(held.row, (row) => row.model?.model === "claude", within("the model", ctx));
		});
		assert.deepEqual(SESSION.gone, []);
	});

	// Astra, round 1.
	it("denies a held session cleanly once it is removed", async () => {
		const { leo, fam } = await family();
		const session = await makeSession(leo, fam, "one");
		await as(leo, async (ctx) => {
			const held = await ctx.get(SessionObject, { workspace: session, thing: session });
			await store.removeWorkspace({ workspace: session }, context);
			await until(
				held.state,
				(state) => state.kind === "failed" && state.cause.kind === "denied",
				within("the denial", ctx),
			);
		});
		assert.deepEqual(w.errors, []);
	});
});

describe("the owner and a private session (3)", () => {
	it("the owner opens a private session someone else made, and a thing switched off in it is off for them", async () => {
		const { leo, fam } = await family();
		const owner = await person("Olga");
		await store.setOwner({ person: owner.id, owner: true }, context);
		await defaultsIn(fam, PRIVATE);
		const session = await makeSession(leo, fam, "private");
		const mine = await answerOn(session, `person:${owner.id}`);
		for (const tick of ["read", "send", "stop", "manage"]) assert.ok(mine?.ticks.includes(tick), tick);
		const board = await store.create({ kind: "test.board", name: "b", workspace: fam, by: BY }, context);
		assert.notEqual(
			(await w.host.get(Gives, { workspace: session, caller: `person:${owner.id}` }, context)).answers.value[board],
			undefined,
		);
		await store.setSwitch({ workspace: session, item: { kind: "thing", thing: board }, shown: false }, context);
		await eventually(
			async () =>
				(await w.host.get(Gives, { workspace: session, caller: `person:${owner.id}` }, context)).answers.value[
					board
				],
			(answer) => answer === undefined,
		);
	});
});

/** Withholds `tick` on `thing` from `who` in `workspace` (a switch from below). */
const withhold = (workspace: string, thing: string, who: Party, tick: string) =>
	store.setGrants({ source: BY, grants: [{ workspace, thing, party: who, tick, gives: false }] }, context);

/** Runs `fn` as `who` with session `session`'s object, with what Manage gives (`undefined`: not granted). */
function managing<T>(
	who: P3Principal,
	session: string,
	fn: (held: ManagedSession | undefined, ctx: Ctx<P3Principal>) => Promise<T>,
): Promise<T> {
	return as(who, async (ctx) => {
		const held = await ctx.get(SessionObject, { workspace: session, thing: session });
		return fn(withGranted(held, "moveLocation", "detail"), ctx);
	});
}

/** A session's object with what Manage gives. */
type ManagedSession = NonNullable<
	ReturnType<typeof withGranted<Reference<typeof SessionObject>, "moveLocation" | "detail">>
>;

describe("a location per conversation (8)", () => {
	it("moves a conversation with Manage; the detail and the session's worker see it, a second move replaces it", async () => {
		const { leo, fam } = await family();
		const session = await makeSession(leo, fam, "one");
		const machine = await seeded(await w.host.get(OneThing, { kind: MACHINE_KIND }, context), context);
		const detail = await managing(leo, session, async (held, ctx) => {
			await held!.moveLocation({ conversation: "2", location: { machine, folder: "/srv" } }, ctx);
			return until(held!.detail, (value) => value.locations["2"] !== undefined, within("the detail", ctx));
		});
		assert.deepEqual(detail.locations, { "2": { machine, folder: "/srv" } });
		const worker = { kind: "worker", session } as const;
		await as(worker, async (ctx) => {
			const facts = await ctx.get(SessionFacts, {});
			await facts.moveLocation({ conversation: "2", location: { machine, folder: "/srv/pi" } }, ctx);
			const moved = await until(
				facts.detail,
				({ locations }) => locations["2"]?.folder === "/srv/pi",
				within("the worker's move", ctx),
			);
			assert.deepEqual(Object.keys(moved.locations), ["2"]);
			// The session's own location is untouched: where every conversation not moved works.
			assert.deepEqual(facts.session.value?.location, { machine, folder: join(dataDir, "work", pi, session) });
		});
	});

	it("refuses a move unless the folder is a full path, the thing a machine, and the agents have Work on it", async () => {
		const { leo, fam } = await family();
		const session = await makeSession(leo, fam, "one");
		const machine = await seeded(await w.host.get(OneThing, { kind: MACHINE_KIND }, context), context);
		const board = await store.create({ kind: "test.board", name: "b", workspace: fam, by: BY }, context);
		const move = (location: { machine: string; folder: string }) =>
			managing(leo, session, (held, ctx) => held!.moveLocation({ conversation: "1", location }, ctx));
		await assert.rejects(move({ machine, folder: "srv" }), /no full path/);
		// Fable, round 1: a conversation's id has one spelling ("01" was stored, and read by nobody).
		await refused(
			managing(leo, session, (held, ctx) =>
				held!.moveLocation({ conversation: "01", location: { machine, folder: "/srv" } }, ctx),
			),
			"invalid",
		);
		// A thing not here is not available to the person; one here that is no machine is no machine.
		await refused(move({ machine: "nowhere", folder: "/srv" }), "forbidden", "notHere");
		await assert.rejects(move({ machine: board, folder: "/srv" }), new RegExp(`no machine ${board}`));
		await withhold(session, machine, { kind: "agents" }, "work");
		await refused(move({ machine, folder: "/srv" }), "forbidden", "noWork");
		// The session's worker is refused the same: the check is the store's.
		await as({ kind: "worker", session }, async (ctx) => {
			const facts = await ctx.get(SessionFacts, {});
			const location = { machine, folder: "/srv" };
			await refused(facts.moveLocation({ conversation: "1", location }, ctx), "forbidden", "noWork");
		});
		const sessions = await w.host.get(SessionsStore, {}, context);
		assert.equal(await sessions.moved.get(Session({ id: session }), context), undefined);
	});

	// env4's addition (R41): a person points the agent only at a machine they are let in on themselves.
	it("refuses a person's move to a machine not available to them, though the agents have Work there", async () => {
		const { leo, fam } = await family();
		const session = await makeSession(leo, fam, "one");
		const machine = await seeded(await w.host.get(OneThing, { kind: MACHINE_KIND }, context), context);
		await withhold(session, machine, party(leo), OPEN);
		await refused(
			managing(leo, session, (held, ctx) =>
				held!.moveLocation({ conversation: "1", location: { machine, folder: "/srv" } }, ctx),
			),
			"forbidden",
			"notHere",
		);
	});

	// Round 1's decision (Opus S2, Fable S2): a move can be undone, and the conversation follows its owner again.
	it("undoes a move: the conversation has no location of its own any more", async () => {
		const { leo, fam } = await family();
		const session = await makeSession(leo, fam, "one");
		const machine = await seeded(await w.host.get(OneThing, { kind: MACHINE_KIND }, context), context);
		await managing(leo, session, async (held, ctx) => {
			await held!.moveLocation({ conversation: "2", location: { machine, folder: "/srv" } }, ctx);
			await held!.moveLocation({ conversation: "3", location: { machine, folder: "/srv" } }, ctx);
			await held!.moveLocation({ conversation: "2", location: null }, ctx);
			const detail = await until(
				held!.detail,
				(value) => value.locations["2"] === undefined,
				within("the undo", ctx),
			);
			assert.deepEqual(Object.keys(detail.locations), ["3"]);
		});
	});

	// Opus S3, round 1: the worker's path, for a thing no machine and one not linked in the session at all; Astra, round
	// 2: one not there is the machine kind's refusal, as for a person and in Files.
	it("refuses the worker's move to a thing that is no machine or is not there", async () => {
		const { leo, fam } = await family();
		const session = await makeSession(leo, fam, "one");
		const board = await store.create({ kind: "test.board", name: "b", workspace: fam, by: BY }, context);
		await as({ kind: "worker", session }, async (ctx) => {
			const facts = await ctx.get(SessionFacts, {});
			const move = (machine: string) =>
				facts.moveLocation({ conversation: "1", location: { machine, folder: "/srv" } }, ctx);
			await assert.rejects(move(board), new RegExp(`no machine ${board}`));
			await assert.rejects(move("nowhere"), (error: unknown) => isChordError(error) && error.code === "forbidden");
		});
	});

	// Opus M1, round 1 (R41): making a session is a choice of machine too.
	it("makes a session only on a machine its maker may use there; none given, on no machine if this device is not", async () => {
		const { leo, fam } = await family();
		const machine = await seeded(await w.host.get(OneThing, { kind: MACHINE_KIND }, context), context);
		await withhold(fam, machine, party(leo), OPEN);
		await assert.rejects(
			makeSession(leo, fam, "given", { location: { machine, folder: "/srv" } }),
			/not available to the caller/,
		);
		const session = await makeSession(leo, fam, "default");
		const row = await as(leo, async (ctx) => {
			const held = await ctx.get(SessionObject, { workspace: session, thing: session });
			return until(held.row, () => true, within("the row", ctx));
		});
		assert.equal(row.location, null, "no machine: its agent has no environment until a conversation is moved");
	});

	it("gives no move and no detail without Manage", async () => {
		const { leo, fam } = await family();
		const kim = await person("Kim");
		await put(fam, kim);
		const session = await makeSession(leo, fam, "one");
		// The shared defaults: Kim reads and sends, nothing more.
		await managing(kim, session, async (held) => assert.equal(held, undefined));
		await as(kim, async (ctx) => {
			const held = await ctx.get(SessionObject, { workspace: session, thing: session });
			assert.equal(held.moveLocation, undefined);
		});
	});

	// Fable, round 1: the bound had no case.
	it(
		"refuses the 1001st moved conversation of a session; one moved before still moves",
		{ timeout: 60_000 },
		async () => {
			const { leo, fam } = await family();
			const session = await makeSession(leo, fam, "one");
			const machine = await seeded(await w.host.get(OneThing, { kind: MACHINE_KIND }, context), context);
			const sessions = await w.host.get(SessionsStore, {}, context);
			const move = (conversation: number, folder: string) =>
				sessions.moveLocation(
					{ session, conversation: String(conversation), location: { machine, folder } },
					context,
				);
			for (let conversation = 1; conversation <= 1000; conversation++) await move(conversation, "/srv");
			await assert.rejects(move(1001, "/srv"), /has 1000 moved/);
			await move(7, "/srv/pi");
			// A move undone frees its place (round 1's decision: the bound is one of live moves).
			await sessions.moveLocation({ session, conversation: "8", location: null }, context);
			await move(1001, "/srv");
			const moved = await sessions.moved.get(Session({ id: session }), context);
			assert.deepEqual(moved?.locations["7"], { machine, folder: "/srv/pi" });
			assert.equal(Object.keys(moved?.locations ?? {}).length, 1000);
		},
	);

	it("drops a session's moved conversations with its row", async () => {
		const { leo, fam } = await family();
		const session = await makeSession(leo, fam, "one");
		const machine = await seeded(await w.host.get(OneThing, { kind: MACHINE_KIND }, context), context);
		await managing(leo, session, (held, ctx) =>
			held!.moveLocation({ conversation: "3", location: { machine, folder: "/srv" } }, ctx),
		);
		const sessions = await w.host.get(SessionsStore, {}, context);
		await store.removeWorkspace({ workspace: session }, context);
		await eventually(
			() => sessions.moved.get(Session({ id: session }), context),
			(moved) => moved === undefined,
		);
	});
});

describe("the session defaults", () => {
	it("shared (Pi's seeded defaults): everyone here gets Read and Send, people from above are shown", async () => {
		const { leo, fam } = await family();
		const anna = await person("Anna");
		await put(fam, anna);
		const session = await makeSession(leo, fam, "shared");
		assert.deepEqual((await answerOn(session, `person:${anna.id}`))?.ticks.sort(), ["read", "send"]);
	});

	it("private (3): no grant for everyone and people from above hidden; the maker is in it with every tick", async () => {
		const { leo, fam } = await family();
		const anna = await person("Anna");
		await put(fam, anna);
		await defaultsIn(fam, PRIVATE);
		const session = await makeSession(leo, fam, "private");
		assert.equal(await answerOn(session, `person:${anna.id}`), undefined);
		assert.ok((await answerOn(session, `person:${leo.id}`))?.ticks.includes("manage"));
		const line = (await store.workspaces.one.page({ workspace: session }, 1, context)).items[0];
		assert.equal(line?.showsPeople, false);
	});

	it("the nearest of two applies (75), its model copied into the row and its view into the session's own", async () => {
		const { leo, fam } = await family();
		const model = { login: "a-login", model: "claude", thinking: "high" } as const;
		await defaultsIn(pi, { model: null, shared: true, opensWith: null });
		await defaultsIn(fam, { model, shared: true, opensWith: "transcript.session" });
		const near = await makeSession(leo, fam, "near");
		const sessions = await w.host.get(SessionsStore, {}, context);
		assert.deepEqual((await sessions.sessions.one.page({ id: near }, 1, context)).items[0]?.model, model);
		assert.equal((await store.things.one.page({ thing: near }, 1, context)).items[0]?.view, "transcript.session");
		const robot = await store.createWorkspace(
			{ kind: WorkspaceKind.name, name: "Robot", parent: fam, by: BY },
			context,
		);
		await put(robot, leo);
		await own(robot, party(leo), [makeTick(SessionKind)]);
		await defaultsIn(robot, PRIVATE);
		const nearer = await makeSession(leo, robot, "nearer");
		assert.equal((await store.workspaces.one.page({ workspace: nearer }, 1, context)).items[0]?.showsPeople, false);
		assert.equal((await sessions.sessions.one.page({ id: nearer }, 1, context)).items[0]?.model, null);
	});
	// Fable, round 1: `nearestDefaults` read at most 1000 links per workspace (by thing id) and fell back to shared.
	it("applies a private default linked beside more than 1000 other things", { timeout: 120_000 }, async () => {
		const { leo, fam } = await family();
		const anna = await person("Anna");
		await put(fam, anna);
		let defaults = await defaultsIn(fam, PRIVATE);
		// An id in the upper quarter, so 1000 things sorting before it come quickly.
		while (defaults < "c") {
			await store.unlink({ workspace: fam, thing: defaults }, context);
			defaults = await defaultsIn(fam, PRIVATE);
		}
		for (let before = 0; before < 1000; ) {
			const board = await store.create({ kind: Board.name, name: "b", workspace: fam, by: BY }, context);
			if (board < defaults) before++;
		}
		const session = await makeSession(leo, fam, "private");
		assert.equal(await answerOn(session, `person:${anna.id}`), undefined);
	});

	// Astra, round 1 (must 2): making a session in a private-by-default workspace with the add dialog untouched (it
	// sends no defaults) works, and writes no grant for everyone.
	it("makes a private session with the add dialog's untouched defaults, with no grant row for everyone", async () => {
		const { leo, fam } = await family();
		await defaultsIn(fam, PRIVATE);
		const session = await as(leo, async (ctx) => {
			const workspace = withGranted(await ctx.get(Workspace, { workspace: fam }), "make")!;
			return workspace.make({ kind: SessionKind.name, name: "one", input: {} }, ctx);
		});
		assert.equal((await store.workspaces.one.page({ workspace: session }, 1, context)).items[0]?.showsPeople, false);
		assert.deepEqual(
			w.rows("grants").filter((row) => row.workspace === session && row.partyKey === "everyone"),
			[],
		);
	});

	// Fable, page round 1: the dialog previews the kind's declared defaults; Leo unticks the agents' Make there. The
	// removal is taken from what the create hook offers (a private session's), never refused.
	it("makes a private session when the person unticked a default in the add dialog", async () => {
		const { leo, fam } = await family();
		await defaultsIn(fam, PRIVATE);
		const session = await as(leo, async (ctx) => {
			const workspace = withGranted(await ctx.get(Workspace, { workspace: fam }), "make")!;
			const defaults = { without: { everyone: ["read"], agents: ["@make:*"] } };
			return workspace.make({ kind: SessionKind.name, name: "touched", input: {}, defaults }, ctx);
		});
		assert.equal(typeof session, "string");
		assert.deepEqual(
			w
				.rows("grants")
				.filter((row) => row.workspace === session && row.thing === session && row.partyKey === "agents"),
			[],
		);
	});

	// Astra, round 1 (must 1): the defaults thing chosen is read while it is still the one.
	it("reads the defaults that apply when the nearest one is taken away during the read", async () => {
		const { fam } = await family();
		// Pi's seeded defaults, once seeding made them.
		const defaults = await seeded(await w.host.get(OneThing, { kind: SessionDefaultsKind.name }, context), context);
		const far = { shared: true, model: null, opensWith: "far" };
		const near = { shared: true, model: null, opensWith: "near" };
		await store.configure({ thing: defaults, settings: { defaults: far } }, context);
		const target = await defaultsIn(fam, near);
		await w.host.root(async (ctx) => {
			assert.deepEqual(await nearestDefaults(fam, ctx), near);
			// Right after the near defaults' settings were read, they are unlinked and gone: the lookup reads again.
			let once = true;
			const unlinked = async () => {
				await store.unlink({ workspace: fam, thing: target }, ctx);
				await eventually(
					async () =>
						(await w.host.get(Gives, { workspace: fam, caller: "server" }, context)).answers.value[target],
					(answer) => answer === undefined,
				);
			};
			const gate = new Proxy(ctx, {
				get: (base, key) => {
					const value = Reflect.get(base, key);
					if (key !== "get") return typeof value === "function" ? value.bind(base) : value;
					return async (type: { readonly name: string }, params: object) => {
						// A test's stand-in for the store's reference: Chord's types cannot name the plugin's own local.
						const got = (await ctx.get(type as never, params as never)) as unknown as {
							settings: { of: { page: (...args: unknown[]) => Promise<unknown> } };
						};
						if (type.name !== "sessions.defaults-settings") return got;
						const page = async (...args: unknown[]) => {
							const read = await got.settings.of.page(...args);
							if (once) {
								once = false;
								await unlinked();
							}
							return read;
						};
						return { ...got, settings: { of: { page } } };
					};
				},
			});
			assert.deepEqual(await nearestDefaults(fam, gate), far);
		}, context);
	});

	// Opus, round 2: the defaults available where the session is made, switches applied.
	it("passes over a nearer defaults thing hidden where the session is made", async () => {
		const { leo, fam } = await family();
		const anna = await person("Anna");
		await put(fam, anna);
		const hidden = await defaultsIn(fam, PRIVATE);
		const robot = await store.createWorkspace(
			{ kind: WorkspaceKind.name, name: "Robot", parent: fam, by: BY },
			context,
		);
		await put(robot, leo);
		await own(robot, party(leo), [makeTick(SessionKind)]);
		assert.equal(await answerOn(await makeSession(leo, robot, "before"), `person:${anna.id}`), undefined);
		await store.setSwitch({ workspace: robot, item: { kind: "thing", thing: hidden }, shown: false }, context);
		// Family's private defaults are hidden in Robot: Pi's shared ones apply.
		assert.ok(await answerOn(await makeSession(leo, robot, "after"), `person:${anna.id}`));
	});
});

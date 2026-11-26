// The rules as stories (ERNDL-1142's tests 3, the prototype's `examples.test.ts`), each on the same small world,
// written through `ThingsStore` and asked through `Gives`:
//
//   Pi                        the coding tools (a board here) are linked; Mario has the owner flag
//   ├── Team                  Ada is put in; the Sketch is linked here
//   │   └── Fix the build     a session: its agent is put in; hides the coding tools; takes Draw from the agents
//   └── Club                  the groups coaches (Jo, Kim) and players (Jo, Lu) are put in; the Plan is linked here

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { BACKGROUND_CONTEXT as context, type Reference } from "@earendil-works/p3/v1";
import { Gives, ThingsStore } from "../contract.server.ts";
import type { Party, Source } from "../contract.ts";
import { accessHere, answerOf, type GrantEntry, personCounts, type WorkspaceEntries } from "../rules.ts";
import { BOARD_PLUGIN, Board } from "./kinds.ts";
import { type World, world } from "./world.ts";

const MARIO: Source = { kind: "plugin", plugin: "mario" };
const KIND_PLUGIN: Source = { kind: "plugin", plugin: BOARD_PLUGIN };
const everyone: Party = { kind: "everyone" };
const agents: Party = { kind: "agents" };

/** The stories' world: ids of its workspaces, persons, groups and things. */
type Cast = {
	pi: string;
	team: string;
	fix: string;
	club: string;
	mario: string;
	ada: string;
	jo: string;
	kim: string;
	lu: string;
	coaches: string;
	players: string;
	tools: string;
	sketch: string;
	plan: string;
};

let w: World;
let store: Reference<typeof ThingsStore>;
let c: Cast;

/** A person party. */
const person = (id: string): Party => ({ kind: "person", person: id });

/** Writes one grant of `source`. */
function grant(workspace: string, thing: string, party: Party, ticks: string[], source: Source = MARIO) {
	return store.setGrants(
		{ source, grants: [{ workspace, thing, party, gives: true, ticks, takenAway: [] }] },
		context,
	);
}

/** Writes one take-away of `source`. */
function takeAway(workspace: string, thing: string, party: Party, ticks: string[], source: Source = MARIO) {
	return store.setGrants(
		{ source, grants: [{ workspace, thing, party, gives: false, ticks: [], takenAway: ticks }] },
		context,
	);
}

/** What `caller` (`person:<id>` or `worker:<session>`) gets for `thing` in `workspace`: its ticks, or none. */
async function ticks(workspace: string, thing: string, caller: string): Promise<string[] | undefined> {
	const gives = await w.host.get(Gives, { workspace, caller }, context);
	try {
		return gives.answers.value[thing]?.ticks;
	} finally {
		gives.release();
	}
}

/** Makes a board `name` in `workspace`, by a plugin (no maker's grant), with the kind's default grants replaced by `ticks`. */
async function board(workspace: string, name: string, ticksOf: { everyone: string[]; agents: string[] }) {
	const thing = await store.create(
		{ kind: Board.name, name, workspace, by: { kind: "plugin", plugin: "test" } },
		context,
	);
	await grant(workspace, thing, everyone, ticksOf.everyone, KIND_PLUGIN);
	await grant(workspace, thing, agents, ticksOf.agents, KIND_PLUGIN);
	return thing;
}

beforeEach(async () => {
	w = await world(context);
	store = await w.host.get(ThingsStore, {}, context);
	const by: Source = { kind: "plugin", plugin: "test" };
	const [root] = (await store.workspaces.children.page({ parent: "" }, 1, context)).items;
	const pi = root!.workspace;
	const space = (name: string, parent: string) =>
		store.createWorkspace({ kind: "things.workspace", name, parent, by }, context);
	const team = await space("Team", pi);
	const fix = await space("Fix the build", team);
	const club = await space("Club", pi);
	const make = (name: string) => store.createPerson({ name, madeBy: by }, context);
	const [mario, ada, jo, kim, lu] = [
		await make("Mario"),
		await make("Ada"),
		await make("Jo"),
		await make("Kim"),
		await make("Lu"),
	];
	await store.setOwner({ person: mario, owner: true }, context);
	const coaches = await store.makeGroup({ name: "coaches", managedBy: { kind: "people" }, outside: false }, context);
	const players = await store.makeGroup({ name: "players", managedBy: { kind: "people" }, outside: false }, context);
	for (const [group, member] of [
		[coaches, jo],
		[coaches, kim],
		[players, jo],
		[players, lu],
	] as const) {
		await store.addToGroup({ group, person: member, source: by }, context);
	}
	await store.putParty({ workspace: team, party: person(ada), source: by }, context);
	await store.putParty({ workspace: fix, party: { kind: "agent", session: fix }, source: by }, context);
	await store.putParty({ workspace: club, party: { kind: "group", group: coaches }, source: by }, context);
	await store.putParty({ workspace: club, party: { kind: "group", group: players }, source: by }, context);
	const tools = await board(pi, "Coding tools", { everyone: ["read", "write"], agents: ["read", "write", "bash"] });
	const sketch = await board(team, "Sketch", { everyone: ["draw"], agents: ["draw"] });
	const plan = await board(club, "Plan", { everyone: [], agents: [] });
	await grant(club, plan, { kind: "group", group: coaches }, ["write", "draw"]);
	await grant(club, plan, { kind: "group", group: players }, []);
	await takeAway(fix, sketch, agents, ["draw"]);
	await store.setSwitch({ workspace: fix, item: { kind: "thing", thing: tools }, shown: false }, context);
	c = { pi, team, fix, club, mario, ada, jo, kim, lu, coaches, players, tools, sketch, plan };
});

afterEach(() => w.close(context));

describe("what the parties get", () => {
	it("Ada's own grant replaces everyone's (precedence, 73): it must name Draw and Moderate (scenario 2)", async () => {
		assert.deepEqual(await ticks(c.fix, c.sketch, `person:${c.ada}`), ["draw"]);
		await grant(c.team, c.sketch, person(c.ada), ["moderate"]);
		assert.deepEqual(await ticks(c.fix, c.sketch, `person:${c.ada}`), ["moderate"]);
		await grant(c.team, c.sketch, person(c.ada), ["draw", "moderate"]);
		assert.deepEqual(await ticks(c.fix, c.sketch, `person:${c.ada}`), ["draw", "moderate"]);
	});

	it("two sources' grants for one party add up; removing one leaves the other", async () => {
		await grant(c.team, c.sketch, person(c.ada), ["moderate"]);
		await grant(c.team, c.sketch, person(c.ada), ["write"], { kind: "plugin", plugin: "review" });
		assert.deepEqual(await ticks(c.team, c.sketch, `person:${c.ada}`), ["moderate", "write"]);
		await store.deleteEverythingFrom({ source: MARIO }, context);
		assert.deepEqual(await ticks(c.team, c.sketch, `person:${c.ada}`), ["write"]);
	});

	it("two groups add up; a grant of no tick lets its party in (scenario 10, R10)", async () => {
		assert.deepEqual(await ticks(c.club, c.plan, `person:${c.kim}`), ["draw", "write"]);
		assert.deepEqual(await ticks(c.club, c.plan, `person:${c.lu}`), []);
		assert.deepEqual(await ticks(c.club, c.plan, `person:${c.jo}`), ["draw", "write"]);
		// Everyone here's empty grant also lets in: a person put in alone sees the plan.
		await store.putParty({ workspace: c.club, party: person(c.ada), source: MARIO }, context);
		assert.deepEqual(await ticks(c.club, c.plan, `person:${c.ada}`), []);
		await store.setGrants(
			{
				source: KIND_PLUGIN,
				grants: [{ workspace: c.club, thing: c.plan, party: everyone, gives: false, ticks: [], takenAway: [] }],
			},
			context,
		);
		assert.equal(await ticks(c.club, c.plan, `person:${c.ada}`), undefined);
	});

	it("a member who is also a guest loses nothing (scenario 9)", async () => {
		const guests = await store.makeGroup(
			{ name: "guests", managedBy: { kind: "thing", thing: "share" }, outside: true },
			context,
		);
		const share: Source = { kind: "thing", thing: "share" };
		await store.putParty({ workspace: c.fix, party: { kind: "group", group: guests }, source: share }, context);
		// Kim put in by hand: the membership goes with the group, whoever wrote it.
		await store.addToGroup({ group: guests, person: c.kim, source: { kind: "plugin", plugin: "test" } }, context);
		await store.addToGroup({ group: guests, person: c.ada, source: share }, context);
		await grant(c.team, c.sketch, { kind: "group", group: guests }, ["read"], share);
		assert.deepEqual(await ticks(c.fix, c.sketch, `person:${c.kim}`), ["read"]);
		assert.deepEqual(await ticks(c.fix, c.sketch, `person:${c.ada}`), ["draw", "read"]);
		// Deleting the share takes its group with everything naming it.
		await store.deleteEverythingFrom({ source: share }, context);
		assert.equal(await ticks(c.fix, c.sketch, `person:${c.kim}`), undefined);
		assert.deepEqual(await ticks(c.fix, c.sketch, `person:${c.ada}`), ["draw"]);
		assert.deepEqual((await store.groups.one.page({ group: guests }, 1, context)).items, []);
	});
});

describe("below a link only less", () => {
	it("the agents lose Draw in Fix the build; a person keeps it; a giving grant below is refused (scenario 4, R15)", async () => {
		// The agents' grant is still there, with no tick left: the agent is let in without any (R10).
		assert.deepEqual(await ticks(c.fix, c.sketch, `worker:${c.fix}`), []);
		await store.putParty({ workspace: c.team, party: { kind: "agent", session: "setup" }, source: MARIO }, context);
		assert.deepEqual(await ticks(c.team, c.sketch, "worker:setup"), ["draw"]);
		assert.deepEqual(await ticks(c.fix, c.sketch, `person:${c.ada}`), ["draw"]);
		await assert.rejects(
			grant(c.fix, c.sketch, person(c.ada), ["moderate"]),
			(error: Error & { details?: { message?: { key: string } } }) => error.details?.message?.key === "belowLink",
		);
	});

	it("a take-away naming a person removes the tick by every route (73), only for whom counts as that person", async () => {
		await takeAway(c.fix, c.sketch, person(c.ada), ["draw"]);
		assert.deepEqual(await ticks(c.fix, c.sketch, `person:${c.ada}`), []);
		assert.deepEqual(await ticks(c.team, c.sketch, `person:${c.ada}`), ["draw"]);
		// Kim counts only through her group in Club: a take-away naming her does not apply there.
		await takeAway(c.club, c.plan, person(c.kim), ["write"]);
		assert.deepEqual(await ticks(c.club, c.plan, `person:${c.kim}`), ["draw", "write"]);
	});

	it("unlink takes the link's grants; a take-away further below stays and applies again when it comes back (scenario 14)", async () => {
		await store.link({ workspace: c.club, thing: c.sketch, by: MARIO }, context);
		await store.unlink({ workspace: c.team, thing: c.sketch }, context);
		assert.equal(await ticks(c.fix, c.sketch, `person:${c.ada}`), undefined);
		const left = (await store.grants.ofThing.page({ thing: c.sketch }, 10, context)).items;
		assert.deepEqual(
			left.filter((g) => g.workspace === c.team),
			[],
		);
		assert.equal(left.filter((g) => g.workspace === c.fix).length, 1);
		await store.link({ workspace: c.pi, thing: c.sketch, by: MARIO }, context);
		await store.putParty({ workspace: c.pi, party: { kind: "agent", session: c.fix }, source: MARIO }, context);
		// Pi's default grants give the agents Draw; Fix the build's take-away removes it again.
		assert.deepEqual(await ticks(c.pi, c.sketch, `worker:${c.fix}`), ["read"]);
		assert.deepEqual(await ticks(c.fix, c.sketch, `worker:${c.fix}`), ["read"]);
		// The last link goes: the thing goes, with every grant.
		await store.unlink({ workspace: c.pi, thing: c.sketch }, context);
		await store.unlink({ workspace: c.club, thing: c.sketch }, context);
		assert.deepEqual((await store.things.one.page({ thing: c.sketch }, 1, context)).items, []);
		assert.deepEqual((await store.grants.ofThing.page({ thing: c.sketch }, 10, context)).items, []);
	});
});

describe("what is here, who is here", () => {
	it("the coding tools are switched off in Fix the build: gone there and below; a switch below cannot show them", async () => {
		const sub = await store.createWorkspace(
			{ kind: "things.workspace", name: "sub", parent: c.fix, by: MARIO },
			context,
		);
		await store.setSwitch({ workspace: sub, item: { kind: "thing", thing: c.tools }, shown: true }, context);
		assert.deepEqual(await ticks(c.team, c.tools, `person:${c.ada}`), ["read", "write"]);
		assert.equal(await ticks(c.fix, c.tools, `person:${c.ada}`), undefined);
		assert.equal(await ticks(sub, c.tools, `person:${c.ada}`), undefined);
	});

	it("a people switch on a person hides them by every route, until a workspace below puts them in (73)", async () => {
		// Jo is in Club through both groups; one switch hides him there.
		await store.setSwitch({ workspace: c.club, item: { kind: "party", party: person(c.jo) }, shown: false }, context);
		assert.equal(await ticks(c.club, c.plan, `person:${c.jo}`), undefined);
		assert.deepEqual(await ticks(c.club, c.plan, `person:${c.kim}`), ["draw", "write"]);
		const below = await store.createWorkspace(
			{ kind: "things.workspace", name: "below", parent: c.club, by: MARIO },
			context,
		);
		assert.equal(await ticks(below, c.plan, `person:${c.jo}`), undefined);
		await store.putParty({ workspace: below, party: person(c.jo), source: MARIO }, context);
		assert.deepEqual(await ticks(below, c.plan, `person:${c.jo}`), ["draw", "write"]);
	});

	it("a private session: people from above hidden until a switch shows one", async () => {
		const own = await store.createWorkspace(
			{ kind: "things.workspace", name: "private", parent: c.team, by: MARIO, showsPeople: false },
			context,
		);
		assert.equal(await ticks(own, c.sketch, `person:${c.ada}`), undefined);
		await store.setSwitch({ workspace: own, item: { kind: "party", party: person(c.ada) }, shown: true }, context);
		assert.deepEqual(await ticks(own, c.sketch, `person:${c.ada}`), ["draw"]);
	});
});

describe("the owner", () => {
	it("gets every tick for people on what is available, nothing on what is switched off (78, 99, scenario 11)", async () => {
		assert.deepEqual(await ticks(c.team, c.sketch, `person:${c.mario}`), [
			"draw",
			"look",
			"moderate",
			"read",
			"write",
		]);
		assert.equal(await ticks(c.fix, c.tools, `person:${c.mario}`), undefined);
		assert.equal(await ticks(c.pi, c.sketch, `person:${c.mario}`), undefined);
	});

	it("the flag handed over changes answers live; the last owner keeps it", async () => {
		await store.setOwner({ person: c.kim, owner: true }, context);
		assert.deepEqual((await ticks(c.team, c.sketch, `person:${c.kim}`))?.length, 5);
		await store.setOwner({ person: c.kim, owner: false }, context);
		assert.equal(await ticks(c.team, c.sketch, `person:${c.kim}`), undefined);
		await assert.rejects(
			store.setOwner({ person: c.mario, owner: false }, context),
			(error: Error & { details?: { message?: { key: string } } }) => error.details?.message?.key === "lastOwner",
		);
	});
});

describe("ticks and kinds", () => {
	it("a tick is given only to whom it is for (R2): refused when written, nothing when stored anyway", async () => {
		await assert.rejects(
			grant(c.team, c.sketch, person(c.ada), ["bash"]),
			(error: Error & { details?: { message?: { key: string } } }) => error.details?.message?.key === "tickNotFor",
		);
		await assert.rejects(grant(c.team, c.sketch, agents, ["look"]));
		await assert.rejects(grant(c.team, c.sketch, everyone, ["fly"]), /has no tick fly/);
		// The coding tools give the agents Bash (for agents); the maker's every tick, a person, leaves Bash out.
		await store.putParty({ workspace: c.pi, party: { kind: "agent", session: "pi-agent" }, source: MARIO }, context);
		assert.deepEqual(await ticks(c.pi, c.tools, "worker:pi-agent"), ["bash", "read", "write"]);
		const made = await store.create(
			{ kind: Board.name, name: "Ada's", workspace: c.team, by: { kind: "person", person: c.ada } },
			context,
		);
		assert.deepEqual(await ticks(c.team, made, `person:${c.ada}`), ["draw", "look", "moderate", "read", "write"]);
	});

	it("a session's agent that makes a thing gets every tick of it for agents (item 90)", async () => {
		const made = await store.create(
			{ kind: Board.name, name: "agent's", workspace: c.fix, by: { kind: "agent", session: c.fix } },
			context,
		);
		assert.deepEqual(await ticks(c.fix, made, `worker:${c.fix}`), ["bash", "draw", "moderate", "read", "write"]);
	});
});

describe("the rules alone", () => {
	/** A workspace's entries: nothing, then `own`. */
	const entries = (own: Partial<WorkspaceEntries>): WorkspaceEntries => ({
		parent: "",
		showsThings: true,
		showsPeople: true,
		links: new Map(),
		members: new Set(),
		switches: new Map(),
		hides: new Set(),
		grants: [],
		...own,
	});
	const lookup = { tickFor: () => "all" as const, ticksOf: () => ["draw", "read"] };
	const grantOf = (own: Partial<GrantEntry>): GrantEntry => ({
		thing: "sketch",
		party: "everyone",
		audience: "people",
		gives: true,
		ticks: [],
		takenAway: [],
		...own,
	});

	it("a giving grant stored below the link anyway counts for nothing", () => {
		const top = accessHere(
			{ things: new Map(), present: new Set(), hidden: new Set() },
			entries({
				links: new Map([["sketch", "k"]]),
				members: new Set(["person/ada"]),
				grants: [grantOf({ ticks: ["read"] })],
			}),
			lookup,
		);
		const below = accessHere(top, entries({ grants: [grantOf({ ticks: ["draw"] })] }), lookup);
		const ada = personCounts(below, "person/ada", { owner: false, groups: [] });
		assert.deepEqual(answerOf(below.things.get("sketch")!, ada), { ticks: ["read"] });
	});
});

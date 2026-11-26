// Workspaces (ERNDL-1143), case by case of the issue's tests: the tree and its paths; a workspace's own ticks, written
// at itself, counting there only (88); what comes down and what a switch hides (1); linking with Link here and where
// the thing is linked now (R9, scenario 5); who may change who may (scenario 6); unlinking and removing (scenario 7,
// test 9); the agent in its own session (R6, scenario 12); `makes` (114); a private workspace (115); default grants
// left ticked (93); making (90); stacking `nearest` (75). Every call goes through `Workspace` as its caller would make
// it, on a host with the things plugin, the test board and the workspace tests' kinds.

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
	arr,
	type Ctx,
	BACKGROUND_CONTEXT as context,
	createHost,
	defineFacet,
	local,
	memoryLinkPair,
	type P3Principal,
	type PluginFacet,
	type Reference,
	str,
	until,
} from "@earendil-works/p3/v1";
import { collected, eventually, within } from "../../../test/until.ts";
import { Gives, ThingsStore } from "../contract.server.ts";
import { MAKE_ANY, makeTick, type Party, type Source } from "../contract.ts";
import { make, thingsOfKind } from "../kind-server.ts";
import {
	Linkable,
	Roots,
	ThingInfo,
	WhoMay,
	Workspace,
	WorkspaceChildren,
	WorkspaceContents,
	WorkspacePeople,
} from "../workspace.ts";
import { WorkspaceKind } from "../workspaces.ts";
import { BOARD, BOARD_PLUGIN, Board, Defaults, Login, SESSION, SPACES, TestSession } from "./kinds.ts";
import { answersFrom, kindTicksOf, readEverything } from "./reference.ts";
import { type World, world } from "./world.ts";

const BY: Source = { kind: "plugin", plugin: "test" };

/** Server code following the boards available in a workspace (`thingsOfKind`). */
const Follower = local("test.follower", { version: 1, params: { workspace: str() }, members: { things: arr(str()) } });
const FOLLOWER: PluginFacet<P3Principal> = {
	name: "test-follower",
	facet: defineFacet((host) =>
		host.serve(Follower, ({ workspace }, self) => ({ things: thingsOfKind(Board, workspace, self) })),
	),
};

let w: World;
let store: Reference<typeof ThingsStore>;
let pi: string;

beforeEach(async () => {
	w = await world(context, [SPACES, FOLLOWER]);
	store = await w.host.get(ThingsStore, {}, context);
	pi = (await store.workspaces.children.page({ parent: "" }, 10, context)).items[0]!.workspace;
	SESSION.answer = undefined;
	SESSION.made.length = 0;
	SESSION.told.length = 0;
	SESSION.gone.length = 0;
	SESSION.goneFails = 0;
});

afterEach(() => w.close(context));

type Person = Extract<P3Principal, { kind: "person" }>;

/** A person principal. */
async function person(name: string): Promise<Person> {
	return { kind: "person", id: await store.createPerson({ name, madeBy: BY }, context), name };
}

const party = (who: Person): Party => ({ kind: "person", person: who.id });
const source = (who: Person): Source => ({ kind: "person", person: who.id });

/** Puts `who` into `workspace`. */
const put = (workspace: string, who: Person) => store.putParty({ workspace, party: party(who), source: BY }, context);

/** Gives `who` `ticks` on workspace `workspace`'s own thing (written at itself, item 88). */
const own = (workspace: string, who: Party, ticks: string[], gives = true) =>
	store.setGrants(
		{ source: BY, grants: ticks.map((tick) => ({ workspace, thing: workspace, party: who, tick, gives })) },
		context,
	);

/** A plain workspace under `parent`, made by `by`. */
const space = (parent: string, name: string, by: Source = BY) =>
	store.createWorkspace({ kind: WorkspaceKind.name, name, parent, by }, context);

/** Runs `fn` as `principal`. */
function as<T>(principal: P3Principal, fn: (ctx: Ctx<P3Principal>) => Promise<T>): Promise<T> {
	return w.host.root(fn, context, { principal });
}

/** `principal`'s `Workspace` of `workspace`, held for `fn`. */
function holding<T>(
	principal: P3Principal,
	workspace: string,
	fn: (ref: Reference<typeof Workspace>, ctx: Ctx<P3Principal>) => Promise<T>,
): Promise<T> {
	return as(principal, async (ctx) => fn(await ctx.get(Workspace, { workspace }), ctx));
}

/** What `workspace` gives `caller` (a caller key) now. */
async function answers(workspace: string, caller: string) {
	const gives = await w.host.get(Gives, { workspace, caller }, context);
	return gives.answers.value;
}

/** The workspace members `ref` has, of its grantable ones. */
const granted = (ref: Reference<typeof Workspace>) =>
	(["make", "link", "unlink", "hide", "setShowsThings", "configure", "putParty", "setTick"] as const).filter(
		(name) => ref[name] !== undefined,
	);

/** The Family tree of the scenarios: Pi, Family (Anna, Leo), Leo's robot (a session Leo made). */
async function family() {
	const anna = await person("Anna");
	const leo = await person("Leo");
	const fam = await space(pi, "Family");
	await put(fam, anna);
	await put(fam, leo);
	const robot = await store.createWorkspace(
		{ kind: TestSession.name, name: "Leo's robot", parent: fam, by: source(leo) },
		context,
	);
	return { anna, leo, fam, robot };
}

describe("the tree", () => {
	it("paths are right after every create (10): root first, itself last, and as text for a subtree", async () => {
		const { fam, robot } = await family();
		const lines = Object.fromEntries(
			(await store.workspaces.under.page({ pathPrefix: `${pi}/` }, 10, context)).items.map((row) => [
				row.workspace,
				row,
			]),
		);
		assert.deepEqual(lines[pi]!.path, [pi]);
		assert.deepEqual(lines[fam]!.path, [pi, fam]);
		assert.deepEqual(lines[robot]!.path, [pi, fam, robot]);
		assert.equal(lines[robot]!.pathText, `${pi}/${fam}/${robot}/`);
		assert.equal(lines[robot]!.kind, TestSession.name);
		assert.equal(lines[robot]!.name, "Leo's robot");
		const under = await store.workspaces.under.page({ pathPrefix: `${pi}/${fam}/` }, 10, context);
		assert.deepEqual(under.items.map((row) => row.workspace).toSorted(), [fam, robot].toSorted());
	});

	it("a leaf holds no workspaces", async () => {
		const { robot } = await family();
		await assert.rejects(space(robot, "inside"), /leaf/);
	});
});

describe("a workspace's own ticks (88)", () => {
	it("Anna has Hide in Family and none in Leo's robot: they do not come down (0)", async () => {
		const { anna, fam, robot } = await family();
		await own(fam, party(anna), ["hide"]);
		await holding(anna, fam, async (ref) => assert.deepEqual(granted(ref), ["hide", "setShowsThings"]));
		await holding(anna, robot, async (ref) => {
			assert.deepEqual(granted(ref), []);
			assert.equal(ref.info.value.name, "Leo's robot");
		});
	});

	it("a person not present is denied the workspace; present, they see it with no tick", async () => {
		const { fam } = await family();
		const kim = await person("Kim");
		await as(kim, async (ctx) =>
			assert.rejects(
				ctx.get(Workspace, { workspace: fam }, { readyTimeout: 200 }),
				/nothing|present|forbidden|denied/i,
			),
		);
		await put(fam, kim);
		await holding(kim, fam, async (ref) => {
			assert.deepEqual(granted(ref), []);
			assert.equal(ref.info.value.name, "Family");
		});
	});

	it("the info names the parent only where the caller is present (96)", async () => {
		const { leo, fam, robot } = await family();
		await holding(leo, robot, async (ref) =>
			assert.deepEqual(ref.info.value.parent, { workspace: fam, name: "Family" }),
		);
		// Leo is in Family, not in Pi: Family is one of his roots.
		await holding(leo, fam, async (ref) => assert.equal(ref.info.value.parent, undefined));
	});
});

describe("what comes down, what a switch hides (1)", () => {
	it("a sub-workspace has its parent's things and people; a switch hides there and below; none below shows it again", async () => {
		const { anna, leo, fam, robot } = await family();
		const tools = await store.create({ kind: Board.name, name: "coding tools", workspace: fam, by: BY }, context);
		await own(fam, party(anna), ["hide"]);
		await own(robot, party(leo), ["hide"]);
		assert.ok((await answers(robot, `person:${anna.id}`))[tools]);
		// Family linked it: a switch hides only what comes from above.
		await holding(anna, fam, (ref, ctx) =>
			assert.rejects(ref.hide!({ thing: tools, shown: false }, ctx), /from above/),
		);
		const sub = await space(fam, "sub");
		const kids = await space(sub, "kids");
		await own(sub, party(anna), ["hide"]);
		await holding(anna, sub, (ref, ctx) => ref.hide!({ thing: tools, shown: false }, ctx));
		assert.equal((await answers(sub, `person:${anna.id}`))[tools], undefined);
		assert.equal((await answers(kids, `person:${anna.id}`))[tools], undefined);
		await own(kids, party(anna), ["hide"]);
		await holding(anna, kids, (ref, ctx) => ref.hide!({ thing: tools, shown: true }, ctx));
		assert.equal((await answers(kids, `person:${anna.id}`))[tools], undefined);
		await holding(anna, sub, (ref, ctx) => ref.hide!({ thing: tools, shown: true }, ctx));
		assert.ok((await answers(kids, `person:${anna.id}`))[tools]);
	});
});

describe("linking (R9, scenario 5)", () => {
	it("Leo, with Link in his robot only, cannot link what Family hid; with Link in Pi too he can, and the nearer link decides", async () => {
		const { anna, leo, fam, robot } = await family();
		const tools = await store.create({ kind: Board.name, name: "coding tools", workspace: pi, by: BY }, context);
		await own(fam, party(anna), ["hide"]);
		await holding(anna, fam, (ref, ctx) => ref.hide!({ thing: tools, shown: false }, ctx));
		assert.equal((await answers(robot, `worker:${robot}`))[tools], undefined);
		await holding(leo, robot, (ref, ctx) => assert.rejects(ref.link!({ thing: tools }, ctx), /Link where/));
		await put(pi, leo);
		await own(pi, party(leo), ["link"]);
		await holding(leo, robot, (ref, ctx) => ref.link!({ thing: tools }, ctx));
		// The link in the robot decides there: its own default grants (the agents read).
		assert.deepEqual((await answers(robot, `worker:${robot}`))[tools]?.ticks, ["read"]);
		assert.equal((await answers(fam, `person:${leo.id}`))[tools], undefined);
	});

	it("a workspace is never linked: its parent places it (a kind of one workspace: store.test.ts)", async () => {
		const { fam, robot } = await family();
		await assert.rejects(store.link({ workspace: robot, thing: fam }, context), /placed by its parent/);
	});
});

describe("who may change who may (scenario 6)", () => {
	it("Leo made the comic but cannot change who moderates it; Anna, with Manage access, can: one row, Kim gets it", async () => {
		const { anna, leo, fam } = await family();
		const kim = await person("Kim");
		await put(fam, kim);
		await own(fam, party(leo), [makeTick(Board)]);
		await own(fam, party(anna), ["manageAccess"]);
		const comic = await holding(leo, fam, (ref, ctx) => ref.make!({ kind: Board.name, name: "Comic" }, ctx));
		await holding(leo, fam, async (ref) => assert.equal(ref.setTick, undefined));
		await holding(anna, fam, (ref, ctx) =>
			ref.setTick!({ thing: comic, party: party(kim), tick: "moderate", gives: true }, ctx),
		);
		const rows = w.rows("grants").filter((row) => row.thing === comic && String(row.party).includes(kim.id));
		assert.equal(rows.length, 1);
		assert.deepEqual((await answers(fam, `person:${kim.id}`))[comic]?.ticks, ["moderate", "read"]);
		// The cell set again by another source replaces the row; reset removes it.
		await holding(anna, fam, (ref, ctx) => ref.setTick!({ thing: comic, party: party(kim), tick: "moderate" }, ctx));
		assert.deepEqual((await answers(fam, `person:${kim.id}`))[comic]?.ticks, ["read"]);
		// A cell with a row of another source (the kind's default for everyone) is replaced by the caller's one row.
		await holding(anna, fam, (ref, ctx) =>
			ref.setTick!({ thing: comic, party: { kind: "everyone" }, tick: "read", gives: false }, ctx),
		);
		const everyoneRead = w
			.rows("grants")
			.filter((row) => row.thing === comic && row.tick === "read" && String(row.party).includes("everyone"));
		assert.deepEqual(
			everyoneRead.map((row) => [row.gives, JSON.parse(String(row.source)).kind]),
			[[0, "person"]],
		);
	});
});

describe("unlinking and removing (scenario 7, test 9)", () => {
	it("Leo unlinks the session he made while he has Link in Family; once it is withheld from him he cannot", async () => {
		const { leo, fam } = await family();
		await own(fam, party(leo), ["link", makeTick(TestSession)]);
		const first = await holding(leo, fam, (ref, ctx) => ref.make!({ kind: TestSession.name, name: "one" }, ctx));
		const second = await holding(leo, fam, (ref, ctx) => ref.make!({ kind: TestSession.name, name: "two" }, ctx));
		await holding(leo, fam, (ref, ctx) => ref.unlink!({ thing: first }, ctx));
		assert.equal((await store.workspaces.one.page({ workspace: first }, 1, context)).items.length, 0);
		await own(fam, party(leo), ["link"], false);
		await holding(leo, fam, async (ref) => assert.equal(ref.unlink, undefined));
		assert.equal((await store.workspaces.one.page({ workspace: second }, 1, context)).items.length, 1);
	});

	it("removing a workspace takes its subtree in background commits; things linked elsewhere stay; its kinds are told", async () => {
		const { anna, fam, robot } = await family();
		const kept = await store.create({ kind: Board.name, name: "kept", workspace: pi, by: BY }, context);
		const only = await store.create({ kind: Board.name, name: "only", workspace: robot, by: BY }, context);
		await store.link({ workspace: robot, thing: kept }, context);
		await store.setSwitch({ workspace: robot, item: { kind: "thing", thing: kept }, shown: false }, context);
		const owner = await person("Mario");
		await store.setOwner({ person: owner.id, owner: true }, context);
		await holding(owner, pi, (ref, ctx) => ref.unlink!({ thing: fam }, ctx));
		// At once the subtree gives nothing, also to those put in below (Leo in his robot, its agent).
		assert.deepEqual(await answers(robot, `person:${anna.id}`), {});
		const { leo } = { leo: (await store.workspaceMembers.here.page({ workspace: robot }, 10, context)).items };
		for (const { party: member } of leo) {
			const caller =
				member.kind === "person"
					? `person:${member.person}`
					: member.kind === "agent"
						? `worker:${member.session}`
						: "";
			if (caller !== "") assert.deepEqual(await answers(robot, caller), {}, caller);
		}
		await eventually(
			() => w.rows("workspaces").length + w.rows("removing").length,
			(left) => left === 1,
		).catch((error) => {
			console.log(w.rows("workspaces"), w.rows("removing"), w.errors);
			throw error;
		});
		for (const table of ["links", "grants", "switches", "workspace-members"]) {
			assert.equal(w.rows(table).filter((row) => row.workspace === fam || row.workspace === robot).length, 0, table);
		}
		assert.deepEqual(
			w
				.rows("things")
				.map((row) => row.thing)
				.filter((id) => [fam, robot, only, kept].includes(String(id))),
			[kept],
		);
		await eventually(
			() => SESSION.gone,
			(gone) => gone.includes(robot) && gone.includes(fam),
		);
		await eventually(
			() => w.rows("gone").length,
			(left) => left === 0,
		);
	});

	it("Pi is never removed", async () => {
		await assert.rejects(store.removeWorkspace({ workspace: pi }, context), /Pi/);
	});
});

describe("the agent in its own session (R6, scenario 12)", () => {
	it("makes a board, cannot undo a switch set in its session, cannot unlink", async () => {
		const { leo, robot } = await family();
		const agent: P3Principal = { kind: "worker", session: robot };
		const voice = await store.create({ kind: Board.name, name: "voice", workspace: pi, by: BY }, context);
		await own(robot, party(leo), ["hide"]);
		await holding(leo, robot, (ref, ctx) => ref.hide!({ thing: voice, shown: false }, ctx));
		const made = await holding(agent, robot, async (ref, ctx) => {
			assert.deepEqual(granted(ref), ["make"]);
			assert.deepEqual(ref.makes!.value, [Board.name, Defaults.name]);
			return ref.make!({ kind: Board.name, name: "drawing" }, ctx);
		});
		// The maker's grant names this session's agent (90): every tick for agents.
		assert.deepEqual((await answers(robot, `worker:${robot}`))[made]?.ticks, [
			"bash",
			"draw",
			"moderate",
			"read",
			"write",
		]);
		await holding(agent, robot, (ref, ctx) =>
			assert.rejects(ref.make!({ kind: Login.name, name: "login" }, ctx), /not made here/),
		);
	});
});

describe("makes (114)", () => {
	it("a people-only kind is never an agent's; MAKE_ANY covers a kind registered later; withholding one kind from Leo", async () => {
		const { leo, fam, robot } = await family();
		await own(fam, { kind: "everyone" }, [MAKE_ANY]);
		const leoFam = async () => (await answers(fam, `person:${leo.id}`))[fam]?.makes;
		assert.deepEqual(await leoFam(), [Board.name, Defaults.name, Login.name, TestSession.name, WorkspaceKind.name]);
		assert.deepEqual((await answers(robot, `worker:${robot}`))[robot]?.makes, [Board.name, Defaults.name]);
		await own(fam, party(leo), [makeTick(Board)], false);
		assert.deepEqual(await leoFam(), [Defaults.name, Login.name, TestSession.name, WorkspaceKind.name]);
		await own(fam, party(leo), [makeTick(Board)]);
		assert.deepEqual(await leoFam(), [Board.name, Defaults.name, Login.name, TestSession.name, WorkspaceKind.name]);
		// A kind's plugin gone: its Make tick stays stored and counts for nothing; MAKE_ANY beside it still works.
		await own(fam, party(leo), [makeTick(Board)]);
		await w.reload(
			BOARD_PLUGIN,
			context,
			defineFacet(() => undefined),
		);
		await until(
			(await w.host.get(Gives, { workspace: fam, caller: `person:${leo.id}` }, context)).answers,
			(given) => given[fam]?.makes?.includes(Board.name) === false,
			within("the board's plugin gone", context),
		);
		assert.deepEqual(await leoFam(), [Defaults.name, Login.name, TestSession.name, WorkspaceKind.name]);
		assert.ok(w.rows("grants").some((row) => row.tick === makeTick(Board) && row.gives === 1));
		await w.reload(BOARD_PLUGIN, context, BOARD.facet);
		await until(
			(await w.host.get(Gives, { workspace: fam, caller: `person:${leo.id}` }, context)).answers,
			(given) => given[fam]?.makes?.includes(Board.name) === true,
			within("the board's plugin back", context),
		);
	});

	it("a Make tick for a kind no plugin registers is kept and ignored (82, 91, 114); one for whom its kind's makers exclude is refused", async () => {
		const { leo, fam } = await family();
		await own(fam, party(leo), ["@make:nobody.nothing"]);
		assert.ok(w.rows("grants").some((row) => row.tick === "@make:nobody.nothing"));
		assert.deepEqual((await answers(fam, `person:${leo.id}`))[fam]?.makes, []);
		await assert.rejects(
			store.setGrants(
				{
					source: BY,
					grants: [{ workspace: fam, thing: fam, party: { kind: "agents" }, tick: makeTick(Login), gives: true }],
				},
				context,
			),
			/cannot be given/,
		);
	});
});

describe("a private workspace (115)", () => {
	it("Leo makes one with people from above hidden: he is in it with its ticks; Anna, added later, is not; the owner sees it", async () => {
		const { anna, leo, fam } = await family();
		const owner = await person("Mario");
		await store.setOwner({ person: owner.id, owner: true }, context);
		const mine = await store.createWorkspace(
			{ kind: WorkspaceKind.name, name: "mine", parent: fam, by: source(leo), showsPeople: false },
			context,
		);
		await holding(leo, mine, async (ref) =>
			assert.deepEqual(granted(ref), [
				"make",
				"link",
				"unlink",
				"hide",
				"setShowsThings",
				"configure",
				"putParty",
				"setTick",
			]),
		);
		assert.equal((await answers(mine, `person:${anna.id}`))[mine], undefined);
		const ben = await person("Ben");
		await put(fam, ben);
		assert.equal((await answers(mine, `person:${ben.id}`))[mine], undefined);
		assert.ok((await answers(mine, `person:${owner.id}`))[mine]);
	});

	it("a workspace kind's create hook may answer its default grants and its people default", async () => {
		const { anna, leo, fam } = await family();
		SESSION.answer = { defaultGrants: { agents: [MAKE_ANY] }, showsPeople: false };
		const secret = await store.createWorkspace(
			{ kind: TestSession.name, name: "secret", parent: fam, by: source(leo) },
			context,
		);
		assert.equal((await answers(secret, `person:${anna.id}`))[secret], undefined);
		const everyone = w.rows("grants").filter((row) => row.thing === secret && String(row.party).includes("everyone"));
		assert.equal(everyone.length, 0);
		assert.deepEqual((await answers(secret, `person:${leo.id}`))[secret]?.ticks, [
			"configure",
			"hide",
			"link",
			"manageAccess",
			"managePeople",
			"read",
			"send",
		]);
	});
});

describe("default grants left ticked (93)", () => {
	it("linking a board with the agents' Read unticked writes only everyone's", async () => {
		const { fam } = await family();
		const b = await store.create({ kind: Board.name, name: "b", workspace: pi, by: BY }, context);
		await store.link({ workspace: fam, thing: b, defaults: { everyone: ["read"], agents: [] } }, context);
		const rows = w.rows("grants").filter((row) => row.thing === b && row.workspace === fam);
		assert.deepEqual(
			rows.map((row) => JSON.parse(String(row.party)).kind),
			["everyone"],
		);
		await assert.rejects(
			store.link(
				{
					workspace: fam,
					thing: await store.create({ kind: Board.name, name: "c", workspace: pi, by: BY }, context),
					defaults: { everyone: ["draw"], agents: [] },
				},
				context,
			),
			/no default/,
		);
	});
});

describe("making (90)", () => {
	it("one commit: the thing, its link, the default grants, the maker's every tick; a workspace's maker is put in", async () => {
		const { leo, fam } = await family();
		await own(fam, party(leo), [makeTick(Board), makeTick(WorkspaceKind)]);
		const b = await holding(leo, fam, (ref, ctx) => ref.make!({ kind: Board.name, name: "b" }, ctx));
		const rows = w.rows("grants").filter((row) => row.thing === b);
		const by = (kind: string) =>
			rows
				.filter((row) => JSON.parse(String(row.party)).kind === kind)
				.map((row) => row.tick)
				.toSorted();
		assert.deepEqual(by("everyone"), ["read"]);
		assert.deepEqual(by("agents"), ["read"]);
		assert.deepEqual(by("person"), ["draw", "look", "moderate", "read", "write"]);
		const sub = await holding(leo, fam, (ref, ctx) => ref.make!({ kind: WorkspaceKind.name, name: "sub" }, ctx));
		const members = w.rows("workspace-members").filter((row) => row.workspace === sub);
		assert.deepEqual(
			members.map((row) => JSON.parse(String(row.party))),
			[party(leo)],
		);
		const mine = w
			.rows("grants")
			.filter((row) => row.thing === sub && row.workspace === sub)
			.map((row) => row.tick);
		assert.ok(mine.includes(MAKE_ANY));
		assert.ok(mine.includes("manageAccess"));
	});

	it("a leaf's agent is put in, and its session's agent gets the kind's default for agents there", async () => {
		const { robot } = await family();
		const members = w
			.rows("workspace-members")
			.filter((row) => row.workspace === robot)
			.map((row) => JSON.parse(String(row.party)));
		assert.ok(members.some((p) => p.kind === "agent" && p.session === robot));
		assert.ok((await answers(robot, `worker:${robot}`))[robot]);
		assert.equal(SESSION.made.at(-1), robot);
	});
});

describe("stacking nearest (75, scenario 15)", () => {
	it("two defaults things reaching a workspace: the nearer one applies", async () => {
		const { leo, fam, robot } = await family();
		const far = await store.create({ kind: Defaults.name, name: "far", workspace: pi, by: BY }, context);
		const near = await store.create({ kind: Defaults.name, name: "near", workspace: fam, by: BY }, context);
		const mine = await answers(robot, `person:${leo.id}`);
		assert.ok(mine[near]);
		assert.equal(mine[far], undefined);
		assert.equal((await answers(pi, "server"))[far]?.kind, Defaults.name);
	});
});

describe("configure (86)", () => {
	it("renames a thing linked here and sets its view; refuses one not here", async () => {
		const { anna, fam } = await family();
		await own(fam, party(anna), ["configure"]);
		const b = await store.create({ kind: Board.name, name: "b", workspace: fam, by: BY }, context);
		await holding(anna, fam, (ref, ctx) => ref.configure!({ thing: b, name: "board", view: "x" }, ctx));
		const row = (await store.things.one.page({ thing: b }, 1, context)).items[0]!;
		assert.equal(row.name, "board");
		assert.equal(row.view, "x");
		const other = await store.create({ kind: Board.name, name: "o", workspace: pi, by: BY }, context);
		await holding(anna, fam, (ref, ctx) =>
			assert.rejects(ref.configure!({ thing: other, name: "x" }, ctx), /not linked/),
		);
	});
});

describe("the lists (R34 to R38)", () => {
	/** The rows of list `List` for `principal`, held for `fn`. */
	const listOf = async <T>(principal: P3Principal, fn: (ctx: Ctx<P3Principal>) => Promise<T>) => as(principal, fn);

	it("roots: the topmost workspaces present in; an owner's is Pi; live", async () => {
		const { leo, fam } = await family();
		const owner = await person("Mario");
		await store.setOwner({ person: owner.id, owner: true }, context);
		await listOf(owner, async (ctx) => {
			const roots = await ctx.get(Roots, { view: "v" });
			assert.deepEqual(
				roots.list.value.rows.map((row) => row.workspace),
				[pi],
			);
		});
		await listOf(leo, async (ctx) => {
			const roots = await ctx.get(Roots, { view: "v" });
			assert.deepEqual(roots.list.value.rows, [{ workspace: fam, kind: WorkspaceKind.name, name: "Family" }]);
			await put(pi, leo);
			await until(roots.list, (list) => list.rows[0]?.workspace === pi, within("Leo's root moves up", context));
			assert.equal(roots.list.value.rows.length, 1);
		});
	});

	it("children: those the caller is present in, live", async () => {
		const { anna, leo, fam, robot } = await family();
		await listOf(anna, async (ctx) => {
			const children = await ctx.get(WorkspaceChildren, { workspace: fam, view: "v" });
			assert.deepEqual(
				children.list.value.rows.map((row) => row.workspace),
				[robot],
			);
			const mine = await store.createWorkspace(
				{ kind: WorkspaceKind.name, name: "Leo's", parent: fam, by: source(leo), showsPeople: false },
				context,
			);
			const open = await store.createWorkspace(
				{ kind: WorkspaceKind.name, name: "A open", parent: fam, by: BY },
				context,
			);
			await until(children.list, (list) => list.rows.length === 2, within("a new child", context));
			assert.deepEqual(
				children.list.value.rows.map((row) => row.workspace),
				[open, robot],
			);
			// Leo's private one is not Anna's to see.
			assert.ok(!children.list.value.rows.some((row) => row.workspace === mine));
		});
	});

	it("contents: what is here with where it is linked as the caller may see it (96), and what is hidden here", async () => {
		const { anna, leo, fam } = await family();
		const tools = await store.create({ kind: Board.name, name: "tools", workspace: pi, by: BY }, context);
		const sketch = await store.create({ kind: Board.name, name: "sketch", workspace: fam, by: BY }, context);
		await own(fam, party(anna), ["hide"]);
		await listOf(anna, async (ctx) => {
			const contents = await ctx.get(WorkspaceContents, { workspace: fam, view: "v" });
			const rows = () => Object.fromEntries(contents.list.value.rows.map((row) => [row.name, row]));
			assert.deepEqual(rows().tools, {
				thing: tools,
				kind: Board.name,
				name: "tools",
				from: { kind: "aboveUnnamed" },
				hidden: false,
			});
			assert.deepEqual(rows().sketch?.from, { kind: "here" });
			await (await ctx.get(Workspace, { workspace: fam })).hide!({ thing: tools, shown: false }, ctx);
			await until(contents.list, (list) => list.rows.some((row) => row.hidden), within("hidden", context));
			assert.equal(rows().tools?.hidden, true);
			// Hidden things are listed only for whoever may show them again (Hide here).
			const leos = await as(
				leo,
				async (lctx) => (await lctx.get(WorkspaceContents, { workspace: fam, view: "v" })).list.value.rows,
			);
			assert.equal(
				leos.some((row) => row.thing === tools),
				false,
			);
			await store.rename({ thing: sketch, name: "Sketch" }, context);
			await until(
				contents.list,
				(list) => list.rows.some((row) => row.name === "Sketch"),
				within("renamed", context),
			);
		});
		await put(pi, anna);
		await listOf(anna, async (ctx) => {
			const contents = await ctx.get(WorkspaceContents, { workspace: fam, view: "v" });
			assert.deepEqual(contents.list.value.rows.find((row) => row.thing === tools)?.from, {
				kind: "above",
				workspace: pi,
				name: "Pi",
			});
		});
	});

	it("people: who is here and from where; a person not present is denied the list", async () => {
		const { anna, leo, fam, robot } = await family();
		await listOf(leo, async (ctx) => {
			const people = await ctx.get(WorkspacePeople, { workspace: robot, view: "v" });
			const rows = Object.fromEntries(people.list.value.rows.map((row) => [partyKeyOf(row.party), row]));
			assert.deepEqual(rows[`person/${anna.id}`], {
				party: party(anna),
				name: "Anna",
				from: { kind: "above", workspace: fam, name: "Family" },
				hidden: false,
				outside: false,
			});
			assert.deepEqual(rows[`person/${leo.id}`]?.from, { kind: "here" });
			assert.deepEqual(rows[`agent/${robot}`]?.from, { kind: "here" });
		});
		const kim = await person("Kim");
		await as(kim, (ctx) =>
			assert.rejects(ctx.get(WorkspacePeople, { workspace: fam, view: "v" }, { readyTimeout: 200 })),
		);
	});

	it("linkable: things linked above where the caller has Link, by a name prefix", async () => {
		const { leo, fam, robot } = await family();
		const tools = await store.create({ kind: Board.name, name: "tools", workspace: pi, by: BY }, context);
		await store.create({ kind: Board.name, name: "other", workspace: fam, by: BY }, context);
		await put(pi, leo);
		await own(pi, party(leo), ["link"]);
		await listOf(leo, async (ctx) => {
			const linkable = await ctx.get(Linkable, { workspace: robot, query: "to", view: "v" });
			assert.deepEqual(linkable.list.value.rows, [
				{ thing: tools, kind: Board.name, name: "tools", from: { kind: "above", workspace: pi, name: "Pi" } },
			]);
		});
	});

	it("thing info: its kind, name, view and where it is linked; denied without an answer", async () => {
		const { anna, fam } = await family();
		const sketch = await store.create({ kind: Board.name, name: "sketch", workspace: fam, by: BY }, context);
		await listOf(anna, async (ctx) => {
			const info = await ctx.get(ThingInfo, { workspace: fam, thing: sketch });
			assert.deepEqual(info.info.value, { thing: sketch, kind: Board.name, name: "sketch", from: { kind: "here" } });
			const ownInfo = await ctx.get(ThingInfo, { workspace: fam, thing: fam });
			assert.equal(ownInfo.info.value.kind, WorkspaceKind.name);
		});
		const kim = await person("Kim");
		await as(kim, (ctx) =>
			assert.rejects(ctx.get(ThingInfo, { workspace: fam, thing: sketch }, { readyTimeout: 200 })),
		);
	});

	it("who may: the kind's ticks, its rows here with their sources, who has what; Make cells on a workspace", async () => {
		const { anna, leo, fam } = await family();
		const sketch = await store.create({ kind: Board.name, name: "sketch", workspace: fam, by: BY }, context);
		await own(fam, party(anna), ["manageAccess"]);
		// Read by anyone present (Leo has no Manage access: he reads the table and cannot change a cell); nobody outside.
		await as(leo, async (ctx) => {
			const who = await ctx.get(WhoMay, { workspace: fam, thing: sketch });
			assert.ok(who.table.value.rows.some((row) => row.party.kind === "everyone"));
			assert.equal((await ctx.get(Workspace, { workspace: fam })).setTick, undefined);
		});
		const stranger = await person("Stranger");
		await as(stranger, (ctx) =>
			assert.rejects(ctx.get(WhoMay, { workspace: fam, thing: sketch }, { readyTimeout: 200 })),
		);
		await listOf(anna, async (ctx) => {
			const who = await ctx.get(WhoMay, { workspace: fam, thing: sketch });
			const table = who.table.value;
			assert.deepEqual(
				table.ticks.map((tick) => tick.name),
				["read", "write", "draw", "moderate", "bash", "look"],
			);
			const everyone = table.rows.find((row) => row.party.kind === "everyone")!;
			assert.deepEqual(everyone.ticks.read, {
				here: [
					{ gives: true, source: { kind: "plugin", plugin: BOARD_PLUGIN }, kindDefault: true, inEffect: true },
				],
				has: true,
			});
			const leoRow = table.rows.find((row) => row.party.kind === "person" && row.party.person === leo.id)!;
			assert.equal(leoRow.name, "Leo");
			assert.deepEqual(leoRow.ticks.read, { here: [], has: true });
			assert.deepEqual(leoRow.ticks.draw, { here: [], has: false });
			await (await ctx.get(Workspace, { workspace: fam })).setTick!(
				{ thing: sketch, party: party(leo), tick: "draw", gives: true },
				ctx,
			);
			await until(
				who.table,
				(t) => t.rows.some((row) => row.name === "Leo" && row.ticks.draw?.has === true),
				within("Leo draws", context),
			);
			const ws = await ctx.get(WhoMay, { workspace: fam, thing: fam });
			const cells = Object.keys(ws.table.value.rows[0]!.ticks);
			assert.ok(cells.includes(MAKE_ANY) && cells.includes(makeTick(Board)) && cells.includes("manageAccess"));
		});
	});
});

/** A party's key, as the tests compare them. */
function partyKeyOf(party: Party): string {
	return party.kind === "everyone" || party.kind === "agents"
		? party.kind
		: party.kind === "person"
			? `person/${party.person}`
			: party.kind === "group"
				? `group/${party.group}`
				: `agent/${party.session}`;
}

describe("kinds as tokens (slice 1's carry-over)", () => {
	it("make types its input and makes a workspace kind's through createWorkspace; thingsOfKind follows what is available", async () => {
		const { fam, robot } = await family();
		const b = await w.host.root((ctx) => make(Board, { name: "b", workspace: fam, by: BY }, ctx), context);
		const s = await w.host.root((ctx) => make(TestSession, { name: "s", workspace: fam, by: BY }, ctx), context);
		assert.equal((await store.workspaces.one.page({ workspace: s }, 1, context)).items[0]?.parent, fam);
		const follower = await w.host.get(Follower, { workspace: robot }, context);
		assert.deepEqual(follower.things.value, [b]);
		const c = await store.create({ kind: Board.name, name: "c", workspace: robot, by: BY }, context);
		await until(follower.things, (things) => things.length === 2, within("a board linked in the robot", context));
		assert.deepEqual(follower.things.value, [b, c].toSorted());
	});
});

describe("reloads, failures and caches", () => {
	it("a held Workspace and list keep working across a reload of the things plugin and of a kind's plugin", async () => {
		const { anna, fam } = await family();
		await own(fam, party(anna), ["hide", makeTick(Board)]);
		await as(anna, async (ctx) => {
			const ref = await ctx.get(Workspace, { workspace: fam });
			const contents = await ctx.get(WorkspaceContents, { workspace: fam, view: "v" });
			await w.reload("@earendil-works/p3-things", context);
			const made = await ref.make!({ kind: Board.name, name: "after" }, ctx);
			await until(contents.list, (list) => list.rows.some((row) => row.thing === made), within("listed", context));
			await w.reload(BOARD_PLUGIN, context);
			await until(ref.state, (state) => state.kind === "live", within("live again", context));
			assert.deepEqual(ref.makes!.value.includes(Board.name), true);
			assert.ok(contents.list.value.rows.some((row) => row.thing === made));
		});
		assert.deepEqual(w.errors, []);
	});

	it("a removal cut short by a reload is finished by the store's next object", async () => {
		const { fam, robot } = await family();
		await store.create({ kind: Board.name, name: "b", workspace: robot, by: BY }, context);
		await store.removeWorkspace({ workspace: fam }, context);
		await w.reload("@earendil-works/p3-things", context);
		await eventually(
			() => w.rows("removing").length + w.rows("gone").length,
			(left) => left === 0,
		);
		assert.deepEqual(
			w.rows("workspaces").map((row) => row.workspace),
			[pi],
		);
	});

	it("a workspaceGone hook that fails is tried again until it succeeds", async () => {
		const { robot } = await family();
		SESSION.goneFails = 1;
		await store.removeWorkspace({ workspace: robot }, context);
		await eventually(
			() => SESSION.gone,
			(gone) => gone.includes(robot),
			5000,
		);
		await eventually(
			() => w.rows("gone").length,
			(left) => left === 0,
		);
	});

	it("a Workspace admission's decision goes with its answer", async () => {
		const { anna, fam } = await family();
		const gone = await holding(anna, fam, async (ref) => {
			const gives = await w.host.get(Gives, { workspace: fam, caller: `person:${anna.id}` }, context);
			const answer = new WeakRef(gives.answers.value[fam]!);
			gives.release();
			await own(fam, party(anna), ["link"]);
			await until(ref.state, () => ref.link !== undefined, within("the rebind", context));
			return answer;
		});
		assert.ok(await collected([gone]));
	});

	it("a released list keeps no probe: the index drops it", async () => {
		const { anna, fam } = await family();
		const ref = await as(anna, async (ctx) => {
			const contents = await ctx.get(WorkspaceContents, { workspace: fam, view: "v" });
			const value = new WeakRef(contents.list.value);
			return value;
		});
		assert.ok(await collected([ref]));
	});
});

describe("the create hook (sessions' push 3)", () => {
	it("is told the thing, its maker and where it is made (a workspace kind: its parent)", async () => {
		const { leo, fam, robot } = await family();
		assert.deepEqual(SESSION.told.at(-1), { thing: robot, workspace: fam, by: source(leo) });
		const d = await store.create({ kind: Defaults.name, name: "d", workspace: robot, by: BY }, context);
		assert.deepEqual(SESSION.told.at(-1), { thing: d, workspace: robot, by: BY });
	});

	it("may answer the new thing's own default view, written in the commit that makes it", async () => {
		const { fam } = await family();
		SESSION.answer = { view: "sessions.transcript" };
		const s = await store.createWorkspace({ kind: TestSession.name, name: "s", parent: fam, by: BY }, context);
		const d = await store.create({ kind: Defaults.name, name: "d", workspace: fam, by: BY }, context);
		for (const thing of [s, d]) {
			assert.equal((await store.things.one.page({ thing }, 1, context)).items[0]?.view, "sessions.transcript");
		}
		SESSION.answer = undefined;
		const plain = await store.create({ kind: Defaults.name, name: "p", workspace: fam, by: BY }, context);
		assert.equal((await store.things.one.page({ thing: plain }, 1, context)).items[0]?.view, "");
	});
});

describe("depth: how far above a thing is linked", () => {
	it("each answer says it (nearest link), a nearer link is a changed answer, told live; the own thing is 0", async () => {
		const { leo, fam, robot } = await family();
		const owner = await person("Mario");
		await store.setOwner({ person: owner.id, owner: true }, context);
		const board = await store.create({ kind: Board.name, name: "b", workspace: pi, by: BY }, context);
		const gives = await w.host.get(Gives, { workspace: robot, caller: `person:${leo.id}` }, context);
		const before = gives.answers.value[board]!;
		assert.equal(before.depth, 2);
		assert.equal(gives.answers.value[robot]?.depth, 0);
		assert.equal((await answers(robot, `person:${owner.id}`))[board]?.depth, 2);
		assert.equal((await answers(robot, `worker:${robot}`))[board]?.depth, 2);
		await store.link({ workspace: fam, thing: board }, context);
		await until(gives.answers, (given) => given[board]?.depth === 1, within("the nearer link", context));
		assert.notEqual(gives.answers.value[board], before);
		assert.equal((await answers(pi, "server"))[board]?.depth, 0);
		gives.release();
	});
});

describe("setTick resets a cell (page builder's repro)", () => {
	it("a kind's default row for everyone goes when its cell is reset, live in WhoMay and in a fresh hold", async () => {
		const { anna, fam } = await family();
		await own(fam, party(anna), ["manageAccess", makeTick(Board)]);
		await as(anna, async (ctx) => {
			const ref = await ctx.get(Workspace, { workspace: fam });
			const made = await ref.make!({ kind: Board.name, name: "Plans" }, ctx);
			const who = await ctx.get(WhoMay, { workspace: fam, thing: made });
			const everyone = (table: typeof who.table.value) =>
				table.rows.find((row) => row.party.kind === "everyone")!.ticks.read;
			assert.equal(everyone(who.table.value)?.here.length, 1);
			await ref.setTick!({ thing: made, party: { kind: "everyone" }, tick: "read" }, ctx);
			assert.equal(
				w.rows("grants").filter((row) => row.thing === made && String(row.party).includes("everyone")).length,
				0,
			);
			await until(who.table, (table) => everyone(table)?.here.length === 0, within("the row gone, live", context));
			const fresh = await ctx.get(WhoMay, { workspace: fam, thing: made });
			assert.deepEqual(everyone(fresh.table.value), { here: [], has: false });
		});
	});
});

describe("lists held over a link (the page's)", () => {
	it("a reset cell and a hidden thing reach a holder on another host (a probe's change is sent, not only kept)", async () => {
		const { anna, fam } = await family();
		await own(fam, party(anna), ["manageAccess", "hide"]);
		const board = await store.create({ kind: Board.name, name: "b", workspace: fam, by: BY }, context);
		const tools = await store.create({ kind: Board.name, name: "tools", workspace: pi, by: BY }, context);
		const [toServer, fromClient] = memoryLinkPair();
		const client = createHost<P3Principal>({ onError: (error) => assert.fail(`client error ${error.kind}`) });
		w.host.accept(fromClient, { principal: anna }, context);
		client.connect(toServer, { principal: { kind: "server" } }, context);
		await client.load([], context);
		try {
			const who = client.hold(WhoMay, { workspace: fam, thing: board }, context);
			const contents = client.hold(WorkspaceContents, { workspace: fam, view: "v" }, context);
			const ref = client.hold(Workspace, { workspace: fam }, context);
			for (const each of [who, contents, ref])
				await until(each.state, (state) => state.kind === "live", within("live", context));
			const everyone = () =>
				who.table.value.rows.find((row) => row.party.kind === "everyone")?.ticks.read?.here.length;
			assert.equal(everyone(), 1);
			await ref.setTick!({ thing: board, party: { kind: "everyone" }, tick: "read" }, context);
			await until(who.table, () => everyone() === 0, within("the reset over the link", context));
			await ref.hide!({ thing: tools, shown: false }, context);
			await until(
				contents.list,
				(list) => list.rows.some((row) => row.thing === tools && row.hidden),
				within("hidden over the link", context),
			);
			for (const each of [who, contents, ref]) each.release();
		} finally {
			await client.close(context);
		}
	});
});

describe("round 1: Astra's cases", () => {
	it("removal holds: removal cuts already-held Workspace and contents and survives a store reload", async () => {
		const { leo, fam, robot } = await family();
		await store.create({ workspace: robot, by: BY, name: "local", kind: Board.name }, context);
		await as(leo, async (ctx) => {
			const ws = await ctx.get(Workspace, { workspace: robot });
			const list = await ctx.get(WorkspaceContents, { workspace: robot, view: "v" });
			assert.equal(list.list.value.rows.length, 1);
			await store.removeWorkspace({ workspace: fam }, context);
			for (const ref of [ws, list])
				await until(ref.state, (s) => s.kind === "failed", within("cut while held", ctx));
			await w.reload("@earendil-works/p3-things", context);
			for (const ref of [ws, list])
				await until(ref.state, (s) => s.kind === "failed", within("still cut after reload", ctx));
		});
	});
	it("gone retry: a failed recipient's debt survives its absence on the next attempt", async () => {
		const { robot } = await family();
		SESSION.goneFails = 1;
		await store.removeWorkspace({ workspace: robot }, context);
		await eventually(
			() => SESSION.goneFails,
			(n) => n === 0,
		);
		assert.equal(w.rows("gone").length, 1);
		await w.reload(
			SPACES.name,
			context,
			defineFacet(() => {}),
		);
		await w.reload("@earendil-works/p3-things", context); // restart with that kind absent
		await w.reload(SPACES.name, context, SPACES.facet);
		await eventually(
			() => SESSION.gone,
			(seen) => seen.includes(robot),
			2500,
		);
	});
	it("an unavailable leaf cannot acquire a child", async () => {
		const { robot } = await family();
		await w.reload(
			SPACES.name,
			context,
			defineFacet(() => {}),
		);
		await assert.rejects(space(robot, "nested"));
	});
	it("WhoMay handles workspace grants naming someone not in the workspace", async () => {
		const { anna, fam } = await family();
		const kim = await person("Kim");
		await own(fam, party(anna), ["manageAccess"]);
		await own(fam, party(kim), ["hide"]);
		await as(anna, async (ctx) => {
			const who = await ctx.get(WhoMay, { workspace: fam, thing: fam }, { readyTimeout: 500 });
			assert.equal(who.table.value.rows.find((r) => r.name === "Kim")?.ticks.hide?.has, false);
		});
	});
	it("WhoMay's named Make checkbox follows the effective answer, including everyone’s wildcard", async () => {
		const { anna, leo, fam } = await family();
		await own(fam, party(anna), ["manageAccess"]);
		await own(fam, { kind: "everyone" }, [MAKE_ANY]);
		await as(anna, async (ctx) => {
			const who = await ctx.get(WhoMay, { workspace: fam, thing: fam });
			const truth = (await answers(fam, `person:${leo.id}`))[fam]!.makes!.includes(Board.name);
			assert.equal(truth, true);
			assert.equal(who.table.value.rows.find((r) => r.name === "Leo")?.ticks[makeTick(Board)]?.has, truth);
		});
	});
	it("leaf & stacking oracle: compare an owner’s held answer, including the leaf ceiling and nearest thing", async () => {
		const { robot, fam, leo } = await family();
		await store.setOwner({ person: leo.id, owner: true }, context);
		const a = await store.create({ name: "far", kind: Defaults.name, workspace: pi, by: BY }, context);
		const b = await store.create({ name: "near", kind: Defaults.name, workspace: fam, by: BY }, context);
		const expected = { far: undefined, near: 1, mayNest: false };
		const proj = (a0: Record<string, { depth: number; makes?: string[] }>) => ({
			far: a0[a]?.depth,
			near: a0[b]?.depth,
			mayNest: a0[robot]?.makes?.includes(WorkspaceKind.name),
		});
		assert.deepEqual(proj(await answers(robot, `person:${leo.id}`)), expected);
		const kinds = kindTicksOf([Board, WorkspaceKind, Defaults, TestSession, Login]);
		assert.deepEqual(
			proj(answersFrom(readEverything(w.path), kinds, robot, { kind: "person", person: leo.id })),
			expected,
		);
	});
	it("concurrent create, duplicate link and setTick leave complete rows; unlink and a new link serialize", async () => {
		const { fam, robot, leo } = await family();
		const boards = await Promise.all(
			Array.from({ length: 10 }, (_, i) =>
				store.create({ kind: Board.name, workspace: pi, name: String(i), by: source(leo) }, context),
			),
		);
		assert.equal(new Set(boards).size, 10);
		const b = boards[0]!;
		await Promise.all(Array.from({ length: 8 }, () => store.link({ workspace: fam, thing: b }, context)));
		await Promise.all(
			Array.from({ length: 8 }, (_, i) =>
				store.setTick(
					{
						workspace: fam,
						thing: b,
						party: party(leo),
						tick: "draw",
						source: { kind: "plugin", plugin: String(i) },
						gives: i % 2 === 0,
					},
					context,
				),
			),
		);
		assert.equal(w.rows("grants").filter((r) => r.thing === b && r.workspace === fam && r.tick === "draw").length, 1);
		await Promise.all([
			store.unlink({ workspace: fam, thing: b }, context),
			store.link({ workspace: robot, thing: b }, context),
		]);
		assert.deepEqual(
			w
				.rows("links")
				.filter((r) => r.thing === b)
				.map((r) => r.workspace)
				.sort(),
			[pi, robot].sort(),
		);
	});
});

describe("round 1: Opus's cases and the decisions", () => {
	it("R1: private wins: the maker asks for it, the create hook answers people shown: private", async () => {
		const { anna, leo, fam } = await family();
		SESSION.answer = { showsPeople: true };
		const mine = await store.createWorkspace(
			{ kind: TestSession.name, name: "mine", parent: fam, by: source(leo), showsPeople: false },
			context,
		);
		assert.equal((await answers(mine, `person:${anna.id}`))[mine], undefined);
		// And the hook's private wins over a maker who asked for nothing.
		SESSION.answer = { showsPeople: false };
		const theirs = await store.createWorkspace(
			{ kind: TestSession.name, name: "theirs", parent: fam, by: source(leo) },
			context,
		);
		assert.equal((await answers(theirs, `person:${anna.id}`))[theirs], undefined);
		assert.ok((await answers(theirs, `person:${leo.id}`))[theirs]);
	});

	it("Workspace.make with private makes a private workspace in one commit (6b through the page's call)", async () => {
		const { anna, leo, fam } = await family();
		await own(fam, party(leo), [makeTick(WorkspaceKind)]);
		const mine = await holding(leo, fam, (ref, ctx) =>
			ref.make!({ kind: WorkspaceKind.name, name: "mine", private: true }, ctx),
		);
		assert.equal((await answers(mine, `person:${anna.id}`))[mine], undefined);
		assert.ok((await answers(mine, `person:${leo.id}`))[mine]);
		assert.equal((await store.workspaces.one.page({ workspace: mine }, 1, context)).items[0]?.showsPeople, false);
	});

	it("R2: No access on a workspace's own thing takes the person out of it entirely, by every route, and below", async () => {
		const { anna, fam, robot } = await family();
		const b = await store.create({ kind: Board.name, name: "b", workspace: fam, by: BY }, context);
		await own(fam, party(anna), ["@open"], false);
		const given = await answers(fam, `person:${anna.id}`);
		assert.equal(given[fam], undefined);
		assert.equal(given[b], undefined, "No access on the workspace takes what is in it too");
		assert.deepEqual(await answers(robot, `person:${anna.id}`), {});
		// Even put in again here she stays out; put in below, she is in there.
		await put(fam, anna);
		assert.equal((await answers(fam, `person:${anna.id}`))[b], undefined);
		await put(robot, anna);
		assert.ok((await answers(robot, `person:${anna.id}`))[robot]);
	});

	it("R3: one list failing closed (past its bound) ends that list only; the index and every Gives stay", async () => {
		const { leo, fam } = await family();
		const big = await space(pi, "big");
		await put(big, leo);
		for (let i = 0; i < 5000; i++)
			await store.create({ kind: Board.name, name: `b${i}`, workspace: big, by: BY }, context);
		const gives = await w.host.get(Gives, { workspace: fam, caller: `person:${leo.id}` }, context);
		await as(leo, async (ctx) => {
			const contents = await ctx.get(WorkspaceContents, { workspace: big, view: "v" });
			assert.equal(contents.list.value.rows.length, 5000);
			await store.create({ kind: Board.name, name: "one more", workspace: big, by: BY }, context);
			await until(contents.state, (state) => state.kind !== "live", within("the list failed closed", context));
		});
		// The index did not start over: the other watcher was not ended and still answers.
		assert.equal(gives.state.value.kind, "live");
		assert.ok(gives.answers.value[fam]);
		gives.release();
	});

	it("test 7, second half: another session's agent gets only the agents' on a thing an agent made; Manage access removes the maker's row", async () => {
		const { anna, leo, fam, robot } = await family();
		const other = await store.createWorkspace(
			{ kind: TestSession.name, name: "other", parent: fam, by: source(leo) },
			context,
		);
		const made = await holding({ kind: "worker", session: robot }, robot, (ref, ctx) =>
			ref.make!({ kind: Board.name, name: "drawing" }, ctx),
		);
		// Linked in the robot only: another session's agent reaches it only if linked where it is; link it in Family.
		await store.link({ workspace: fam, thing: made }, context);
		assert.deepEqual((await answers(other, `worker:${other}`))[made]?.ticks, ["read"]);
		assert.deepEqual((await answers(robot, `worker:${robot}`))[made]?.ticks, [
			"bash",
			"draw",
			"moderate",
			"read",
			"write",
		]);
		await own(robot, party(anna), ["manageAccess"]);
		for (const tick of ["bash", "draw", "moderate", "read", "write"]) {
			await holding(anna, robot, (ref, ctx) =>
				ref.setTick!({ thing: made, party: { kind: "agent", session: robot }, tick }, ctx),
			);
		}
		assert.deepEqual((await answers(robot, `worker:${robot}`))[made]?.ticks, ["read"]);
	});

	it("MAKE_ANY alone covers a kind registered later", async () => {
		const { leo, fam } = await family();
		await own(fam, party(leo), [MAKE_ANY]);
		await w.reload(
			BOARD_PLUGIN,
			context,
			defineFacet(() => undefined),
		);
		const gives = await w.host.get(Gives, { workspace: fam, caller: `person:${leo.id}` }, context);
		await until(gives.answers, (given) => given[fam]?.makes?.includes(Board.name) === false, within("gone", context));
		await w.reload(BOARD_PLUGIN, context, BOARD.facet);
		await until(
			gives.answers,
			(given) => given[fam]?.makes?.includes(Board.name) === true,
			within("registered", context),
		);
		gives.release();
	});

	it("scenario 6: Kim's object gets what Moderate gives (the notes), not only the tick's name", async () => {
		const { anna, fam } = await family();
		const kim = await person("Kim");
		await put(fam, kim);
		await own(fam, party(anna), ["manageAccess"]);
		const comic = await store.create({ kind: Board.name, name: "Comic", workspace: fam, by: BY }, context);
		await as(kim, async (ctx) => {
			const held = await ctx.get(Board.contract, { workspace: fam, thing: comic });
			assert.equal(held.notes, undefined);
			await holding(anna, fam, (ref, actx) =>
				ref.setTick!({ thing: comic, party: party(kim), tick: "moderate", gives: true }, actx),
			);
			await until(held.state, () => held.notes !== undefined, within("Kim's history", context));
			assert.ok(held.moderate);
		});
	});
});

describe("round 1: what open lists cost a commit", () => {
	it("a list is asked again only after a commit that can change it: a rename or a grant elsewhere reads nothing", async () => {
		const { anna, fam } = await family();
		const other = await space(pi, "Other");
		const elsewhere = await store.create({ kind: Board.name, name: "x", workspace: other, by: BY }, context);
		const mine = await store.create({ kind: Board.name, name: "mine", workspace: fam, by: BY }, context);
		await as(anna, async (ctx) => {
			const contents = await ctx.get(WorkspaceContents, { workspace: fam, view: "v" });
			const reads = w.count("things.access.reads");
			await store.rename({ thing: elsewhere, name: "y" }, context);
			await store.setTick(
				{ workspace: other, thing: elsewhere, party: { kind: "everyone" }, tick: "write", gives: true, source: BY },
				context,
			);
			assert.equal(w.count("things.access.reads") - reads, 0);
			// A rename of a thing it shows is told.
			await store.rename({ thing: mine, name: "Mine" }, context);
			await until(contents.list, (list) => list.rows.some((row) => row.name === "Mine"), within("renamed", context));
		});
	});
});

describe("round 1: nits", () => {
	it("a removal also takes what other workspaces wrote about the removed one (switches on it or its agent, rows naming it)", async () => {
		const { fam, robot } = await family();
		const other = await space(pi, "Other");
		await store.setSwitch(
			{ workspace: other, item: { kind: "party", party: { kind: "agent", session: robot } }, shown: false },
			context,
		);
		await store.setSwitch({ workspace: other, item: { kind: "thing", thing: robot }, shown: false }, context);
		await store.removeWorkspace({ workspace: fam }, context);
		await eventually(
			() => w.rows("removing").length,
			(left) => left === 0,
		);
		assert.deepEqual(
			w.rows("switches").filter((row) => String(row.itemKey).includes(robot)),
			[],
		);
		// A row is written only in a workspace that stands.
		await assert.rejects(
			store.setGrants(
				{
					source: BY,
					grants: [{ workspace: robot, thing: robot, party: { kind: "everyone" }, tick: "read", gives: true }],
				},
				context,
			),
			/no workspace/,
		);
	});

	it("a create hook's default grants are checked as written grants are", async () => {
		const { fam } = await family();
		SESSION.answer = { defaultGrants: { agents: ["send"] } };
		await assert.rejects(
			store.createWorkspace({ kind: TestSession.name, name: "s", parent: fam, by: BY }, context),
			/cannot be given to agents/,
		);
	});
});

describe("round 2: Astra's cases", () => {
	it("astra2: held Roots learns about a workspace made for the person outside their existing tree", async () => {
		const p = await person("P");
		const parent = await space(pi, "parent");
		await as(p, async (ctx) => {
			const roots = await ctx.get(Roots, { view: "held" });
			assert.deepEqual(roots.list.value.rows, []);
			const made = await space(parent, "child", source(p));
			const fresh = await ctx.get(Roots, { view: "new" });
			assert.deepEqual(
				fresh.list.value.rows.map((r) => r.workspace),
				[made],
			);
			assert.deepEqual(roots.list.value.rows, fresh.list.value.rows);
		});
	});
	it("astra2: a person taken out locally is not displayed as present locally or below", async () => {
		const { anna, leo, fam, robot } = await family();
		await own(fam, party(anna), ["@open"], false);
		await as(leo, async (ctx) => {
			for (const workspace of [fam, robot]) {
				const people = await ctx.get(WorkspacePeople, { workspace, view: "v" });
				const shown = people.list.value.rows.filter((r) => !r.hidden).map((r) => r.name);
				assert.ok(!shown.includes("Anna"), JSON.stringify(shown));
			}
		});
	});
	it("astra2: a leaf workspace wildcard for the agents does not mean they can make logins or workspaces", async () => {
		const { leo, robot } = await family();
		const kinds = (await answers(robot, `worker:${robot}`))[robot]!.makes!;
		assert.ok(!kinds.includes(Login.name));
		await as(leo, async (ctx) => {
			const who = await ctx.get(WhoMay, { workspace: robot, thing: robot });
			const agents = who.table.value.rows.find((r) => r.party.kind === "agents")!;
			assert.equal(agents.ticks[makeTick(Login)]?.has, false);
			assert.equal(agents.ticks[makeTick(WorkspaceKind)]?.has, false);
		});
	});
	it("astra2: the owner does not see Make workspace under an unregistered parent kind", async () => {
		const { leo, robot } = await family();
		await store.setOwner({ person: leo.id, owner: true }, context);
		await w.reload(
			SPACES.name,
			context,
			defineFacet(() => {}),
		);
		const offered = (await answers(robot, `person:${leo.id}`))[robot]?.makes;
		assert.ok(!offered?.includes(WorkspaceKind.name), JSON.stringify(offered));
	});
});

describe("round 2: Opus's cases and the decisions", () => {
	it("S1: a workspace kind's default Make tick for a kind whose plugin is gone does not refuse new workspaces", async () => {
		const { leo, fam } = await family();
		SESSION.answer = { defaultGrants: { agents: [makeTick(Board)] } };
		await store.createWorkspace({ kind: TestSession.name, name: "ok", parent: fam, by: source(leo) }, context);
		await w.reload(
			BOARD_PLUGIN,
			context,
			defineFacet(() => undefined),
		);
		const after = await store.createWorkspace(
			{ kind: TestSession.name, name: "after", parent: fam, by: source(leo) },
			context,
		);
		// Kept, and ignored while the kind is gone.
		assert.ok(w.rows("grants").some((row) => row.thing === after && row.tick === makeTick(Board)));
	});

	it("No access for everyone or the agents on a workspace's own thing is refused: that is the people switches", async () => {
		const { fam } = await family();
		for (const who of [{ kind: "everyone" }, { kind: "agents" }] as const) {
			await assert.rejects(own(fam, who, ["@open"], false), /No access/);
		}
	});

	it("S2: No access for a group or a named agent on a workspace's own thing takes that way in out", async () => {
		const { fam, robot } = await family();
		const sub = await space(fam, "sub");
		const group = await store.makeGroup(
			{ name: "kids", managedBy: { kind: "plugin", plugin: "test" }, outside: false },
			context,
		);
		const kim = await person("Kim");
		await store.addToGroup({ group, person: kim.id, source: BY }, context);
		await store.putParty({ workspace: fam, party: { kind: "group", group }, source: BY }, context);
		assert.ok((await answers(sub, `person:${kim.id}`))[sub]);
		await own(sub, { kind: "group", group }, ["@open"], false);
		assert.equal((await answers(sub, `person:${kim.id}`))[sub], undefined);
		// The robot's agent is put in its own session; No access takes it out there.
		assert.ok((await answers(robot, `worker:${robot}`))[robot]);
		await own(robot, { kind: "agent", session: robot }, ["@open"], false);
		assert.deepEqual(await answers(robot, `worker:${robot}`), {});
	});

	it("a removal takes the rows other workspaces wrote naming the removed one as a thing", async () => {
		const { fam, robot } = await family();
		await store.setGrants(
			{
				source: BY,
				grants: [{ workspace: pi, thing: robot, party: { kind: "everyone" }, tick: "@open", gives: false }],
			},
			context,
		);
		assert.ok(w.rows("grants").some((row) => row.workspace === pi && row.thing === robot));
		await store.removeWorkspace({ workspace: fam }, context);
		await eventually(
			() => w.rows("removing").length,
			(left) => left === 0,
		);
		assert.equal(w.rows("grants").filter((row) => row.thing === robot).length, 0);
	});

	it("People and Children are not asked again after a commit that changed no presence (a board made)", async () => {
		const { anna, fam } = await family();
		await as(anna, async (ctx) => {
			await ctx.get(WorkspacePeople, { workspace: fam, view: "v" });
			await ctx.get(WorkspaceChildren, { workspace: fam, view: "v" });
			const reads = w.count("things.access.reads");
			await store.create({ kind: Board.name, name: "b", workspace: fam, by: BY }, context);
			// Only the index's own re-read of Family (its five entry reads): neither list read anything.
			assert.equal(w.count("things.access.reads") - reads, 5);
		});
	});
});

describe("round 3: Astra's cases", () => {
	it("astra3: owner Roots follows the displayed Pi name", async () => {
		const p = await person("Owner");
		await store.setOwner({ person: p.id, owner: true }, context);
		await as(p, async (ctx) => {
			const held = await ctx.get(Roots, { view: "held" });
			await store.rename({ thing: pi, name: "My Pi" }, context);
			const fresh = await ctx.get(Roots, { view: "fresh" });
			assert.equal(fresh.list.value.rows[0]?.name, "My Pi");
			assert.deepEqual(held.list.value.rows, fresh.list.value.rows);
		});
	});
	it("astra3: People follows the displayed name of the workspace where someone joined", async () => {
		const { leo, fam, robot } = await family();
		await as(leo, async (ctx) => {
			const held = await ctx.get(WorkspacePeople, { workspace: robot, view: "held" });
			await store.rename({ thing: fam, name: "Renamed Family" }, context);
			const fresh = await ctx.get(WorkspacePeople, { workspace: robot, view: "fresh" });
			assert.ok(fresh.list.value.rows.some((r) => r.from.kind === "above" && r.from.name === "Renamed Family"));
			assert.deepEqual(held.list.value.rows, fresh.list.value.rows);
		});
	});
	it("astra3: removing a leaf updates the People list where its named agent had been put", async () => {
		const { leo, robot } = await family();
		const other = await space(pi, "Other");
		await put(other, leo);
		await store.putParty({ workspace: other, party: { kind: "agent", session: robot }, source: BY }, context);
		await as(leo, async (ctx) => {
			const held = await ctx.get(WorkspacePeople, { workspace: other, view: "held" });
			assert.ok(held.list.value.rows.some((r) => r.party.kind === "agent"));
			await store.removeWorkspace({ workspace: robot }, context);
			await eventually(
				() => w.rows("removing").length,
				(left) => left === 0,
			);
			const fresh = await ctx.get(WorkspacePeople, { workspace: other, view: "fresh" });
			assert.ok(!fresh.list.value.rows.some((r) => r.party.kind === "agent"));
			assert.deepEqual(held.list.value.rows, fresh.list.value.rows);
		});
	});
});

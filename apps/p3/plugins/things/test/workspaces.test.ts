// Workspaces (ERNDL-1143), case by case of the issue's tests: the tree and its paths; a workspace's own ticks, written
// at itself, counting there only (88); what comes down and what a switch hides (1); linking with Link here and where
// the thing is linked now (R9, scenario 5); who may change who may (scenario 6); unlinking and removing (scenario 7,
// test 9); the agent in its own session (R6, scenario 12); `makes` (114); a private workspace (115); default grants
// left ticked (93); making (90); stacking `nearest` (75). Every call goes through `Workspace` as its caller would make
// it, on a host with the things plugin, the test board and the workspace tests' kinds.

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
	type Ctx,
	BACKGROUND_CONTEXT as context,
	defineFacet,
	type P3Principal,
	type Reference,
	until,
} from "@earendil-works/p3/v1";
import { eventually, within } from "../../../test/until.ts";
import { Gives, ThingsStore } from "../contract.server.ts";
import { MAKE_ANY, makeTick, type Party, type Source } from "../contract.ts";
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
import { type World, world } from "./world.ts";

const BY: Source = { kind: "plugin", plugin: "test" };

let w: World;
let store: Reference<typeof ThingsStore>;
let pi: string;

beforeEach(async () => {
	w = await world(context, [SPACES]);
	store = await w.host.get(ThingsStore, {}, context);
	pi = (await store.workspaces.children.page({ parent: "" }, 10, context)).items[0]!.workspace;
	SESSION.answer = undefined;
	SESSION.made.length = 0;
	SESSION.gone.length = 0;
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

	it("a workspace is never linked, and a kind of one workspace is linked once (7)", async () => {
		const { leo, fam, robot } = await family();
		await assert.rejects(store.link({ workspace: robot, thing: fam }, context), /placed by its parent/);
		void leo;
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
		// At once the subtree gives nothing.
		assert.deepEqual(await answers(robot, `person:${anna.id}`), {});
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

	it("a Make tick for a kind that is not registered is refused at the write", async () => {
		const { leo, fam } = await family();
		await assert.rejects(own(fam, party(leo), ["@make:nobody.nothing"]), /no tick/);
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
			void mine;
		});
	});

	it("contents: what is here with where it is linked as the caller may see it (96), and what is hidden here", async () => {
		const { anna, fam } = await family();
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
		await holding(leo, fam, async () => undefined);
		await as(leo, (ctx) => assert.rejects(ctx.get(WhoMay, { workspace: fam, thing: sketch }, { readyTimeout: 200 })));
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

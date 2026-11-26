// The one admission and what it derives from (`admitThing`, `Gives`, the store's handle in `AccessHandles`): a thing
// held by a person or an agent has exactly the members its ticks give; a changed grant rebuilds that caller's object
// once and its reference rebinds on the same hold, nobody else's; a denial carries its message; holding 40 things in
// one workspace opens one `Gives` and no live query; the index's reads and computations are counted; the kinds
// registry changing (a kind's plugin reloaded) updates answers live, migrating older ticks or refusing them; reloads
// of the things plugin and of a kind's plugin while things are held lose nothing; and the caches and handles let go of
// what they were keyed by.

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
	type Ctx,
	BACKGROUND_CONTEXT as context,
	defineFacet,
	local,
	method,
	type P3Principal,
	type Reference,
	until,
} from "@earendil-works/p3/v1";
import { collected, within } from "../../../test/until.ts";
import { type AccessHandle, AccessHandles, Gives, ThingsStore } from "../contract.server.ts";
import type { Party, Source } from "../contract.ts";
import { defineThing } from "../kind.ts";
import { serveThing } from "../serve.ts";
import { BOARD_PLUGIN, Board, BUILDS } from "./kinds.ts";
import { type World, world } from "./world.ts";

const BY: Source = { kind: "plugin", plugin: "test" };
const KIND_PLUGIN: Source = { kind: "plugin", plugin: BOARD_PLUGIN };

let w: World;
let store: Reference<typeof ThingsStore>;
let pi: string;

/** A person principal and their id. */
async function person(name: string): Promise<Extract<P3Principal, { kind: "person" }>> {
	return { kind: "person", id: await store.createPerson({ name, madeBy: BY }, context), name };
}

/** Puts `party` into `workspace`. */
const put = (workspace: string, party: Party) => store.putParty({ workspace, party, source: BY }, context);

/** Writes one giving grant (source: the test). */
const grant = (workspace: string, thing: string, party: Party, ticks: string[], source: Source = BY) =>
	store.setGrants({ source, grants: [{ workspace, thing, party, gives: true, ticks, takenAway: [] }] }, context);

/** A board made in `workspace` by a plugin: the kind's default grants only (everyone and the agents: read). */
const board = (workspace: string, name = "b") => store.create({ kind: Board.name, name, workspace, by: BY }, context);

/** Runs `fn` as `principal`. */
function as<T>(principal: P3Principal, fn: (ctx: Ctx<P3Principal>) => Promise<T>): Promise<T> {
	return w.host.root(fn, context, { principal });
}

/** The members a reference has now, of the test kind's grantable ones. */
const members = (ref: Reference<typeof Board.contract>) =>
	(["read", "write", "draw", "moderate", "bash", "look"] as const).filter((name) => ref[name] !== undefined);

beforeEach(async () => {
	w = await world(context);
	store = await w.host.get(ThingsStore, {}, context);
	pi = (await store.workspaces.children.page({ parent: "" }, 1, context)).items[0]!.workspace;
	BUILDS.length = 0;
});

afterEach(() => w.close(context));

describe("a thing held by a person or an agent", () => {
	it("has exactly the members its ticks give; a grant changed rebuilds only that caller's object, on the same hold", async () => {
		const [ada, kim] = [await person("Ada"), await person("Kim")];
		await put(pi, { kind: "person", person: ada.id });
		await put(pi, { kind: "person", person: kim.id });
		await put(pi, { kind: "agent", session: "s1" });
		const thing = await board(pi);
		await as(ada, async (ctx) => {
			const mine = await ctx.get(Board.contract, { workspace: pi, thing });
			assert.deepEqual(members(mine), ["read"]);
			assert.equal(await mine.read!(ctx), "person");
			await as(kim, async (kctx) => {
				const hers = await kctx.get(Board.contract, { workspace: pi, thing });
				await as({ kind: "worker", session: "s1" }, async (actx) => {
					const agent = await actx.get(Board.contract, { workspace: pi, thing });
					assert.equal(await agent.read!(actx), "agent");
					assert.deepEqual(BUILDS.toSorted(), [ada.id, kim.id, "s1"].toSorted());
					await grant(pi, thing, { kind: "person", person: ada.id }, ["draw", "moderate"]);
					await until(mine.state, () => mine.draw !== undefined, within("Ada's rebind", context));
					assert.deepEqual(members(mine), ["draw", "moderate"]);
					assert.deepEqual(members(hers), ["read"]);
					assert.deepEqual(members(agent), ["read"]);
					// Ada's object was built again, once; Kim's and the agent's not.
					assert.deepEqual(BUILDS.filter((id) => id === ada.id).length, 2);
					assert.deepEqual(BUILDS.length, 4);
					assert.equal(agent.bash, undefined);
				});
			});
		});
	});

	it("is denied with its message where nothing is given, and admitted again live", async () => {
		const ada = await person("Ada");
		const thing = await board(pi);
		await as(ada, async (ctx) => {
			const ref = w.host.hold(Board.contract, { workspace: pi, thing }, context);
			ref.release();
			await assert.rejects(
				ctx.get(Board.contract, { workspace: pi, thing }, { readyTimeout: 200 }),
				(error: Error & { details?: { message?: { namespace: string; key: string } } }) => {
					assert.deepEqual(error.details?.message, { namespace: "things", key: "notGiven", params: [] });
					return true;
				},
			);
		});
		await put(pi, { kind: "person", person: ada.id });
		await as(ada, async (ctx) =>
			assert.deepEqual(members(await ctx.get(Board.contract, { workspace: pi, thing })), ["read"]),
		);
	});

	it("the server is granted everything", async () => {
		const thing = await board(pi);
		const ref = await w.host.get(Board.contract, { workspace: pi, thing }, context);
		assert.deepEqual(members(ref), ["read", "write", "draw", "moderate", "bash", "look"]);
		assert.equal(await ref.read!(context), "server");
		ref.release();
	});
});

describe("counted work", () => {
	it("40 things held in one workspace by one caller: one Gives, no live query", async () => {
		const ada = await person("Ada");
		await put(pi, { kind: "person", person: ada.id });
		const things: string[] = [];
		for (let i = 0; i < 40; i++) things.push(await board(pi));
		const [attaches, runs] = [w.count("things.access.attaches"), w.count("chord.query.runs")];
		await as(ada, async (ctx) => {
			for (const thing of things) await ctx.get(Board.contract, { workspace: pi, thing });
		});
		assert.equal(w.count("things.access.attaches") - attaches, 1);
		assert.equal(w.count("chord.query.runs") - runs, 0);
	});

	it("a first question at depth 5 with a person costs 27 reads, a second none; results are computed once", async () => {
		let at = pi;
		for (let i = 0; i < 4; i++)
			at = await store.createWorkspace({ kind: "things.workspace", name: `w${i}`, parent: at, by: BY }, context);
		const ada = await person("Ada");
		// The store's next object starts with nothing loaded.
		await w.reload("@earendil-works/p3-things", context);
		const reads = w.count("things.access.reads");
		const computes = w.count("things.access.computes");
		const gives = await w.host.get(Gives, { workspace: at, caller: `person:${ada.id}` }, context);
		assert.equal(w.count("things.access.reads") - reads, 27);
		assert.equal(w.count("things.access.computes") - computes, 5);
		const again = await w.host.get(Gives, { workspace: pi, caller: `person:${ada.id}` }, context);
		assert.equal(w.count("things.access.reads") - reads, 27);
		assert.equal(w.count("things.access.computes") - computes, 5);
		gives.release();
		again.release();
	});

	it("a change reads again only what it touched, and recomputes at and below it", async () => {
		const team = await store.createWorkspace({ kind: "things.workspace", name: "team", parent: pi, by: BY }, context);
		const other = await store.createWorkspace(
			{ kind: "things.workspace", name: "other", parent: pi, by: BY },
			context,
		);
		const ada = await person("Ada");
		const held = [team, other, pi].map((workspace) =>
			w.host.hold(Gives, { workspace, caller: `person:${ada.id}` }, context),
		);
		for (const ref of held) await until(ref.state, (state) => state.kind === "live", context);
		const [reads, computes] = [w.count("things.access.reads"), w.count("things.access.computes")];
		await put(team, { kind: "person", person: ada.id });
		assert.equal(w.count("things.access.reads") - reads, 5);
		assert.equal(w.count("things.access.computes") - computes, 1);
		for (const ref of held) ref.release();
	});
});

describe("the kinds registry", () => {
	/** The test kind at version 2: `draw` renamed `paint`, with or without its migration. */
	const v2 = (migrate: boolean) =>
		defineThing(Board.name, {
			version: 2,
			methods: { read: method(), paint: method() },
			ticks: {
				read: { label: { namespace: "test", key: "read", params: [] }, gives: ["read"] },
				paint: { label: { namespace: "test", key: "paint", params: [] }, gives: ["paint"] },
			},
			...(migrate
				? { migrateTicks: (ticks: readonly string[]) => ticks.map((tick) => (tick === "draw" ? "paint" : tick)) }
				: {}),
		});
	const facetOf = (kind: ReturnType<typeof v2>) =>
		defineFacet((host) =>
			serveThing(host, kind, { implement: () => ({ read: async () => null, paint: async () => null }) }),
		);

	it("a kind's new version migrates older ticks on load; without a migration they count for nothing", async () => {
		const ada = await person("Ada");
		await put(pi, { kind: "person", person: ada.id });
		const thing = await board(pi);
		await grant(pi, thing, { kind: "person", person: ada.id }, ["draw", "read"]);
		const gives = await w.host.get(Gives, { workspace: pi, caller: `person:${ada.id}` }, context);
		assert.deepEqual(gives.answers.value[thing], { ticks: ["draw", "read"] });
		await w.reload(BOARD_PLUGIN, context, facetOf(v2(true)));
		await until(
			gives.answers,
			(answers) => answers[thing]?.ticks.includes("paint") === true,
			within("the migration", context),
		);
		assert.deepEqual(gives.answers.value[thing], { ticks: ["paint", "read"] });
		await w.reload(BOARD_PLUGIN, context, facetOf(v2(false)));
		// Ada's own grant is refused (version 1, no migration): she counts as everyone, whose default grant is refused too.
		await until(gives.answers, (answers) => answers[thing] === undefined, within("the refusal", context));
		// A grant written now is at version 2, and counts.
		await grant(pi, thing, { kind: "person", person: ada.id }, ["paint"]);
		assert.deepEqual(gives.answers.value[thing], { ticks: ["paint"] });
		gives.release();
	});

	it("a kind's plugin removed: its ticks count for nothing; back again, they count", async () => {
		const ada = await person("Ada");
		await put(pi, { kind: "person", person: ada.id });
		const thing = await board(pi);
		const gives = await w.host.get(Gives, { workspace: pi, caller: `person:${ada.id}` }, context);
		await w.reload(
			BOARD_PLUGIN,
			context,
			defineFacet(() => {}),
		);
		await until(gives.answers, (answers) => answers[thing]?.ticks.length === 0, within("the removal", context));
		await w.reload(
			BOARD_PLUGIN,
			context,
			defineFacet((host) =>
				serveThing(host, Board, {
					implement: () => ({
						title: { kind: "constant" } as never,
						read: async () => "",
						write: async () => null,
						draw: async () => null,
						moderate: async () => null,
						bash: async () => null,
						look: async () => null,
					}),
				}),
			),
		);
		await until(gives.answers, (answers) => answers[thing]?.ticks.length === 1, within("the return", context));
		gives.release();
	});
});

describe("reloads while things are held", () => {
	it("the things plugin and the kind's plugin reload under a held thing: no error, the same members, changes still reach it", async () => {
		const ada = await person("Ada");
		await put(pi, { kind: "person", person: ada.id });
		const thing = await board(pi);
		await as(ada, async (ctx) => {
			const ref = await ctx.get(Board.contract, { workspace: pi, thing });
			const states: string[] = [];
			const watching = await ref.state.watch(context);
			watching.start(async (call) => void (call.kind === "value" && states.push(call.value.kind)));
			await w.reload("@earendil-works/p3-things", context);
			await w.reload(BOARD_PLUGIN, context);
			await until(ref.state, (state) => state.kind === "live", within("live again", context));
			assert.deepEqual(members(ref), ["read"]);
			const again = await w.host.get(ThingsStore, {}, context);
			await again.setGrants(
				{
					source: KIND_PLUGIN,
					grants: [
						{ workspace: pi, thing, party: { kind: "everyone" }, gives: true, ticks: ["write"], takenAway: [] },
					],
				},
				context,
			);
			await until(ref.state, () => ref.write !== undefined, within("the change after the reloads", context));
			assert.deepEqual(members(ref), ["write"]);
			assert.ok(!states.includes("failed"), `states: ${states.join(", ")}`);
			await watching.stop();
		});
		assert.deepEqual(w.errors, []);
	});
});

/** The handles the test's object saw in `AccessHandles`, weakly. */
const seen: WeakRef<AccessHandle>[] = [];

/** A test object that records every handle `AccessHandles` composes to. */
const Watcher = local("test.handles", { version: 1, params: {}, members: {} });

describe("caches and handles", () => {
	it("a released Gives keeps no watcher: its last answers are collected", async () => {
		const ada = await person("Ada");
		await put(pi, { kind: "person", person: ada.id });
		await board(pi);
		const ref = await (async () => {
			const gives = await w.host.get(Gives, { workspace: pi, caller: `person:${ada.id}` }, context);
			const answers = new WeakRef(gives.answers.value);
			gives.release();
			return answers;
		})();
		assert.ok(await collected([ref]));
	});

	it("an admission's decision goes with its answer", async () => {
		const ada = await person("Ada");
		await put(pi, { kind: "person", person: ada.id });
		const thing = await board(pi);
		const gone = await as(ada, async (ctx) => {
			const held = await ctx.get(Board.contract, { workspace: pi, thing });
			const gives = await w.host.get(Gives, { workspace: pi, caller: `person:${ada.id}` }, context);
			const answer = new WeakRef(gives.answers.value[thing]!);
			gives.release();
			// A new answer replaces it: the old one, and its decision, are no one's any more.
			await grant(pi, thing, { kind: "person", person: ada.id }, ["draw"]);
			await until(held.state, () => held.draw !== undefined, within("the rebind", context));
			return answer;
		});
		assert.ok(await collected([gone]));
	});

	it("after a reload of the things plugin the handle is the new store object's; the old index is collected", async () => {
		const handles = defineFacet((host) =>
			host.serve(Watcher, (_params, self) => {
				self.on(self.registry(AccessHandles), (call) => {
					if (call.value !== undefined) seen.push(new WeakRef(call.value));
				});
				return {};
			}),
		);
		await w.close(context);
		w = await world(context, [{ name: "test-handles", facet: handles }]);
		store = await w.host.get(ThingsStore, {}, context);
		const watcher = await w.host.get(Watcher, {}, context);
		await until(store.state, (state) => state.kind === "live", context);
		await new Promise((resolve) => setTimeout(resolve, 20));
		const first = seen.length;
		assert.ok(first >= 1);
		await w.reload("@earendil-works/p3-things", context);
		await w.host.get(ThingsStore, {}, context);
		await new Promise((resolve) => setTimeout(resolve, 20));
		assert.ok(seen.length > first);
		assert.ok(seen.at(-1)!.deref()?.open);
		assert.ok(await collected(seen.slice(0, first)));
		watcher.release();
	});
});

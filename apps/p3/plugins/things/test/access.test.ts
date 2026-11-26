// The access index against the reference (the prototype's randomized proof, ported): random trees, things, persons,
// groups (some outside), agents and sources, written through `ThingsStore`; watchers holding `Gives`; then hundreds of
// random writes. After every write the dumb reference (`reference.ts`, reading the store's file) must say what every
// watcher was last told and what a sample of fresh questions answer; a watcher told what it already had fails the run.
// Two seeds also run a second index that forgets all the time (at most 2 unwatched workspaces kept), told that every
// workspace and person changed after each write. The index's own mechanics follow: reads and computations counted,
// forgetting, a watcher stopped in the middle of a change.

import assert from "node:assert/strict";
import { describe, it, mock, type TestContext } from "node:test";
import {
	BACKGROUND_CONTEXT as context,
	type FollowObserver,
	isChordError,
	type Reference,
} from "@earendil-works/p3/v1";
import { AccessIndex, type Answers, type Reader } from "../access.ts";
import { Gives, ThingsStore } from "../contract.server.ts";
import { OPEN, type Party, type Source } from "../contract.ts";
import { lookupOf, readerOf } from "../reader.ts";
import { ABOVE_THE_ROOT, accessHere } from "../rules.ts";
import { BOARD_PLUGIN, Board } from "./kinds.ts";
import { answersFrom, type Caller, type Everything, type KindTicks, readEverything } from "./reference.ts";
import { type World, world } from "./world.ts";

const TICKS = ["read", "write", "draw", "moderate", "read", "write", "draw", "moderate", "bash", "look"];
const KINDS: KindTicks = new Map([[Board.name, new Map(Board.info.ticks.map((tick) => [tick.name, tick.for]))]]);
const MAX_DEPTH = 6;

/** A small seeded random number generator (mulberry32). */
function seeded(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/** The answers in a stable order, for comparing. */
const sorted = (answers: Readonly<Record<string, unknown>>) =>
	Object.entries(answers).sort(([a], [b]) => (a < b ? -1 : 1));

/** A caller as `Gives` names it. */
function callerKey(caller: Caller): string {
	return caller.kind === "person" ? `person:${caller.person}` : `worker:${caller.session}`;
}

/** One watcher: what it holds, what it was told last and how often. */
type Watcher = { workspace: string; caller: Caller; last: Answers; calls: number; stop: () => void };

/** One random world and its run. */
class Run {
	readonly random: () => number;
	readonly workspaces: string[] = [];
	readonly parents = new Map<string, string>();
	readonly depth = new Map<string, number>();
	readonly things: string[] = [];
	readonly persons: string[] = [];
	readonly groups: string[] = [];
	readonly links: { workspace: string; thing: string }[] = [];
	readonly sources: Source[];
	readonly w: World;
	store!: Reference<typeof ThingsStore>;

	constructor(w: World, seed: number) {
		this.w = w;
		this.random = seeded(seed);
		this.sources = [
			{ kind: "plugin", plugin: BOARD_PLUGIN },
			{ kind: "thing", thing: "share-one" },
			{ kind: "thing", thing: "share-two" },
			{ kind: "plugin", plugin: "mario" },
		];
	}

	below = (n: number) => Math.floor(this.random() * n);
	pick = <T>(list: readonly T[]): T => list[this.below(list.length)] as T;
	chance = (p: number) => this.random() < p;
	/** A workspace, more often one made early (near the root). */
	nearTheRoot = () => this.pick(this.workspaces.slice(0, 1 + this.below(1 + this.below(this.workspaces.length))));
	someTicks = () => [...new Set(TICKS.filter(() => this.chance(0.2)))];
	/** A tick of the test kind, or now and then `OPEN`. */
	someTick = () => (this.chance(0.12) ? OPEN : this.pick(TICKS));

	someMember(): Party {
		const roll = this.random();
		if (roll < 0.4) return { kind: "person", person: this.pick(this.persons) };
		if (roll < 0.75) return { kind: "group", group: this.pick(this.groups) };
		return { kind: "agent", session: this.pick(this.workspaces) };
	}

	someParty(): Party {
		const roll = this.random();
		if (roll < 0.3) return { kind: "everyone" };
		if (roll < 0.5) return { kind: "agents" };
		return this.someMember();
	}

	someCaller(): Caller {
		const roll = this.random();
		if (roll < 0.6) return { kind: "person", person: this.pick(this.persons) };
		if (roll < 0.65) return { kind: "person", person: "nobody-made-this-person" };
		return { kind: "agent", session: this.pick(this.workspaces) };
	}

	/** A place where a thing is linked (if any is), so grants land where they count. */
	someLink() {
		return this.links.length > 0 && this.chance(0.85)
			? this.pick(this.links)
			: { workspace: this.pick(this.workspaces), thing: this.pick(this.things) };
	}

	/** A workspace at or below `workspace`, often. */
	atOrBelow(workspace: string): string {
		const under = this.workspaces.filter((w) => this.isAtOrBelow(w, workspace));
		return this.chance(0.8) ? this.pick(under) : this.pick(this.workspaces);
	}

	isAtOrBelow(w: string, above: string): boolean {
		for (let at: string | undefined = w; at !== undefined; at = this.parents.get(at)) if (at === above) return true;
		return false;
	}

	async setUp(): Promise<void> {
		this.store = await this.w.host.get(ThingsStore, {}, context);
		const [pi] = (await this.store.workspaces.children.page({ parent: "" }, 1, context)).items;
		this.workspaces.push(pi!.workspace);
		this.depth.set(pi!.workspace, 0);
		const plugin: Source = { kind: "plugin", plugin: "test" };
		for (let i = 0; i < 8; i++)
			this.persons.push(await this.store.createPerson({ name: `p${i}`, madeBy: plugin }, context));
		await this.store.setOwner({ person: this.persons[7]!, owner: true }, context);
		for (let i = 0; i < 5; i++) {
			const managedBy = i === 3 ? ({ kind: "thing", thing: "share-one" } as const) : ({ kind: "people" } as const);
			this.groups.push(await this.store.makeGroup({ name: `g${i}`, managedBy, outside: i % 2 === 1 }, context));
		}
		for (let i = 0; i < 10; i++) {
			this.things.push(
				await this.store.create({ kind: Board.name, name: `t${i}`, workspace: pi!.workspace, by: plugin }, context),
			);
			this.links.push({ workspace: pi!.workspace, thing: this.things[i]! });
		}
	}

	/** One random write; one the store refuses (`invalid`) leaves the disk as it was. */
	async write(): Promise<void> {
		try {
			await this.#write();
		} catch (error) {
			if (!isChordError(error, "invalid")) throw error;
		}
	}

	async #write(): Promise<void> {
		const s = this.store;
		const roll = this.below(100);
		if (roll < 8) {
			const parent = this.pick(this.workspaces.filter((w) => (this.depth.get(w) ?? 0) < MAX_DEPTH));
			const by: Source = { kind: "plugin", plugin: "test" };
			const id = await s.createWorkspace({ kind: "things.workspace", name: "w", parent, by }, context);
			this.workspaces.push(id);
			this.parents.set(id, parent);
			this.depth.set(id, (this.depth.get(parent) ?? 0) + 1);
			if (this.chance(0.1)) await s.setDefaults({ workspace: id, showsThings: false }, context);
			if (this.chance(0.1)) await s.setDefaults({ workspace: id, showsPeople: false }, context);
			if (this.chance(0.7))
				await s.putParty({ workspace: id, party: { kind: "agent", session: id }, source: by }, context);
		} else if (roll < 12) {
			const shown = this.chance(0.7);
			await s.setDefaults(
				{
					workspace: this.pick(this.workspaces),
					...(this.chance(0.5) ? { showsThings: shown } : { showsPeople: shown }),
				},
				context,
			);
		} else if (roll < 24) {
			const workspace = this.nearTheRoot();
			const index = this.below(this.things.length);
			const exists = (await s.things.one.page({ thing: this.things[index]! }, 1, context)).items.length > 0;
			if (exists)
				await s.link({ workspace, thing: this.things[index]!, by: { kind: "plugin", plugin: "test" } }, context);
			else
				this.things[index] = await s.create(
					{ kind: Board.name, name: "t", workspace, by: { kind: "person", person: this.pick(this.persons) } },
					context,
				);
			const thing = this.things[index]!;
			this.links.push({ workspace, thing });
			const plugin: Source = { kind: "plugin", plugin: BOARD_PLUGIN };
			for (const party of [{ kind: "everyone" }, { kind: "agents" }] as const) {
				if (this.chance(0.8)) {
					const grants = this.someTicks().map((tick) => ({ workspace, thing, party, tick, gives: true }));
					await s.setGrants({ source: plugin, grants }, context);
				}
			}
		} else if (roll < 27) {
			await s.unlink(this.someLink(), context);
		} else if (roll < 39) {
			await s.putParty(
				{
					workspace: this.chance(0.7) ? this.nearTheRoot() : this.pick(this.workspaces),
					party: this.someMember(),
					source: this.pick(this.sources),
				},
				context,
			);
		} else if (roll < 43) {
			await s.removeParty({ workspace: this.pick(this.workspaces), party: this.someMember() }, context);
		} else if (roll < 53) {
			const item = this.chance(0.5)
				? ({ kind: "thing", thing: this.pick(this.things) } as const)
				: ({ kind: "party", party: this.someMember() } as const);
			await s.setSwitch(
				{ workspace: this.pick(this.workspaces), item, ...(this.chance(0.2) ? {} : { shown: this.chance(0.5) }) },
				context,
			);
		} else if (roll < 66) {
			const link = this.someLink();
			// Given, or the source's row removed.
			const grants = Array.from({ length: this.chance(0.2) ? 3 : 1 }, () => ({
				...link,
				party: this.someParty(),
				tick: this.someTick(),
				...(this.chance(0.85) ? { gives: true } : {}),
			}));
			await s.setGrants({ source: this.pick(this.sources), grants }, context);
		} else if (roll < 76) {
			const link = this.someLink();
			// Withheld at or below the link, or the source's row removed.
			const [workspace, party] = [this.atOrBelow(link.workspace), this.someParty()];
			const grants = Array.from({ length: this.chance(0.3) ? 2 : 1 }, () => ({
				workspace,
				thing: link.thing,
				party,
				tick: this.someTick(),
				...(this.chance(0.85) ? { gives: false } : {}),
			}));
			await s.setGrants({ source: this.pick(this.sources), grants }, context);
		} else if (roll < 84) {
			await s.addToGroup(
				{ group: this.pick(this.groups), person: this.pick(this.persons), source: this.pick(this.sources) },
				context,
			);
		} else if (roll < 88) {
			await s.removeFromGroup(
				{ group: this.pick(this.groups), person: this.pick(this.persons), source: this.pick(this.sources) },
				context,
			);
		} else if (roll < 93) {
			await s.setOwner({ person: this.pick(this.persons), owner: this.chance(0.15) }, context);
		} else if (roll < 94) {
			await s.deleteEverythingFrom({ source: this.pick(this.sources) }, context);
		} else {
			await s.create(
				{
					kind: Board.name,
					name: "t",
					workspace: this.pick(this.workspaces),
					by: this.chance(0.5)
						? { kind: "person", person: this.pick(this.persons) }
						: { kind: "agent", session: this.pick(this.workspaces) },
				},
				context,
			);
		}
	}
}

/** The store's answers for (`workspace`, `caller`) now: a `Gives` held for the question and released. */
async function asked(w: World, workspace: string, caller: Caller): Promise<Answers> {
	const gives = await w.host.get(Gives, { workspace, caller: callerKey(caller) }, context);
	try {
		return gives.answers.value;
	} finally {
		gives.release();
	}
}

/** A watcher of `Gives`: checks each call tells something new. */
async function watch(w: World, workspace: string, caller: Caller): Promise<Watcher> {
	const gives = await w.host.get(Gives, { workspace, caller: callerKey(caller) }, context);
	const watching = await gives.answers.watch(context);
	const watcher: Watcher = { workspace, caller, last: watching.value, calls: 0, stop: () => {} };
	watching.start(async (call) => {
		if (call.kind !== "value") return;
		assert.notDeepEqual(sorted(call.value), sorted(watcher.last), "told the answers it already had");
		watcher.last = call.value;
		watcher.calls++;
	});
	watcher.stop = () => {
		void watching.stop();
		gives.release();
	};
	return watcher;
}

/** A turn for followed values to reach their watches. */
const settle = () => new Promise((resolve) => setImmediate(resolve));

/** Runs seed `seed`: `writes` random writes after the setup; with `forgetting`, the second index too. */
async function run(t: TestContext, seed: number, writes: number, forgetting: boolean): Promise<void> {
	const w = await world(context);
	t.after(() => w.close(context));
	const r = new Run(w, seed);
	await r.setUp();
	for (let i = 0; i < 250; i++) await r.write();
	const watchers = new Set<Watcher>();
	const startWatcher = async () => watchers.add(await watch(w, r.pick(r.workspaces), r.someCaller()));
	for (let i = 0; i < 40; i++) await startWatcher();
	const second = forgetting ? new SecondIndex(r) : undefined;
	await second?.start(10);
	let sampled = 0;
	let withTicks = 0;
	for (let step = 0; step < writes; step++) {
		await r.write();
		await second?.changed();
		await settle();
		if (r.chance(0.1)) {
			const stopped = r.pick([...watchers]);
			stopped.stop();
			watchers.delete(stopped);
			await startWatcher();
		}
		const all = readEverything(w.path);
		for (const watcher of watchers) {
			assert.deepEqual(
				sorted(watcher.last),
				sorted(answersFrom(all, KINDS, watcher.workspace, watcher.caller)),
				`step ${step}: a watcher is behind`,
			);
		}
		for (let i = 0; i < 5; i++) {
			const [workspace, caller] = [r.pick(r.workspaces), r.someCaller()];
			const answers = await asked(w, workspace, caller);
			assert.deepEqual(
				sorted(answers),
				sorted(answersFrom(all, KINDS, workspace, caller)),
				`step ${step}: a question`,
			);
			sampled++;
			if (Object.values(answers).some((answer) => answer.ticks.length > 0)) withTicks++;
		}
		second?.check(all, step);
	}
	// A fresh index (the store's next object, after a reload) answers the same, for every workspace and caller.
	await w.reload("@earendil-works/p3-things", context);
	const all = readEverything(w.path);
	for (const workspace of r.workspaces) {
		for (const caller of [
			...r.persons.map((person) => ({ kind: "person", person }) as const),
			{ kind: "agent", session: workspace } as const,
		]) {
			assert.deepEqual(
				sorted(await asked(w, workspace, caller)),
				sorted(answersFrom(all, KINDS, workspace, caller)),
			);
		}
	}
	const calls = [...watchers].reduce((sum, watcher) => sum + watcher.calls, 0);
	for (const watcher of watchers) watcher.stop();
	assert.ok(withTicks / sampled > 0.1, `only ${withTicks} of ${sampled} questions gave ticks`);
	assert.ok(calls > 30, `watchers were told only ${calls} times`);
	assert.deepEqual(w.errors, []);
	t.diagnostic(
		`seed ${seed}: ${r.workspaces.length} workspaces, ${sampled} questions (${Math.round((100 * withTicks) / sampled)}% with ticks), ${calls} watcher calls`,
	);
}

/**
 * A second index over the store's named queries that keeps at most 2 unwatched workspaces, told that everything
 * changed after each write: forgetting all the time must keep every answer right.
 */
class SecondIndex {
	readonly #r: Run;
	readonly #index: AccessIndex;
	readonly #watchers: { workspace: string; caller: Caller; last: Answers }[] = [];

	constructor(r: Run) {
		this.#r = r;
		this.#index = new AccessIndex(
			readerOf(r.store, () => LOOKUP, new Set()),
			() => LOOKUP,
			context,
			2,
		);
	}

	async start(count: number): Promise<void> {
		for (let i = 0; i < count; i++) {
			const [workspace, caller] = [this.#r.pick(this.#r.workspaces), this.#r.someCaller()];
			const watcher = { workspace, caller, last: {} as Answers };
			const observer: FollowObserver<unknown> = {
				advance: (call) => {
					if (call.kind !== "value") return;
					assert.notDeepEqual(
						sorted(call.value as Answers),
						sorted(watcher.last),
						"the second index told what it had",
					);
					watcher.last = call.value as Answers;
				},
				end: () => assert.fail("the second index ended a watcher"),
			};
			const attached = await this.#index.attach(workspace, caller, observer, context);
			watcher.last = attached!.value;
			this.#watchers.push(watcher);
		}
	}

	async changed(): Promise<void> {
		await this.#index.changed({ workspaces: new Set(this.#r.workspaces), persons: new Set(this.#r.persons) });
		this.#index.forgetUnwatched();
	}

	check(all: Everything, step: number): void {
		for (const watcher of this.#watchers) {
			assert.deepEqual(
				sorted(watcher.last),
				sorted(answersFrom(all, KINDS, watcher.workspace, watcher.caller)),
				`step ${step}: the second index is behind`,
			);
		}
		assert.ok(this.#index.loaded().workspaces <= this.#watched() + 2 + MAX_DEPTH * this.#watchers.length);
	}

	#watched(): number {
		return new Set(this.#watchers.map(({ workspace }) => workspace)).size;
	}
}

/** The test kind as the store's index looks kinds up. */
const LOOKUP = lookupOf(new Map([[Board.name, { plugin: BOARD_PLUGIN, value: Board.info }]]));

describe("the index against the reference", () => {
	for (const seed of [1, 2, 3, 4, 5, 6]) {
		it(`random writes agree with the reference, seed ${seed}`, (t) => run(t, seed, 150, false));
	}
	for (const seed of [7, 8]) {
		it(`the same with an index that forgets all the time, seed ${seed}`, (t) => run(t, seed, 150, true));
	}
});

describe("the index's own mechanics", () => {
	/** A reader over workspaces kept in a map (the tests change them by hand). */
	const reader = (workspaces: Map<string, { parent: string; members: string[] }>): Reader => ({
		workspace: async (id) => {
			const found = workspaces.get(id);
			if (found === undefined) return undefined;
			return {
				parent: found.parent,
				showsThings: true,
				showsPeople: true,
				links: new Map(found.parent === "" ? [["sketch", Board.name]] : []),
				members: new Set(found.members),
				switches: new Map(),
				hides: new Set(),
				grants:
					found.parent === ""
						? [
								{
									thing: "sketch",
									party: "everyone",
									audience: "people",
									tick: "read",
									gives: true,
								},
							]
						: [],
			};
		},
		person: async () => ({ owner: false, groups: [] }),
	});
	const observer = (told: Answers[]): FollowObserver<unknown> => ({
		advance: (call) => void (call.kind === "value" && told.push(call.value as Answers)),
		end: () => {},
	});

	it("a workspace asked about before it exists answers nothing, and what it gives once made under one not loaded", async () => {
		const workspaces = new Map([
			["pi", { parent: "", members: [] as string[] }],
			["team", { parent: "pi", members: [] as string[] }],
		]);
		const index = new AccessIndex(reader(workspaces), () => LOOKUP, context);
		const told: Answers[] = [];
		const ada = { kind: "person", person: "ada" } as const;
		const attached = await index.attach("later", ada, observer(told), context);
		assert.deepEqual(attached?.value, {});
		workspaces.set("later", { parent: "team", members: ["person/ada"] });
		await index.changed({ workspaces: new Set(["later"]), persons: new Set() });
		assert.deepEqual(told, [{ sketch: { ticks: ["read"] } }]);
		assert.deepEqual(index.loaded().workspaces, 3);
	});

	it("once closed it ends its watchers and attaches nothing", async () => {
		const index = new AccessIndex(reader(new Map([["pi", { parent: "", members: [] }]])), () => LOOKUP, context);
		const ended: string[] = [];
		await index.attach(
			"pi",
			{ kind: "agent", session: "s" },
			{ advance: () => {}, end: (end) => void ended.push(end.kind) },
			context,
		);
		index.close();
		assert.deepEqual(ended, ["failed"]);
		assert.equal(index.open, false);
		assert.equal(await index.attach("pi", { kind: "agent", session: "s" }, observer([]), context), undefined);
	});
});

describe("round 1's reproductions (Astra)", () => {
	const who = { kind: "person", person: "p" } as const;
	const none: FollowObserver<unknown> = { advance() {}, end() {} };
	const kinds = { tickFor: () => "all" as const, ticksOf: () => ["a"] };
	const person = async () => ({ owner: true, groups: [] });
	const rows = (...ids: string[]) => ({
		parent: "",
		showsThings: true,
		showsPeople: true,
		links: new Map(ids.map((id) => [id, "board"])),
		members: new Set<string>(),
		switches: new Map<string, boolean>(),
		hides: new Set<string>(),
		grants: [],
	});
	const touched = (id: string) => ({ workspaces: new Set([id]), persons: new Set<string>() });

	it("Astra 6: close fences an attach that is loading", async () => {
		const started = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const workspace = async () => {
			started.resolve();
			await release.promise;
			return rows();
		};
		const index = new AccessIndex({ person, workspace }, () => kinds, context);
		const pending = index.attach("w", who, none, context);
		await started.promise;
		index.close();
		release.resolve();
		assert.equal(await pending, undefined);
		assert.equal(index.loaded().views, 0);
	});

	it("Astra 2: a failed re-read serves nothing stale: its watchers end, the next attach loads what is on disk", async () => {
		let fail = false;
		let entries = rows();
		const workspace = async () => {
			if (fail) throw new Error("read failed");
			return entries;
		};
		const ended: string[] = [];
		const index = new AccessIndex({ person, workspace }, () => kinds, context);
		await index.attach("w", who, { advance() {}, end: (end) => void ended.push(end.kind) }, context);
		entries = rows("new-board");
		fail = true;
		const reported = mock.method(console, "error", () => {});
		await index.changed(touched("w"));
		reported.mock.restore();
		assert.deepEqual(ended, ["failed"]);
		assert.deepEqual(index.loaded(), { workspaces: 0, persons: 0, views: 0 });
		fail = false;
		const again = await index.attach("w", who, none, context);
		assert.ok(again?.value["new-board"]);
		assert.equal(index.open, true);
	});

	it("Astra 7: unwatched persons count against the budget", async () => {
		const index = new AccessIndex({ person, workspace: async () => rows() }, () => kinds, context, 2);
		for (let i = 0; i < 256; i++) {
			(await index.attach("w", { kind: "person", person: String(i) }, none, context))?.detach();
		}
		const size = index.loaded();
		assert.equal(size.views, 0);
		assert.ok(size.persons <= 3, `${size.persons} persons kept, none watched`);
	});

	it("Astra 11: a watcher detached by another's advance is not told; one that throws keeps no other from being told", async () => {
		let entries = rows();
		const index = new AccessIndex({ person, workspace: async () => entries }, () => kinds, context);
		let detachSecond = () => {};
		let second = 0;
		let third = 0;
		const bad: FollowObserver<unknown> = {
			advance: () => {
				detachSecond();
				throw new Error("observer failed");
			},
			end() {},
		};
		await index.attach("w", who, bad, context);
		const attached = await index.attach("w", who, { advance: () => void second++, end() {} }, context);
		await index.attach("w", who, { advance: () => void third++, end() {} }, context);
		detachSecond = attached!.detach;
		entries = rows("new-board");
		const reported = mock.method(console, "error", () => {});
		await index.changed(touched("w"));
		reported.mock.restore();
		assert.deepEqual([second, third], [0, 1]);
		assert.equal(reported.mock.callCount(), 1);
	});

	it("Astra 8: a write with no access change walks no loaded workspace", async () => {
		const index = new AccessIndex({ person, workspace: async () => rows() }, () => kinds, context);
		for (let i = 0; i < 256; i++) (await index.attach(String(i), who, none, context))?.detach();
		let probes = 0;
		class Counted extends Set<string> {
			override has(value: string) {
				probes++;
				return super.has(value);
			}
		}
		await index.changed({ workspaces: new Counted(), persons: new Set() });
		assert.equal(probes, 0);
	});

	it("Astra 9: the grants of a wide workspace are classified in linear time", () => {
		const n = 128;
		let visits = 0;
		const ids = Array.from({ length: n }, (_, i) => String(i));
		const grants = ids.map((id) => ({
			get thing() {
				visits++;
				return id;
			},
			party: "everyone",
			audience: "people" as const,
			tick: "a",
			gives: true,
		}));
		accessHere(ABOVE_THE_ROOT, { ...rows(...ids), grants }, kinds);
		assert.ok(visits <= 2 * n, `${visits} reads of a grant's thing for ${n} links and ${n} grants`);
	});

	it("an answer handed out never changes; an unchanged thing's answer keeps its object", async () => {
		let entries = rows("kept");
		let next: Answers | undefined;
		const index = new AccessIndex({ person, workspace: async () => entries }, () => kinds, context);
		const observer: FollowObserver<unknown> = {
			advance: (call) => {
				if (call.kind === "value") next = call.value as Answers;
			},
			end() {},
		};
		const attached = (await index.attach("w", who, observer, context))!;
		const old = attached.value;
		const copy = structuredClone(old);
		entries = rows("kept", "added");
		await index.changed(touched("w"));
		assert.deepEqual(old, copy);
		assert.notEqual(next, old);
		assert.equal(next?.kept, old.kept);
		attached.detach();
	});
});

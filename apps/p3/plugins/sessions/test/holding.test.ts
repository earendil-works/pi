// The holding (`holding.ts`) and what it learns its things from (`AgentThings`, `agent-things.ts`): a session's
// worker, linked to a server with the things plugin as a real worker is, holds one reference per thing the session's
// workspace gives its agent, of the kinds with a harness part on the worker, as the agent, and publishes them in
// `HeldThings`: nothing (`undefined`) until its first set settled, then a change gives only its kind a new array, once
// per batch (a thing given, taken away, granted anew, failed, its part replaced or removed), the kinds in a stable
// order; a reload of a kind's plugin keeps the references, a reload of the sessions plugin hands them over, so calls
// under way finish; holding 40 things opens one `Gives`; what it let go of is collected; `AgentThings` is for a
// session's worker only, about its own session.

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
	type ChordStore,
	BACKGROUND_CONTEXT as context,
	createHost,
	defineFacet,
	type Host,
	memoryLinkPair,
	method,
	type P3Principal,
	type PluginFacet,
	type Reference,
	Session,
	until,
} from "@earendil-works/p3/v1";
import { type WorkerRuntime, WorkerRuntime as WorkerRuntimeRegistry } from "@earendil-works/p3/v1/worker";
import { collected, within } from "../../../test/until.ts";
import { ThingsStore } from "../../things/contract.server.ts";
import type { Party, Source } from "../../things/contract.ts";
import { type Held, HeldThings, ThingHarnessParts, thingHarnessPart } from "../../things/contract.worker.ts";
import { defineThing } from "../../things/kind.ts";
import { serveThing } from "../../things/serve.ts";
import { Board } from "../../things/test/kinds.ts";
import { type World, world } from "../../things/test/world.ts";
import thingsWorker from "../../things/worker.ts";
import { serveAgentThings } from "../agent-things.ts";
import { AgentThings } from "../contract.ts";
import { serveHolding } from "../holding.ts";

const BY: Source = { kind: "plugin", plugin: "test" };

/** A second kind, so a change of one kind can be told from the other's. */
const Pad = defineThing("test.pad", {
	version: 1,
	makers: "anyone",
	methods: { write: method() },
	ticks: { write: { label: { namespace: "test", key: "write", params: [] }, gives: ["write"] } },
	defaultGrants: { agents: ["write"] },
});

const padFacet = defineFacet((host) => serveThing(host, Pad, { implement: () => ({ write: async () => null }) }));

/** The sessions plugin's server part under test: `AgentThings` only. */
const agentThingsFacet = defineFacet((host) => serveAgentThings(host));

/** `Kind`'s part on the worker, in a plugin of its own: it gives nothing (the harness's tests call parts). */
function partFacet(Kind: typeof Board | typeof Pad): PluginFacet<P3Principal> {
	return {
		name: `p3-test-part-${Kind.name}`,
		facet: defineFacet((_host, self) => {
			self.contribute(
				ThingHarnessParts,
				// Either kind: the part's things are typed by it only.
				thingHarnessPart(Kind as typeof Board, () => ({})),
			);
		}),
	};
}

let w: World;
let store: Reference<typeof ThingsStore>;
/** The session's workspace: its id is the session's. */
let session: string;
let worker: Host<P3Principal>;
/** The worker's facets as loaded now: a reload replaces only the plugin under change. */
let facets: PluginFacet<P3Principal>[];

/** The worker's facets: the base's runtime, the things plugin's worker facet, the kinds' parts and the holding. */
function workerFacets(): PluginFacet<P3Principal>[] {
	// The holding reads only `host` and `session` of the runtime.
	const runtime = { session, host: worker, store: {} as ChordStore, dir: "", idleMs: 0, close: () => {} };
	return [
		{
			name: "p3.worker",
			facet: defineFacet((host) => host.serve(WorkerRuntimeRegistry, { compose: (): WorkerRuntime => runtime })),
		},
		{ name: "@earendil-works/p3-things", facet: thingsWorker },
		partFacet(Board),
		partFacet(Pad),
		{ name: SESSIONS, facet: defineFacet((host) => serveHolding(host)) },
	];
}

const SESSIONS = "@earendil-works/p3-sessions";

/** Reloads the worker with plugin `name`'s facet replaced (left out: renewed, as after an edit), or removed (`null`). */
async function reloadWorker(name: string, facet?: PluginFacet<P3Principal>["facet"] | null): Promise<void> {
	facets =
		facet === null
			? facets.filter((plugin) => plugin.name !== name)
			: facets.map((plugin) => (plugin.name === name ? { ...plugin, facet: facet ?? { ...plugin.facet } } : plugin));
	assert.deepEqual((await worker.reload(facets, context)).failed, []);
}

/** Replaces `Kind`'s part on the worker with a new one (over `Kind`, the same object or a new, equal one). */
const replacePart = (Kind: typeof Board | typeof Pad) => reloadWorker(partFacet(Kind).name, partFacet(Kind).facet);

/** Renews the sessions plugin's facet on the worker, as after an edit: a new holding. */
const reloadHolding = () => reloadWorker(SESSIONS);

/** Gives the agents `ticks` on `thing` (source: the test), or withholds them. */
const grant = (thing: string, ticks: string[], gives = true) =>
	store.setGrants(
		{ source: BY, grants: ticks.map((tick) => ({ workspace: session, thing, party: AGENTS, tick, gives })) },
		context,
	);

const AGENTS: Party = { kind: "agents" };

/** Makes a thing of `kind` in the session's workspace. */
const make = (kind: string, name = "t") => store.create({ kind, name, workspace: session, by: BY }, context);

/** The worker's `HeldThings` once it is published and `done` holds for it. */
async function held(done: (value: Held) => boolean, what: string): Promise<Held> {
	const value = await until(
		await worker.registry(HeldThings, context),
		(v) => v !== undefined && done(v),
		within(what, context),
	);
	return value!;
}

/** Every value `HeldThings` takes from now on, until `stop`. */
async function publications(): Promise<{ readonly values: (Held | undefined)[]; stop(): Promise<void> }> {
	const watch = await (await worker.registry(HeldThings, context)).watch(context);
	const values: (Held | undefined)[] = [];
	watch.start(async (call) => {
		if (call.kind === "value") values.push(call.value);
	});
	return {
		values,
		stop: async () => {
			await watch.stop();
		},
	};
}

/** The thing ids of `kind` in `value`. */
const ids = (value: Held, kind: string) => (value.get(kind) ?? []).map(({ thing }) => thing);

/** Pad's server facet whose objects wait for `gate` (once `entered`) before they go live. */
function gatedPad(gate: Promise<void>, entered: () => void) {
	return defineFacet((host) =>
		serveThing(host, Pad, {
			implement: (_params, _admitted, self) => {
				self.open(
					async () => {
						entered();
						await gate;
					},
					() => {},
				);
				return { write: async () => null };
			},
		}),
	);
}

beforeEach(async () => {
	w = await world(context, [
		{ name: "p3-test-pad", facet: padFacet },
		{ name: SESSIONS, facet: agentThingsFacet },
	]);
	store = await w.host.get(ThingsStore, {}, context);
	const pi = (await store.workspaces.children.page({ parent: "" }, 1, context)).items[0]!.workspace;
	session = await store.createWorkspace({ kind: "things.workspace", name: "s", parent: pi, by: BY }, context);
	await store.putParty({ workspace: session, party: { kind: "agent", session }, source: BY }, context);
	worker = createHost<P3Principal>({
		address: Session({ id: session }),
		principal: { kind: "worker", session },
		readyTimeout: 5000,
		onError: (error) => console.error("holding test: the worker:", error),
	});
	const [up, down] = memoryLinkPair();
	worker.connect(up, { principal: { kind: "server" }, trusted: true }, context);
	w.host.connect(down, { principal: { kind: "worker", session }, trusted: true }, context);
	facets = workerFacets();
	const loaded = await worker.load(facets, context);
	if (loaded.failed.length > 0) throw new Error("holding test: the worker failed", { cause: loaded.failed[0]!.error });
});

afterEach(async () => {
	await worker.close(context);
	await w.close(context);
});

describe("the holding", () => {
	it("holds each thing the session gives its agent, as the agent, with what its ticks give", async () => {
		const board = await make(Board.name);
		const pad = await make(Pad.name);
		const value = await held((v) => ids(v, Board.name).length === 1 && ids(v, Pad.name).length === 1, "both held");
		const [heldBoard] = value.get(Board.name)!;
		assert.equal(heldBoard!.thing, board);
		assert.equal(heldBoard!.workspace, session);
		// The kind's default grant for the agents: Read only.
		assert.deepEqual([...heldBoard!.ref.granted], ["read"]);
		// Held as a board: the part's kind.
		const ref = heldBoard!.ref as unknown as Reference<typeof Board.contract>;
		assert.equal(await ref.read!(context), "agent");
		assert.equal(value.get(Pad.name)![0]!.thing, pad);
	});

	it("gives only the changed kind a new array: a thing given, granted anew, taken away", async () => {
		const board = await make(Board.name);
		await make(Pad.name);
		const first = await held((v) => v.has(Board.name) && v.has(Pad.name), "both held");
		const pads = first.get(Pad.name);
		await grant(board, ["bash"]);
		// A reference's `granted` is live: the new array is what tells the harness.
		const regranted = await held((v) => v.get(Board.name) !== first.get(Board.name), "the regrant");
		assert.equal(regranted.get(Board.name)![0]!.ref.granted.has("bash"), true);
		assert.equal(regranted.get(Pad.name), pads);
		const second = await make(Board.name, "b2");
		const two = await held((v) => ids(v, Board.name).length === 2, "a second board");
		assert.deepEqual(ids(two, Board.name), [board, second].toSorted());
		assert.equal(two.get(Pad.name), pads);
		await store.unlink({ workspace: session, thing: board }, context);
		const one = await held((v) => ids(v, Board.name).length === 1, "the unlink");
		assert.deepEqual(ids(one, Board.name), [second]);
		assert.equal(one.get(Pad.name), pads);
	});

	it("drops a thing withheld from the agents by every route", async () => {
		const board = await make(Board.name);
		await held((v) => v.has(Board.name), "held");
		await grant(board, ["@open"], false);
		await held((v) => !v.has(Board.name), "withheld");
	});

	it("holds no thing of a kind without a part here, and drops a kind whose part goes", async () => {
		await make(Board.name);
		await make(Pad.name);
		const before = await held((v) => v.has(Board.name) && v.has(Pad.name), "both held");
		await reloadWorker(partFacet(Pad).name, null);
		const after = await held((v) => !v.has(Pad.name), "the pad's part gone");
		assert.equal(after.size, 1);
		assert.equal(after.get(Board.name), before.get(Board.name));
	});

	it("holds again after the sessions plugin is reloaded while things are held", async () => {
		const board = await make(Board.name);
		const before = await held((v) => v.has(Board.name), "held");
		await reloadHolding();
		const after = await held((v) => v.get(Board.name) !== before.get(Board.name) && v.has(Board.name), "re-held");
		assert.deepEqual(ids(after, Board.name), [board]);
		assert.equal(
			await (after.get(Board.name)![0]!.ref as unknown as Reference<typeof Board.contract>).read!(context),
			"agent",
		);
	});

	it("keeps the references when a kind's plugin is reloaded (a new, equal kind object), its kind a new array", async () => {
		const board = await make(Board.name);
		await make(Pad.name);
		const before = await held((v) => v.has(Board.name) && v.has(Pad.name), "both held");
		await replacePart({ ...Board });
		const after = await held((v) => v.get(Board.name) !== before.get(Board.name), "a new board list");
		assert.deepEqual(ids(after, Board.name), [board]);
		assert.equal(after.get(Board.name)![0]!.ref, before.get(Board.name)![0]!.ref);
		assert.equal(after.get(Pad.name), before.get(Pad.name));
	});

	// Astra, round 1 (should 4): a new part over the same kind object.
	it("gives a kind a new array when its part is replaced over the same kind object", async () => {
		await make(Board.name);
		await make(Pad.name);
		const before = await held((v) => v.has(Board.name) && v.has(Pad.name), "both held");
		await replacePart(Pad);
		const after = await held((v) => v.get(Pad.name) !== before.get(Pad.name), "a new pad list");
		assert.equal(after.get(Pad.name)![0]!.ref, before.get(Pad.name)![0]!.ref);
		assert.equal(after.get(Board.name), before.get(Board.name));
	});

	// Fable, round 1 (must 1): the new reference is live before it is watched.
	it("lists a thing another holder on the worker has live already", async () => {
		const board = await make(Board.name);
		const before = await held((v) => v.has(Board.name), "held");
		// As a tool's `session.call` holds it while it runs: the holding's new reference is live before it is watched.
		const other = worker.hold(Board.contract, { workspace: session, thing: board }, context);
		await until(other.state, (state) => state.kind === "live", within("the other holder", context));
		await reloadHolding();
		const after = await held((v) => v.get(Board.name) !== before.get(Board.name) && v.has(Board.name), "re-held");
		assert.deepEqual(ids(after, Board.name), [board]);
		other.release();
	});

	// Fable, round 1 (should 2), Astra (should 5).
	it("keeps the kinds in the order of their first things, whatever changed before", async () => {
		const board = await make(Board.name);
		const pad = await make(Pad.name);
		const first = await held((v) => v.has(Board.name) && v.has(Pad.name), "both held");
		const order = (things: readonly [string, string][]) => things.toSorted().map(([, kind]) => kind);
		assert.deepEqual(
			[...first.keys()],
			order([
				[board, Board.name],
				[pad, Pad.name],
			]),
		);
		await grant(board, ["bash"]);
		const regranted = await held((v) => v.get(Board.name) !== first.get(Board.name), "the regrant");
		assert.deepEqual([...regranted.keys()], [...first.keys()]);
		await store.unlink({ workspace: session, thing: board }, context);
		await held((v) => !v.has(Board.name), "the unlink");
		const again = await make(Board.name, "b2");
		const back = await held((v) => v.has(Board.name), "a board again");
		assert.deepEqual(
			[...back.keys()],
			order([
				[again, Board.name],
				[pad, Pad.name],
			]),
		);
	});

	it("holds 40 things with one Gives", async () => {
		const before = w.count("things.access.attaches");
		for (let i = 0; i < 40; i++) await make(Board.name, `b${i}`);
		await held((v) => ids(v, Board.name).length === 40, "40 held");
		// The worker's AgentThings attaches once; each held thing's admission reads the same Gives.
		assert.equal(w.count("things.access.attaches") - before, 1);
	});

	it("lets go of what it no longer holds", async () => {
		const board = await make(Board.name);
		// Weakly only: the test keeps no map, array or reference itself.
		const refs = await held((v) => v.has(Board.name), "held").then((value) => [
			new WeakRef(value.get(Board.name)![0]!.ref),
			new WeakRef(value.get(Board.name)!),
		]);
		await store.unlink({ workspace: session, thing: board }, context);
		await held((v) => !v.has(Board.name), "the unlink");
		assert.equal(await collected(refs), true);
	});
});

describe("the holding's readiness and batches", () => {
	// Opus S1, Astra 1, Fable S6 (round 1): no step runs against a partial set.
	it("publishes nothing until every reference of its first set settled, then all of it at once", async () => {
		const gate = Promise.withResolvers<void>();
		const entered = Promise.withResolvers<void>();
		await w.reload("p3-test-pad", context, gatedPad(gate.promise, entered.resolve));
		await make(Board.name);
		await make(Pad.name);
		await entered.promise;
		const last = await held((v) => v.has(Board.name), "the board");
		const seen = await publications();
		await reloadHolding();
		await until(await worker.registry(HeldThings, context), (v) => v === undefined, within("unpublished", context));
		gate.resolve();
		await held((v) => v.has(Board.name) && v.has(Pad.name), "both held");
		await seen.stop();
		const after = seen.values.filter((value) => value !== last);
		assert.equal(after.includes(undefined), true);
		assert.deepEqual(
			after.filter((value) => value !== undefined).map((value) => [...value.keys()].length),
			[2],
		);
	});

	// Opus S3, Astra 6, Fable (round 1): one publication for 39 things, not one per thing.
	it("publishes 39 things going live once, at a reload of the sessions plugin and of a kind's plugin", async () => {
		for (let i = 0; i < 39; i++) await make(Board.name, `b${i}`);
		const pad = await make(Pad.name);
		const first = await held((v) => ids(v, Board.name).length === 39 && v.has(Pad.name), "all held");
		const seen = await publications();
		await reloadHolding();
		const again = await held((v) => v !== first && ids(v, Board.name).length === 39, "held again");
		await replacePart({ ...Board });
		await held((v) => v.get(Board.name) !== again.get(Board.name), "the board's part replaced");
		await seen.stop();
		const counts = seen.values
			.filter((value) => value !== undefined && value !== first)
			.map((value) => ids(value!, Board.name).length);
		assert.deepEqual(counts, [39, 39]);
		assert.deepEqual(ids(seen.values.at(-1)!, Pad.name), [pad]);
	});

	// Astra, round 1 (must 3).
	it("takes a failed reference out of its kind's list and lists it again once it recovers", async () => {
		await make(Board.name);
		await make(Pad.name);
		const before = await held((v) => v.has(Board.name) && v.has(Pad.name), "both live");
		const ref = before.get(Pad.name)![0]!.ref;
		const broken = defineFacet((host) =>
			serveThing(host, Pad, {
				implement: (_params, _admitted, self) => {
					self.open(
						async () => {
							throw new Error("pad load failed");
						},
						() => {},
					);
					return { write: async () => null };
				},
			}),
		);
		await w.reload("p3-test-pad", context, broken);
		await until(ref.state, (state) => state.kind === "failed", within("the broken object", context));
		const failed = await held((v) => !v.has(Pad.name), "not listed while failed");
		assert.equal(failed.get(Board.name), before.get(Board.name));
		await w.reload("p3-test-pad", context, padFacet);
		const healed = await held((v) => v.has(Pad.name), "listed again");
		assert.equal(healed.get(Pad.name)![0]!.ref, ref);
	});

	// Opus S4 (round 1): a rebind on the server ("loading changes nothing").
	for (const plugin of ["@earendil-works/p3-things", "p3-test-pad", SESSIONS]) {
		it(`keeps every array through a server reload of ${plugin}`, async () => {
			await make(Board.name);
			await make(Pad.name);
			const before = await held((v) => v.has(Board.name) && v.has(Pad.name), "both held");
			const seen = await publications();
			await w.reload(plugin, context);
			for (const [, [thing]] of before) {
				await until(thing!.ref.state, (state) => state.kind === "live", within("live again", context));
			}
			// A rebind with the same grant is no change: the admission's `granted` is one shared set per grant.
			await grant(before.get(Board.name)![0]!.thing, ["bash"]);
			await held((v) => v.get(Board.name) !== before.get(Board.name), "a regrant after the reload");
			await seen.stop();
			const changed = seen.values;
			assert.equal(changed.length, 1);
			assert.equal(changed[0]!.get(Pad.name), before.get(Pad.name));
		});
	}
});

describe("the holding's calls under way", () => {
	for (const change of ["the kind's plugin reloaded", "the sessions plugin reloaded"] as const) {
		// Astra, round 1 (must 4).
		it(`lets a call under way through a held reference finish: ${change}`, async () => {
			const entered = Promise.withResolvers<void>();
			const finish = Promise.withResolvers<void>();
			await w.reload(
				"p3-test-pad",
				context,
				defineFacet((host) =>
					serveThing(host, Pad, {
						implement: () => ({
							write: async () => {
								entered.resolve();
								await finish.promise;
								return null;
							},
						}),
					}),
				),
			);
			await make(Pad.name);
			const first = await held((v) => v.has(Pad.name), "the pad held");
			const old = first.get(Pad.name)![0]!.ref as unknown as Reference<typeof Pad.contract>;
			const settled = old.write!(context).then(
				() => "finished",
				(error: Error & { code?: string }) => `failed: ${error.code}`,
			);
			await entered.promise;
			try {
				if (change === "the kind's plugin reloaded") await replacePart({ ...Pad });
				else await reloadHolding();
				await held((v) => v.has(Pad.name) && v.get(Pad.name) !== first.get(Pad.name), "the change published");
			} finally {
				finish.resolve();
			}
			assert.equal(await settled, "finished");
		});
	}

	// Astra, round 1 (must 4, its first case): Chord seals the admitted object on a regrant, so a call under way through
	// it fails `unavailable` whatever the holding does; the next step has no tool. Accepted for now as the narrower
	// promise (main, 2026-11-27); item 116 wants it to finish: the Chord issue "a regrant lets calls under way finish".
	it(
		"lets a call under way finish when a tick is withheld from the agents",
		{ todo: "Chord issue: a regrant lets calls under way finish" },
		async () => {
			const entered = Promise.withResolvers<void>();
			const finish = Promise.withResolvers<void>();
			await w.reload(
				"p3-test-pad",
				context,
				defineFacet((host) =>
					serveThing(host, Pad, {
						implement: () => ({
							write: async () => {
								entered.resolve();
								await finish.promise;
								return null;
							},
						}),
					}),
				),
			);
			const pad = await make(Pad.name);
			// The agents stay let in after Write is withheld.
			await grant(pad, ["@open"]);
			const first = await held((v) => v.has(Pad.name), "the pad held");
			const old = first.get(Pad.name)![0]!.ref as unknown as Reference<typeof Pad.contract>;
			const settled = old.write!(context).then(
				() => "finished",
				(error: Error & { code?: string }) => `failed: ${error.code}`,
			);
			await entered.promise;
			await grant(pad, ["write"], false);
			await until(old.state, (state) => state.kind === "loading", within("the regrant", context));
			finish.resolve();
			assert.equal(await settled, "finished");
		},
	);

	it("lets go of the old array but keeps the reference when a kind's plugin is reloaded", async () => {
		await make(Board.name);
		await make(Pad.name);
		const [oldArray, ref, boards] = await held((v) => v.has(Board.name) && v.has(Pad.name), "both held").then(
			(v) => [new WeakRef(v.get(Pad.name)!), v.get(Pad.name)![0]!.ref, v.get(Board.name)!] as const,
		);
		await replacePart({ ...Pad });
		const after = await held((v) => v.has(Pad.name) && v.get(Pad.name) !== oldArray.deref(), "the pad again");
		assert.equal(after.get(Board.name), boards);
		assert.equal(after.get(Pad.name)![0]!.ref, ref);
		assert.equal(await collected([oldArray]), true);
	});

	// Astra, round 1 (carry to depth): nearest last needs the index's depth (slice 2 follow-up).
	it(
		"lists a nearer link last, whatever the ids",
		{ todo: "Gives answers carry no depth yet (slice 2)" },
		async () => {
			const pi = (await store.workspaces.children.page({ parent: "" }, 1, context)).items[0]!.workspace;
			await reloadWorker(partFacet(Board).name, null);
			const [near, far] = (
				await Promise.all(
					[0, 1].map((i) =>
						store.create({ workspace: pi, kind: Board.name, name: `board ${i}`, by: BY }, context),
					),
				)
			).sort();
			await store.link({ workspace: session, thing: near! }, context);
			await store.unlink({ workspace: pi, thing: near! }, context);
			await reloadWorker(partFacet(Board).name, partFacet(Board).facet);
			const value = await held((v) => ids(v, Board.name).length === 2, "two boards");
			assert.deepEqual(ids(value, Board.name), [far, near]);
		},
	);
});

describe("AgentThings", () => {
	it("is for a session's worker only", async () => {
		await assert.rejects(w.host.get(AgentThings, {}, context, { readyTimeout: 500 }), /a session's worker only/);
	});

	// Astra, round 1.
	it("answers a worker about its own session, never a person", async () => {
		await make(Pad.name);
		await held((v) => v.has(Pad.name), "the pad held");
		await assert.rejects(
			w.host.root(async (ctx) => (await ctx.get(AgentThings, {})).things.value, context, {
				principal: { kind: "person", id: "p", name: "P" },
			}),
			(error: Error & { code?: string }) => error.code === "forbidden",
		);
		const other = await w.host.root(async (ctx) => (await ctx.get(AgentThings, {})).things.value, context, {
			principal: { kind: "worker", session: "other" },
		});
		assert.deepEqual(other, []);
	});
});

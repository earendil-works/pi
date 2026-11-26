// The holding (`holder.ts`) and what it learns its things from (`AgentThings`, `agent-things.ts`): a session's worker,
// linked to a server with the things plugin as a real worker is, holds one reference per thing the session's
// workspace gives its agent, of the kinds with a harness part on the worker, as the agent, and publishes them in
// `HeldThings`; a change gives only its kind a new array (a thing given, taken away, granted anew, its part removed);
// holding 40 things opens one `Gives`; what it let go of is collected; `AgentThings` is for a session's worker only.

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
import { serveHolding } from "../holder.ts";

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

/** The worker's facets: the base's runtime, the things plugin's worker facet, the kinds' parts and the holding. */
function workerFacets(
	parts: readonly PluginFacet<P3Principal>[] = [partFacet(Board), partFacet(Pad)],
): PluginFacet<P3Principal>[] {
	// The holding reads only `host` and `session` of the runtime.
	const runtime = { session, host: worker, store: {} as ChordStore, dir: "", idleMs: 0, close: () => {} };
	return [
		{
			name: "p3.worker",
			facet: defineFacet((host) => host.serve(WorkerRuntimeRegistry, { compose: (): WorkerRuntime => runtime })),
		},
		{ name: "@earendil-works/p3-things", facet: thingsWorker },
		...parts,
		{ name: "@earendil-works/p3-sessions", facet: defineFacet((host) => serveHolding(host)) },
	];
}

/** Gives the agents `ticks` on `thing` (source: the test), or withholds them. */
const grant = (thing: string, ticks: string[], gives = true) =>
	store.setGrants(
		{ source: BY, grants: ticks.map((tick) => ({ workspace: session, thing, party: AGENTS, tick, gives })) },
		context,
	);

const AGENTS: Party = { kind: "agents" };

/** Makes a thing of `kind` in the session's workspace. */
const make = (kind: string, name = "t") => store.create({ kind, name, workspace: session, by: BY }, context);

/** The worker's `HeldThings` once `done` holds for it. */
async function held(done: (value: Held) => boolean, what: string): Promise<Held> {
	return until(await worker.registry(HeldThings, context), done, within(what, context));
}

/** The thing ids of `kind` in `value`. */
const ids = (value: Held, kind: string) => (value.get(kind) ?? []).map(({ thing }) => thing);

beforeEach(async () => {
	w = await world(context, [
		{ name: "p3-test-pad", facet: padFacet },
		{ name: "@earendil-works/p3-sessions", facet: agentThingsFacet },
	]);
	store = await w.host.get(ThingsStore, {}, context);
	const pi = (await store.workspaces.children.page({ parent: "" }, 1, context)).items[0]!.workspace;
	session = await store.createWorkspace({ kind: "things.workspace", name: "s", parent: pi, by: BY }, context);
	await store.putParty({ workspace: session, party: { kind: "agent", session }, source: BY }, context);
	worker = createHost<P3Principal>({
		address: Session({ id: session }),
		principal: { kind: "worker", session },
		readyTimeout: 5000,
		onError: (error) => console.error("holder test: the worker:", error),
	});
	const [up, down] = memoryLinkPair();
	worker.connect(up, { principal: { kind: "server" }, trusted: true }, context);
	w.host.connect(down, { principal: { kind: "worker", session }, trusted: true }, context);
	const loaded = await worker.load(workerFacets(), context);
	if (loaded.failed.length > 0) throw new Error("holder test: the worker failed", { cause: loaded.failed[0]!.error });
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
		await held((v) => v.has(Board.name) && v.has(Pad.name), "both held");
		const report = await worker.reload(workerFacets([partFacet(Board)]), context);
		assert.equal(report.failed.length, 0);
		const after = await held((v) => v.has(Board.name) && !v.has(Pad.name), "the pad's part gone");
		assert.equal(after.size, 1);
	});

	it("holds again after the sessions plugin is reloaded while things are held", async () => {
		const board = await make(Board.name);
		const before = await held((v) => v.has(Board.name), "held");
		const facets = workerFacets().map((plugin) =>
			plugin.name === "@earendil-works/p3-sessions" ? { ...plugin, facet: { ...plugin.facet } } : plugin,
		);
		assert.equal((await worker.reload(facets, context)).failed.length, 0);
		const after = await held((v) => v.get(Board.name) !== before.get(Board.name) && v.has(Board.name), "re-held");
		assert.deepEqual(ids(after, Board.name), [board]);
		assert.equal(
			await (after.get(Board.name)![0]!.ref as unknown as Reference<typeof Board.contract>).read!(context),
			"agent",
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

describe("AgentThings", () => {
	it("is for a session's worker only", async () => {
		await assert.rejects(w.host.get(AgentThings, {}, context, { readyTimeout: 500 }), /a session's worker only/);
	});
});

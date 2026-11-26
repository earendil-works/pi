// The holding's numbers (ERNDL-704, slice 5): a session's worker holding the things its workspace gives its agent
// (`plugins/sessions/holding.ts`). A server with the things plugin and `AgentThings`, a worker host linked to it over
// an in-memory link (one process, as the plugin tier's tests run), the things made before the worker loads. Measured,
// with none and with 39 boards (medians of 30 after one cold run, min and max beside them):
// - the worker's load until `HeldThings` lists every thing (with none: until it is published);
// - a reload of the sessions plugin on the worker until the new holding published again;
// - how many values `HeldThings` takes at the start and at the reload (one each: the batches);
// - the heap of 40 held things over none (after GC; server and worker together).
// Run from apps/p3 with Node 26:
//   node --expose-gc --conditions=source --disable-warning=ExperimentalWarning bench/holding.ts

import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import {
	type ChordStore,
	createHost,
	defineFacet,
	type Host,
	memoryLinkPair,
	type P3Principal,
	type PluginFacet,
	Session,
	until,
} from "@earendil-works/p3/v1";
import { type WorkerRuntime, WorkerRuntime as WorkerRuntimeRegistry } from "@earendil-works/p3/v1/worker";
import { serveAgentThings } from "../plugins/sessions/agent-things.ts";
import { serveHolding } from "../plugins/sessions/holding.ts";
import { ThingsStore } from "../plugins/things/contract.server.ts";
import type { Source } from "../plugins/things/contract.ts";
import { type Held, HeldThings, ThingHarnessParts, thingHarnessPart } from "../plugins/things/contract.worker.ts";
import { Board } from "../plugins/things/test/kinds.ts";
import { type World, world } from "../plugins/things/test/world.ts";
import thingsWorker from "../plugins/things/worker.ts";

const BY: Source = { kind: "plugin", plugin: "bench" };

const SESSIONS = "@earendil-works/p3-sessions";

const RUNS = 30;

/** A server with `n` boards in a session's workspace, and a worker host linked to it, not loaded yet. */
async function setup(n: number): Promise<{ w: World; worker: Host<P3Principal>; facets: PluginFacet<P3Principal>[] }> {
	const w = await world(context, [{ name: SESSIONS, facet: defineFacet((host) => serveAgentThings(host)) }]);
	const store = await w.host.get(ThingsStore, {}, context);
	const pi = (await store.workspaces.children.page({ parent: "" }, 1, context)).items[0]!.workspace;
	const session = await store.createWorkspace({ kind: "things.workspace", name: "s", parent: pi, by: BY }, context);
	await store.putParty({ workspace: session, party: { kind: "agent", session }, source: BY }, context);
	for (let i = 0; i < n; i++)
		await store.create({ kind: Board.name, name: `b${i}`, workspace: session, by: BY }, context);
	const worker = createHost<P3Principal>({
		address: Session({ id: session }),
		principal: { kind: "worker", session },
		onError: (error) => console.error("bench: the worker:", error),
	});
	const [up, down] = memoryLinkPair();
	worker.connect(up, { principal: { kind: "server" }, trusted: true }, context);
	w.host.connect(down, { principal: { kind: "worker", session }, trusted: true }, context);
	const runtime = { session, host: worker, store: {} as ChordStore, dir: "", idleMs: 0, close: () => {} };
	const facets: PluginFacet<P3Principal>[] = [
		{
			name: "p3.worker",
			facet: defineFacet((host) => host.serve(WorkerRuntimeRegistry, { compose: (): WorkerRuntime => runtime })),
		},
		{ name: "@earendil-works/p3-things", facet: thingsWorker },
		{
			name: "bench-part",
			facet: defineFacet((_host, self) => {
				self.contribute(
					ThingHarnessParts,
					thingHarnessPart(Board, () => ({})),
				);
			}),
		},
		{ name: SESSIONS, facet: defineFacet((host) => serveHolding(host)) },
	];
	return { w, worker, facets };
}

/** How many things `value` lists. */
const count = (value: Held) => [...value.values()].reduce((sum, list) => sum + list.length, 0);

/** One run with `n` boards: the start and the reload, in ms, and the values `HeldThings` took at each. */
async function run(n: number) {
	const { w, worker, facets } = await setup(n);
	const t0 = performance.now();
	await worker.load(facets, context);
	const registry = await worker.registry(HeldThings, context);
	const first = await until(registry, (v) => v !== undefined && count(v) === n, context);
	const start = performance.now() - t0;
	let values = 0;
	const watch = await registry.watch(context);
	watch.start(async (call) => {
		if (call.kind === "value" && call.value !== undefined) values++;
	});
	const renewed = facets.map((plugin) =>
		plugin.name === SESSIONS ? { ...plugin, facet: { ...plugin.facet } } : plugin,
	);
	const t1 = performance.now();
	await worker.reload(renewed, context);
	await until(registry, (v) => v !== undefined && v !== first && count(v) === n, context);
	const reload = performance.now() - t1;
	await watch.stop();
	await worker.close(context);
	await w.close(context);
	return { start, reload, reloadValues: values };
}

/** The median, min and max of `xs`, in ms. */
function stats(xs: readonly number[]): string {
	const sorted = xs.toSorted((a, b) => a - b);
	const ms = (x: number) => x.toFixed(2);
	return `${ms(sorted[Math.floor(sorted.length / 2)]!)} ms (${ms(sorted[0]!)} to ${ms(sorted.at(-1)!)})`;
}

/** The heap used after GC, in KiB. */
async function heap(): Promise<number> {
	for (let i = 0; i < 3; i++) {
		globalThis.gc?.();
		await new Promise((resolve) => setImmediate(resolve));
	}
	return process.memoryUsage().heapUsed / 1024;
}

/** The heap of a worker holding `n` boards, server included, settled. */
async function heapOf(n: number): Promise<number> {
	const { w, worker, facets } = await setup(n);
	await worker.load(facets, context);
	await until(await worker.registry(HeldThings, context), (v) => v !== undefined && count(v) === n, context);
	const used = await heap();
	await worker.close(context);
	await w.close(context);
	return used;
}

if (globalThis.gc === undefined) throw new Error("bench: run with --expose-gc");
for (const n of [0, 39]) {
	const cold = await run(n);
	const starts: number[] = [];
	const reloads: number[] = [];
	let reloadValues = 0;
	for (let i = 0; i < RUNS; i++) {
		const r = await run(n);
		starts.push(r.start);
		reloads.push(r.reload);
		reloadValues = r.reloadValues;
	}
	console.log(
		`${n} things: start ${stats(starts)} (cold ${cold.start.toFixed(2)}); reload ${stats(reloads)}, ${reloadValues} value(s)`,
	);
}
await heapOf(0);
const none = await heapOf(0);
const forty = await heapOf(40);
console.log(`heap of 40 held things over none: ${(forty - none).toFixed(0)} KiB`);

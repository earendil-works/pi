// Benchmark of `host.reload` (slice 7b §11): one plugin of 20 reloaded on a host with 1,000 live objects, as a pure
// swap and as a native restart. Per case: the reload's time until it resolves (staging, commit, every fate started and
// every swap checked), the time until every object of the plugin is live again, and the heap retained after 20
// reloads against after the first (old attempts and facets collected). Medians over the reloads after a warm-up.
// Run by hand from packages/chord (not in CI), pinned for comparisons:
//   taskset -c 6 node --conditions=source --experimental-strip-types --expose-gc test/next/bench/reload.ts
import { performance } from "node:perf_hooks";
import { type Context, BACKGROUND_CONTEXT as context } from "../../../src/context/index.ts";
import { int, local, method, obj } from "../../../src/next/contracts/index.ts";
import { defineState } from "../../../src/next/documents/index.ts";
import { createHost, defineFacet, type Facet, type Host, type Reference } from "../../../src/next/host/index.ts";
import { constant } from "../../../src/next/state/index.ts";

const PLUGINS = 20;
const OBJECTS = 1_000;
const RELOADS = 20;

const gc = (globalThis as { gc?: () => void }).gc!;

const Counter = defineState("bench.counter", { schema: obj({ n: int() }), version: 1, initial: () => ({ n: 0 }) });

/** The plugins' types: one per plugin, objects with params (each lives while referenced). */
const types = Array.from({ length: PLUGINS }, (_, index) =>
	local(`bench.item${index}`, {
		version: 1,
		params: { id: int() },
		members: { n: int(), label: int(), bump: method(undefined, int()) },
	}),
);

/** Plugin `index`'s facet at code version `code`; with `native`, each object opens a native. */
function facet(index: number, code: number, native: boolean): Facet<never> {
	return defineFacet((h) =>
		h.serve(types[index]!, (_, self) => {
			const counter = self.state(Counter);
			if (native)
				self.open(
					async () => code,
					() => {},
				);
			return {
				n: self.derive([counter], ([value]) => value.n),
				label: constant(code),
				bump: async (ctx: Context) => {
					await counter.change((draft) => {
						draft.n++;
					}, ctx);
					return counter.value.n;
				},
			};
		}),
	);
}

/** Whole-heap use after full collections. */
async function heap(): Promise<number> {
	for (let round = 0; round < 5; round++) {
		await new Promise((resolve) => setImmediate(resolve));
		gc();
	}
	return process.memoryUsage().heapUsed;
}

/** The median of `values`. */
function median(values: readonly number[]): number {
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[Math.floor(sorted.length / 2)]!;
}

/**
 * One case: `perPlugin(index)` objects per plugin (1,000 in all), plugin 0 reloaded `RELOADS` times; `native` makes
 * plugin 0 a native object (restarts) instead of a pure one (swaps).
 */
async function run(name: string, counts: readonly number[], native: boolean): Promise<void> {
	const host: Host = createHost({ onError: (error) => console.log("onError", error.kind) });
	const facets = Array.from({ length: PLUGINS }, (_, index) => facet(index, 0, native && index === 0));
	await host.load(
		facets.map((each, index) => ({ name: `@bench/p${index}`, facet: each as Facet<never> as never })),
		context,
	);
	const refs: Reference<(typeof types)[number]>[] = [];
	for (const [index, count] of counts.entries()) {
		for (let id = 0; id < count; id++) refs.push(await host.get(types[index]!, { id }, context));
	}
	const reloaded = refs.slice(0, counts[0]);
	const reloads: number[] = [];
	const live: number[] = [];
	let afterFirst = 0;
	for (let round = 1; round <= RELOADS; round++) {
		facets[0] = facet(0, round, native);
		const set = facets.map((each, index) => ({ name: `@bench/p${index}`, facet: each as never }));
		const started = performance.now();
		await host.reload(set, context);
		const resolved = performance.now();
		while (reloaded.some((ref) => ref.state.value.kind !== "live" || ref.label.value !== round)) {
			await new Promise((resolve) => setImmediate(resolve));
		}
		const allLive = performance.now();
		if (round > 2) {
			reloads.push(resolved - started);
			live.push(allLive - started);
		}
		if (round === 1) afterFirst = await heap();
	}
	const afterAll = await heap();
	console.log(
		`${name}: reload resolves in ${median(reloads).toFixed(2)} ms, all ${counts[0]} live again in ${median(live).toFixed(2)} ms; ` +
			`heap after ${RELOADS} reloads ${((afterAll - afterFirst) / 1024).toFixed(0)} KiB above after the first`,
	);
	await host.close(context);
}

const spread = Array.from({ length: PLUGINS }, () => OBJECTS / PLUGINS);
const concentrated = [OBJECTS, ...Array.from({ length: PLUGINS - 1 }, () => 0)];
await run("swap, 50 of 1,000 objects in the reloaded plugin", spread, false);
await run("swap, all 1,000 objects in the reloaded plugin", concentrated, false);
await run("restart, 50 of 1,000 objects in the reloaded plugin", spread, true);
await run("restart, all 1,000 objects in the reloaded plugin", concentrated, true);

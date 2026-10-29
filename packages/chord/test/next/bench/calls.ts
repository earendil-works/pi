// Benchmark of the paths slice 8 touched under every object (no registries involved): a local method call (its ctx),
// a commit through a watched derive (the batch, a derive's compute) and activation churn (an object with params made,
// live and ended per get: its attempt's declarations). Median µs per operation over bursts, and heap allocated per
// operation (growth plus what the collections during the burst freed). Runs on HEAD as it is (copy it there).
// Run by hand from packages/chord (not in CI), pinned for comparisons:
//   taskset -c 6 node --conditions=source --experimental-strip-types --expose-gc test/next/bench/calls.ts
import { performance } from "node:perf_hooks";
import { GCProfiler } from "node:v8";
import { BACKGROUND_CONTEXT as context } from "../../../src/context/index.ts";
import { int, local, method, obj } from "../../../src/next/contracts/index.ts";
import { defineState } from "../../../src/next/documents/index.ts";
import { createHost, defineFacet } from "../../../src/next/host/index.ts";

const BURSTS = 9;

const gc = (globalThis as { gc?: () => void }).gc!;

const Counter = defineState("bench.counter", { schema: obj({ n: int() }), version: 1, initial: () => ({ n: 0 }) });
const Store = local("bench.store", {
	version: 1,
	params: {},
	members: { doubled: int(), bump: method(), set: method(int()) },
});
const Item = local("bench.item", { version: 1, params: { id: int() }, members: { n: int() } });

const host = createHost({ onError: (error) => console.log("onError", error.kind) });
await host.load(
	[
		{
			name: "@bench/calls",
			facet: defineFacet((h) => {
				h.serve(Store, (_, self) => {
					const counter = self.state(Counter);
					return {
						doubled: self.derive([counter], ([c]) => c.n * 2),
						bump: async () => null,
						set: async (n, ctx) => {
							await counter.change((draft) => {
								draft.n = n;
							}, ctx);
							return null;
						},
					};
				});
				h.serve(Item, ({ id }, self) => ({ n: self.derive([self.get(Store, {}).doubled], ([d]) => d + id) }));
			}),
		},
	],
	context,
);

const store = await host.get(Store, {}, context);
const watch = await store.doubled.watch(context);
watch.start(async () => {});

/** Median µs per operation over the bursts (after one warm-up burst), and heap bytes allocated per operation. */
async function measure(runs: number, operation: (i: number) => Promise<unknown>): Promise<string> {
	const times: number[] = [];
	let bytes = 0;
	let counted = 0;
	for (let burst = -1; burst < BURSTS; burst++) {
		gc();
		const before = process.memoryUsage().heapUsed;
		const profiler = new GCProfiler();
		profiler.start();
		const started = performance.now();
		for (let i = 0; i < runs; i++) await operation(i);
		const elapsed = performance.now() - started;
		const after = process.memoryUsage().heapUsed;
		let freed = 0;
		for (const { beforeGC, afterGC } of profiler.stop().statistics) {
			freed += beforeGC.heapStatistics.usedHeapSize - afterGC.heapStatistics.usedHeapSize;
		}
		if (burst < 0) continue;
		times.push((elapsed * 1000) / runs);
		bytes += after - before + freed;
		counted += runs;
	}
	times.sort((a, b) => a - b);
	return `${times[Math.floor(times.length / 2)]!.toFixed(2)} µs, ${Math.round(bytes / counted)} B allocated`;
}

console.log("local method call:", await measure(20_000, () => store.bump(context)));
console.log("commit through a watched derive:", await measure(10_000, (i) => store.set(i + 1, context)));
console.log(
	"activation churn (get, live, release):",
	await measure(2_000, async (i) => (await host.get(Item, { id: i }, context)).release()),
);
await watch.stop();
await host.close(context);

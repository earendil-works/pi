// Benchmark of slice 8's registries and writables: a `writable.set` delivered to one watch, a set of the same value
// (one comparison), and one contribution of N (10, 100) changed while the registry is watched (one table build and one
// compose per set, over N entries). Median µs per operation over bursts, heap allocated per operation, and the
// registry's compose count per set (the cost guard: one).
// Run by hand from packages/chord (not in CI), pinned for comparisons:
//   taskset -c 6 node --conditions=source --experimental-strip-types --expose-gc test/next/bench/registries.ts
import { performance } from "node:perf_hooks";
import { GCProfiler } from "node:v8";
import { InMemoryTelemetryContext } from "@earendil-works/pi-telemetry";
import { BACKGROUND_CONTEXT as context } from "../../../src/context/index.ts";
import { int, local } from "../../../src/next/contracts/index.ts";
import { createHost, defineFacet } from "../../../src/next/host/index.ts";
import { defineRegistry } from "../../../src/next/registries/index.ts";
import type { Writable } from "../../../src/next/state/index.ts";

const BURSTS = 9;

const gc = (globalThis as { gc?: () => void }).gc!;

/** Median µs per operation over the bursts (after one warm-up burst), and heap bytes allocated per operation. */
async function measure(runs: number, operation: (i: number) => void): Promise<string> {
	const times: number[] = [];
	let bytes = 0;
	let counted = 0;
	for (let burst = -1; burst < BURSTS; burst++) {
		gc();
		const before = process.memoryUsage().heapUsed;
		const profiler = new GCProfiler();
		profiler.start();
		const started = performance.now();
		for (let i = 0; i < runs; i++) operation(i);
		// The watches' listeners run on microtasks: their work counts too.
		await new Promise((resolve) => setImmediate(resolve));
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
	return `${times[Math.floor(times.length / 2)]!.toFixed(3)} µs, ${Math.round(bytes / counted)} B allocated`;
}

const Sum = defineRegistry<number, number>("bench.sum", { version: 1 });

/** A host with `contributors` host-lifetime objects each contributing a writable number to `Sum`, watched. */
async function registryOf(contributors: number) {
	const telemetry = new InMemoryTelemetryContext();
	const writables: Writable<number>[] = [];
	const types = Array.from({ length: contributors }, (_, i) =>
		local(`bench.contributor-${i}`, { version: 1, params: {}, members: { n: int() } }),
	);
	const host = createHost({ telemetry, onError: (error) => console.log("onError", error.kind) });
	const facet = defineFacet((h) => {
		h.serve(Sum, { compose: (table) => table.reduce((sum, { value }) => sum + value, 0) });
		for (const Type of types) {
			h.serve(Type, (_, self) => {
				const value = self.writable(0);
				writables.push(value);
				self.contribute(Sum, value);
				return { n: self.derive([value], ([n]) => n) };
			});
		}
	});
	await host.load([{ name: "@bench/registries", facet }], context);
	const sum = await host.registry(Sum, context);
	const watch = await sum.watch(context);
	watch.start(async () => {});
	const composes = (): number =>
		telemetry
			.getMetrics()
			.filter(({ name }) => name === "chord.registry.composes")
			.reduce((n, { value }) => n + value, 0);
	return { host, writables, watch, composes };
}

const one = await registryOf(1);
const writable = one.writables[0]!;
const watch = await writable.watch(context);
watch.start(async () => {});
console.log("writable.set, one watch:", await measure(20_000, (i) => writable.set(i + 1)));
// The listeners' backlogs dropped first: what follows measures the set alone.
await watch.stop();
await one.watch.stop();
writable.set(-1);
console.log("writable.set of the same value:", await measure(1_000_000, () => writable.set(-1)));
console.log("an empty operation (the loop's own cost):", await measure(1_000_000, () => {}));
await one.host.close(context);

for (const contributors of [10, 100]) {
	const { host, writables, watch, composes } = await registryOf(contributors);
	const before = composes();
	const target = writables[Math.floor(contributors / 2)]!;
	const sets = 5_000;
	const result = await measure(sets, (i) => target.set(i + 1));
	console.log(
		`one of ${contributors} contributions set, registry watched:`,
		result,
		`${((composes() - before) / (sets * (BURSTS + 1))).toFixed(2)} composes per set`,
	);
	await watch.stop();
	await host.close(context);
}

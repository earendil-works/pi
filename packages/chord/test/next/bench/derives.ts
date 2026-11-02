// Benchmark of a retirement through derives (slice 6a rule 21): a singleton under a diamond of 40 derives (13 layers of
// two derives joined by a third, 2^13 paths from the top to the bottom), its bottom watched; each step retires the
// document and creates it again in one transaction, so every step carries the `retired` flag through the diamond.
// Median and p95 per step over several bursts. The flag reaches each derive once per retirement, not once per path.
// Run by hand from packages/chord (not in CI):
//   node --conditions=source --experimental-strip-types --expose-gc test/next/bench/derives.ts
import { performance } from "node:perf_hooks";
import { BACKGROUND_CONTEXT as context } from "../../../src/context/index.ts";
import { arr, int, local, method, obj, str } from "../../../src/next/contracts/index.ts";
import { defineState, type SingletonHandle } from "../../../src/next/documents/index.ts";
import { createHost, defineFacet, type Self } from "../../../src/next/host/index.ts";
import type { Watchable } from "../../../src/watch.ts";

const STEPS = 1_000;
const RUNS = 7;
const LAYERS = 13;

const List = defineState("bench.list", {
	schema: obj({ items: arr(str()) }),
	version: 1,
	initial: () => ({ items: [] }),
});
const Diamond = local("bench.diamond", { version: 1, params: {}, members: { bottom: int(), touch: method() } });

/** The diamond over `list`: its bottom derive. */
function diamond(self: Self, list: SingletonHandle<{ items: string[] }>): Watchable<number> {
	let previous: Watchable<number> = self.derive([list], ([value]) => value.items.length);
	for (let layer = 0; layer < LAYERS; layer++) {
		const left = self.derive([previous], ([n]) => n + 1);
		const right = self.derive([previous], ([n]) => n + 2);
		previous = self.derive([left, right], ([a, b]) => (a + b) % 1_000);
	}
	return previous;
}

/** Per-step times (ms) of `RUNS` bursts of `STEPS` retire-and-recreate transactions, after one warm-up burst. */
async function bursts(): Promise<{ readonly median: number; readonly p95: number }> {
	const times: number[] = [];
	for (let run = -1; run < RUNS; run++) {
		let list: SingletonHandle<{ items: string[] }> | undefined;
		let self: Self | undefined;
		const host = createHost({ onError: () => {} });
		const facet = defineFacet((h) =>
			h.serve(Diamond, (_, declared) => {
				self = declared;
				list = declared.state(List);
				return { bottom: diamond(declared, list), touch: async () => null };
			}),
		);
		await host.load([{ name: "@bench/derives", facet }], context);
		const reference = await host.get(Diamond, {}, context);
		const watch = await reference.bottom.watch(context);
		watch.start(async () => {});
		for (let step = 0; step < STEPS; step++) {
			const before = performance.now();
			await self!.tx(async (tx) => {
				await tx.retire(list!);
				(await tx.draft(list!)).items.push(`${step}`);
			}, context);
			if (run >= 0) times.push(performance.now() - before);
		}
		await watch.stop();
		reference.release();
		await host.close(context);
	}
	times.sort((a, b) => a - b);
	return { median: times[Math.floor(times.length / 2)]!, p95: times[Math.floor(times.length * 0.95)]! };
}

const { median, p95 } = await bursts();
console.log(
	`retire + recreate under a ${1 + 3 * LAYERS}-derive diamond: ${(median * 1000).toFixed(1)} µs median, ${(p95 * 1000).toFixed(1)} µs p95`,
);

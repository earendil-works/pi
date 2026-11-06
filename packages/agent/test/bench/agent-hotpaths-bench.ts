/**
 * Standalone agent runtime microbenchmarks.
 *
 * Run from repository root:
 *   node --experimental-strip-types packages/agent/test/bench/agent-hotpaths-bench.ts
 *
 * These are CPU/heap microbenchmarks, not production throughput results.
 * Compare before/after commits under the same Node version and workload.
 */
import { performance } from "node:perf_hooks";
import { PendingMessageQueue } from "../../src/pending-message-queue.ts";
import { ToolUpdateTracker } from "../../src/tool-update-tracker.ts";

const RUNS = 7;

function distribution(times: number[]): { median: number; p95: number } {
	const sorted = [...times].sort((a, b) => a - b);
	return {
		median: sorted[Math.floor(sorted.length * 0.5)]!,
		p95: sorted[Math.floor(sorted.length * 0.95)]!,
	};
}

async function measure(label: string, operation: () => void | Promise<void>): Promise<void> {
	const times: number[] = [];
	for (let trial = -1; trial < RUNS; trial++) {
		const start = performance.now();
		await operation();
		if (trial >= 0) times.push(performance.now() - start);
	}
	const { median, p95 } = distribution(times);
	console.log(`${label.padEnd(34)} median ${median.toFixed(2)} ms   p95 ${p95.toFixed(2)} ms`);
}

for (const count of [1_000, 10_000, 30_000]) {
	await measure(`pending queue, ${count} messages`, () => {
		const queue = new PendingMessageQueue<number>("one-at-a-time");
		for (let index = 0; index < count; index++) queue.enqueue(index);
		for (let index = 0; index < count; index++) {
			const next = queue.drain();
			if (next[0] !== index) throw new Error("FIFO order changed");
		}
	});
}

for (const count of [1_000, 10_000, 100_000]) {
	await measure(`tool updates, ${count} resolved`, async () => {
		const tracker = new ToolUpdateTracker();
		for (let index = 0; index < count; index++) {
			tracker.track(Promise.resolve());
			if ((index & 127) === 0) await Promise.resolve();
		}
		await tracker.drain();
		if (tracker.pendingCount !== 0) throw new Error("Settled progress promises retained");
	});
}

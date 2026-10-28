import assert from "node:assert/strict";
import { PerformanceObserver, performance } from "node:perf_hooks";
import { setImmediate } from "node:timers/promises";
import type { Draft } from "../../src/delta/draft.ts";
import { type Op, track } from "../../src/delta/index.ts";

const MiB = 1024 * 1024;

type Mode = "tracker";
type Scenario = "idle-control" | "sparse-burst" | "staggered-revisions" | "lagging-watches";
type Row = { id: number; value: number; payload: string };
type Document = { rows: Row[] };
type PreparedLike = { readonly value: Document; readonly ops: readonly Op[] };
type ChangeLike = { readonly state: Draft<Document>; prepare(): PreparedLike };
type TrackerLike = { readonly value: Document; beginChange(): ChangeLike; adopt(prepared: PreparedLike): void };

const MODES = new Set<Mode>(["tracker"]);
const SCENARIOS = new Set<Scenario>(["idle-control", "sparse-burst", "staggered-revisions", "lagging-watches"]);
const mode = process.argv[2] as Mode;
const scenario = process.argv[3] as Scenario;
const size = Number(process.argv[4] ?? 100_000);
const updates = Number(process.argv[5] ?? 100);
const watchCount = Number(process.argv[6] ?? 8);
const trial = Number(process.argv[7] ?? 0);
if (!MODES.has(mode)) throw new Error(`Unknown mode ${mode}`);
if (!SCENARIOS.has(scenario)) throw new Error(`Unknown scenario ${scenario}`);
if (!Number.isSafeInteger(size) || size < 1) throw new RangeError("Invalid size");
if (!Number.isSafeInteger(updates) || updates < 1) throw new RangeError("Invalid update count");
if (!Number.isSafeInteger(watchCount) || watchCount < 1) throw new RangeError("Invalid watch count");

function fixture(count: number): Document {
	return { rows: Array.from({ length: count }, (_, id) => ({ id, value: id, payload: `row-${id}` })) };
}

async function collect(): Promise<void> {
	assert.ok(global.gc, "memory benchmark requires --expose-gc");
	for (let attempt = 0; attempt < 3; attempt++) {
		await setImmediate();
		global.gc();
	}
}

function createTracker(value: Document): TrackerLike {
	return track(value) as TrackerLike;
}

function commitUpdate(tracker: TrackerLike, update: number): void {
	const change = tracker.beginChange();
	const row = ((update + 1) * 997) % size;
	change.state.rows[row]!.value = -update - 1;
	const prepared = change.prepare();
	tracker.adopt(prepared);
}

function acquireSnapshot(tracker: TrackerLike): Document {
	return tracker.value;
}

let warmup: TrackerLike | undefined = createTracker(fixture(16));
const warmupChange = warmup.beginChange();
warmupChange.state.rows[0]!.value = -1;
const warmupPrepared = warmupChange.prepare();
warmup.adopt(warmupPrepared);
warmup = undefined;
await collect();
const processBaseline = process.memoryUsage();
let input: Document | undefined = fixture(size);
let tracker: TrackerLike | undefined = createTracker(input);
input = undefined;
await collect();
const ready = process.memoryUsage();
let peakHeap = ready.heapUsed;
let peakRss = ready.rss;
let acquisitionMs = 0;
let snapshots: Document[] = [];
let gcCount = 0;
let gcMs = 0;
const observer = new PerformanceObserver((list) => {
	for (const entry of list.getEntries()) {
		gcCount += 1;
		gcMs += entry.duration;
	}
});
observer.observe({ entryTypes: ["gc"] });

const samplePeak = (): void => {
	const memory = process.memoryUsage();
	peakHeap = Math.max(peakHeap, memory.heapUsed);
	peakRss = Math.max(peakRss, memory.rss);
};

const acquire = (): void => {
	const start = performance.now();
	snapshots.push(acquireSnapshot(tracker!));
	acquisitionMs += performance.now() - start;
	samplePeak();
};

const workStart = performance.now();
if (scenario === "idle-control") {
	for (let update = 0; update < updates; update++) samplePeak();
} else if (scenario === "sparse-burst") {
	for (let update = 0; update < updates; update++) {
		commitUpdate(tracker, update);
		samplePeak();
	}
} else if (scenario === "staggered-revisions") {
	for (let watcher = 0; watcher < watchCount; watcher++) {
		acquire();
		if (watcher + 1 < watchCount) commitUpdate(tracker, watcher);
		samplePeak();
	}
} else {
	for (let watcher = 0; watcher < watchCount; watcher++) acquire();
	for (let update = 0; update < updates; update++) {
		commitUpdate(tracker, update);
		samplePeak();
	}
}
const workMs = performance.now() - workStart;
for (let attempt = 0; attempt < 3; attempt++) await setImmediate();
observer.disconnect();
samplePeak();
await collect();
const retained = process.memoryUsage();
const checksum = tracker.value.rows[0]!.value + tracker.value.rows.at(-1)!.value + snapshots.length;

snapshots = [];
await collect();
const afterSnapshotRelease = process.memoryUsage();
tracker = undefined;
await collect();
const released = process.memoryUsage();

console.log(
	JSON.stringify({
		mode,
		scenario,
		trial,
		size,
		updates: scenario === "staggered-revisions" ? watchCount - 1 : scenario === "idle-control" ? 0 : updates,
		watchCount: scenario === "staggered-revisions" || scenario === "lagging-watches" ? watchCount : 0,
		workMs,
		acquisitionMs,
		gcCount,
		gcMs,
		readyHeapMiB: (ready.heapUsed - processBaseline.heapUsed) / MiB,
		readyRssMiB: (ready.rss - processBaseline.rss) / MiB,
		peakOverReadyHeapMiB: (peakHeap - ready.heapUsed) / MiB,
		peakOverProcessBaselineHeapMiB: (peakHeap - processBaseline.heapUsed) / MiB,
		peakOverReadyRssMiB: (peakRss - ready.rss) / MiB,
		retainedOverReadyHeapMiB: (retained.heapUsed - ready.heapUsed) / MiB,
		retainedOverProcessBaselineHeapMiB: (retained.heapUsed - processBaseline.heapUsed) / MiB,
		retainedOverReadyRssMiB: (retained.rss - ready.rss) / MiB,
		snapshotRetainedHeapMiB: (retained.heapUsed - afterSnapshotRelease.heapUsed) / MiB,
		afterSnapshotReleaseOverReadyHeapMiB: (afterSnapshotRelease.heapUsed - ready.heapUsed) / MiB,
		afterSnapshotReleaseOverProcessBaselineHeapMiB: (afterSnapshotRelease.heapUsed - processBaseline.heapUsed) / MiB,
		releasedOverProcessBaselineHeapMiB: (released.heapUsed - processBaseline.heapUsed) / MiB,
		releasedOverProcessBaselineRssMiB: (released.rss - processBaseline.rss) / MiB,
		maxRssMiB: process.resourceUsage().maxRSS / 1024,
		checksum,
	}),
);

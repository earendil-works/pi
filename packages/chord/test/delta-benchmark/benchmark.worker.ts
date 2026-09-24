import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { setImmediate } from "node:timers/promises";
import type { Draft } from "../../src/delta/draft.ts";
import { applyImmutable, type Op, track } from "../../src/delta/index.ts";

type Mode = "tracker";
type Scenario =
	| "import"
	| "committed-read"
	| "draft-read"
	| "sparse"
	| "queue"
	| "sort"
	| "dense"
	| "unshift"
	| "watch-authority-control"
	| "watch-live-borrowed"
	| "watch-acquire-shared"
	| "watch-acquire-detached"
	| "watch-acquire-staggered"
	| "watch-lag"
	| "watch-catch-up"
	| "watch-catch-up-coalesced"
	| "watch-live-immutable";
type Row = { id: number; value: number; payload: string };
type Document = { rows: Row[] };
type PreparedLike = { readonly value: Readonly<Document>; readonly ops: readonly Op[] };
type ChangeLike = { readonly state: Draft<Document>; prepare(): PreparedLike };
type TrackerLike = { readonly value: Document; beginChange(): ChangeLike; adopt(prepared: PreparedLike): void };
type Frame = { readonly sequence: number; readonly ops: readonly Op[] };
type WatchReplica = {
	value: Document;
	readonly baseSequence: number;
	sequence: number;
	readonly queue: Frame[];
};

const MiB = 1024 * 1024;
const MODES = new Set<Mode>(["tracker"]);
const SCENARIOS = new Set<Scenario>([
	"import",
	"committed-read",
	"draft-read",
	"sparse",
	"queue",
	"sort",
	"dense",
	"unshift",
	"watch-authority-control",
	"watch-live-borrowed",
	"watch-acquire-shared",
	"watch-acquire-detached",
	"watch-acquire-staggered",
	"watch-lag",
	"watch-catch-up",
	"watch-catch-up-coalesced",
	"watch-live-immutable",
]);
const WATCH_SCENARIOS = new Set<Scenario>([
	"watch-authority-control",
	"watch-live-borrowed",
	"watch-acquire-shared",
	"watch-acquire-detached",
	"watch-acquire-staggered",
	"watch-lag",
	"watch-catch-up",
	"watch-catch-up-coalesced",
	"watch-live-immutable",
]);
const mode = process.argv[2] as Mode;
const scenario = process.argv[3] as Scenario;
if (!MODES.has(mode)) throw new Error(`Unknown benchmark mode ${mode}`);
if (!SCENARIOS.has(scenario)) throw new Error(`Unknown benchmark scenario ${scenario}`);
const size = Number(process.argv[4] ?? 100_000);
const trial = Number(process.argv[5] ?? 0);
const requestedWatchCount = Number(process.argv[6] ?? 8);
const requestedWatchUpdates = Number(process.argv[7] ?? 100);
if (!Number.isSafeInteger(requestedWatchCount) || requestedWatchCount < 1) throw new RangeError("Invalid watch count");
if (!Number.isSafeInteger(requestedWatchUpdates) || requestedWatchUpdates < 0)
	throw new RangeError("Invalid watch update count");

function fixture(count: number): Document {
	return {
		rows: Array.from({ length: count }, (_, id) => ({ id, value: id, payload: `row-${id}` })),
	};
}

function cloneTrusted<T>(value: T): T {
	if (value === null || typeof value !== "object") return value;
	if (Array.isArray(value)) return value.map((child) => cloneTrusted(child)) as T;
	const result = Object.create(Object.getPrototypeOf(value)) as Record<string, unknown>;
	for (const key of Object.keys(value)) {
		Object.defineProperty(result, key, {
			value: cloneTrusted((value as Record<string, unknown>)[key]),
			writable: true,
			enumerable: true,
			configurable: true,
		});
	}
	return result as T;
}

function sum(document: Document | Draft<Document>): number {
	let checksum = 0;
	for (let index = 0; index < document.rows.length; index++) checksum += document.rows[index]!.value;
	return checksum;
}

async function gc(): Promise<void> {
	assert.ok(global.gc, "benchmark worker requires --expose-gc");
	for (let index = 0; index < 3; index++) {
		await setImmediate();
		global.gc();
	}
}

await gc();
const baselineHeap = process.memoryUsage().heapUsed;
let input: Document | undefined = fixture(size);
if (scenario === "sort") input.rows.reverse();
const importStart = performance.now();
const tracker = track(input) as TrackerLike;
const importMs = performance.now() - importStart;
input = undefined;
await gc();
const readyHeap = process.memoryUsage().heapUsed;
let peakHeap = readyHeap;
let mutateMs = 0;
let prepareMs = 0;
let serializeMs = 0;
let adoptMs = 0;
let acquireMs = 0;
let enqueueMs = 0;
let deliveryMs = 0;
let opBytes = 0;
let operationCount = 0;
let checksum = 0;
let authoritySequence = 0;
let postAcquireRetainedMiB = 0;
let postLagRetainedMiB = 0;
let postDeliveryRetainedMiB = 0;
let sampledAcquireMiB = 0;
let watchers: WatchReplica[] = [];
let borrowedListeners: Array<(value: Document, sequence: number) => number> = [];
const queueOperations = Math.min(size, 1_000);
const watchCount = WATCH_SCENARIOS.has(scenario) ? requestedWatchCount : 0;
const watchUpdateTarget = WATCH_SCENARIOS.has(scenario) ? requestedWatchUpdates : 0;

const samplePeak = (): void => {
	peakHeap = Math.max(peakHeap, process.memoryUsage().heapUsed);
};

const retainedFromBaseline = async (): Promise<number> => {
	await gc();
	return (process.memoryUsage().heapUsed - baselineHeap) / MiB;
};

const createWatch = (value: Document): WatchReplica => ({
	value,
	baseSequence: authoritySequence,
	sequence: authoritySequence,
	queue: [],
});

const acquireSharedWatches = (): void => {
	const beforeHeap = process.memoryUsage().heapUsed;
	const start = performance.now();
	const base = tracker.value;
	watchers = Array.from({ length: watchCount }, () => createWatch(base));
	acquireMs += performance.now() - start;
	sampledAcquireMiB = Math.max(sampledAcquireMiB, (process.memoryUsage().heapUsed - beforeHeap) / MiB);
	for (const watcher of watchers) assert.equal(watcher.value, tracker.value);
	samplePeak();
};

const acquireDetachedWatches = (): void => {
	const beforeHeap = process.memoryUsage().heapUsed;
	const start = performance.now();
	watchers = Array.from({ length: watchCount }, () => createWatch(cloneTrusted(tracker.value)));
	acquireMs += performance.now() - start;
	sampledAcquireMiB = Math.max(sampledAcquireMiB, (process.memoryUsage().heapUsed - beforeHeap) / MiB);
	for (let left = 0; left < watchers.length; left++) {
		assert.notEqual(watchers[left]!.value, tracker.value);
		for (let right = left + 1; right < watchers.length; right++) {
			assert.notEqual(watchers[left]!.value, watchers[right]!.value);
		}
	}
	samplePeak();
};

const acquireOneWatch = (): void => {
	const beforeHeap = process.memoryUsage().heapUsed;
	const start = performance.now();
	watchers.push(createWatch(tracker.value));
	acquireMs += performance.now() - start;
	sampledAcquireMiB = Math.max(sampledAcquireMiB, (process.memoryUsage().heapUsed - beforeHeap) / MiB);
	samplePeak();
};

const commitWatchUpdate = (update: number): Frame => {
	let change: ChangeLike | undefined = tracker.beginChange();
	const row = ((update + 1) * 997) % size;
	const mutateStart = performance.now();
	change.state.rows[row]!.value = -update - 1;
	mutateMs += performance.now() - mutateStart;
	samplePeak();
	const prepareStart = performance.now();
	let prepared: PreparedLike | undefined = change.prepare();
	prepareMs += performance.now() - prepareStart;
	samplePeak();
	const operations = prepared.ops;
	operationCount += operations.length;
	const adoptStart = performance.now();
	tracker.adopt(prepared);
	adoptMs += performance.now() - adoptStart;
	samplePeak();
	change = undefined;
	prepared = undefined;
	authoritySequence += 1;
	return { sequence: authoritySequence, ops: operations };
};

const enqueueFrame = (frame: Frame): void => {
	const start = performance.now();
	for (const watcher of watchers) {
		assert.equal(frame.sequence, watcher.sequence + watcher.queue.length + 1);
		watcher.queue.push(frame);
	}
	enqueueMs += performance.now() - start;
};

const applyFrame = (watcher: WatchReplica, frame: Frame): void => {
	assert.equal(frame.sequence, watcher.sequence + 1);
	watcher.value = applyImmutable(watcher.value, frame.ops);
	watcher.sequence = frame.sequence;
};

const drainWatchQueues = (measure: boolean): void => {
	const start = performance.now();
	for (const watcher of watchers) {
		for (const frame of watcher.queue) applyFrame(watcher, frame);
		watcher.queue.length = 0;
		samplePeak();
	}
	if (measure) deliveryMs += performance.now() - start;
};

const drainWatchQueuesCoalesced = (): void => {
	const start = performance.now();
	for (const watcher of watchers) {
		const operations = watcher.queue.flatMap((frame) => frame.ops);
		watcher.value = applyImmutable(watcher.value, operations);
		watcher.sequence = watcher.queue.at(-1)?.sequence ?? watcher.sequence;
		watcher.queue.length = 0;
		samplePeak();
	}
	deliveryMs += performance.now() - start;
};

const assertWatchConvergence = (): void => {
	for (const watcher of watchers) {
		assert.equal(watcher.sequence, authoritySequence);
		assert.deepEqual(watcher.value, tracker.value);
	}
};

if (scenario === "committed-read") {
	const start = performance.now();
	checksum = sum(tracker.value);
	mutateMs = performance.now() - start;
	samplePeak();
} else if (scenario === "watch-authority-control") {
	for (let update = 0; update < watchUpdateTarget; update++) commitWatchUpdate(update);
	postDeliveryRetainedMiB = await retainedFromBaseline();
	checksum = sum(tracker.value);
} else if (scenario === "watch-live-borrowed") {
	const start = performance.now();
	borrowedListeners = Array.from({ length: watchCount }, () => (value, sequence) => value.rows[0]!.value + sequence);
	for (const listener of borrowedListeners) checksum += listener(tracker.value, authoritySequence);
	acquireMs = performance.now() - start;
	postAcquireRetainedMiB = await retainedFromBaseline();
	for (let update = 0; update < watchUpdateTarget; update++) {
		commitWatchUpdate(update);
		const deliveryStart = performance.now();
		for (const listener of borrowedListeners) checksum += listener(tracker.value, authoritySequence);
		deliveryMs += performance.now() - deliveryStart;
		samplePeak();
	}
	postDeliveryRetainedMiB = await retainedFromBaseline();
} else if (scenario === "watch-acquire-shared" || scenario === "watch-acquire-detached") {
	if (scenario === "watch-acquire-shared") acquireSharedWatches();
	else acquireDetachedWatches();
	postAcquireRetainedMiB = await retainedFromBaseline();
	checksum = sum(watchers[0]!.value) + watchers.length;
} else if (scenario === "watch-acquire-staggered") {
	for (let watcher = 0; watcher < watchCount; watcher++) {
		acquireOneWatch();
		if (watcher + 1 === watchCount) break;
		const frame = commitWatchUpdate(watcher);
		enqueueFrame(frame);
	}
	for (let watcher = 0; watcher < watchers.length; watcher++) {
		assert.equal(watchers[watcher]!.baseSequence, watcher);
		assert.equal(watchers[watcher]!.queue.length, watchCount - watcher - 1);
	}
	postAcquireRetainedMiB = await retainedFromBaseline();
	drainWatchQueues(false);
	assertWatchConvergence();
	postDeliveryRetainedMiB = await retainedFromBaseline();
	checksum = sum(watchers[0]!.value) + sum(watchers.at(-1)!.value);
} else if (
	scenario === "watch-lag" ||
	scenario === "watch-catch-up" ||
	scenario === "watch-catch-up-coalesced" ||
	scenario === "watch-live-immutable"
) {
	acquireSharedWatches();
	postAcquireRetainedMiB = await retainedFromBaseline();
	for (let update = 0; update < watchUpdateTarget; update++) {
		const frame = commitWatchUpdate(update);
		if (scenario === "watch-live-immutable") {
			const start = performance.now();
			for (const watcher of watchers) applyFrame(watcher, frame);
			deliveryMs += performance.now() - start;
			samplePeak();
		} else enqueueFrame(frame);
	}
	postLagRetainedMiB = await retainedFromBaseline();
	if (scenario === "watch-catch-up-coalesced") drainWatchQueuesCoalesced();
	else if (scenario !== "watch-live-immutable") drainWatchQueues(scenario === "watch-catch-up");
	assertWatchConvergence();
	postDeliveryRetainedMiB = await retainedFromBaseline();
	checksum = sum(watchers[0]!.value) + sum(tracker.value);
} else if (scenario !== "import") {
	let change: ChangeLike | undefined = tracker.beginChange();
	const start = performance.now();
	switch (scenario) {
		case "draft-read":
			checksum = sum(change.state);
			break;
		case "sparse":
			for (let index = 0; index < size; index += 1_000) change.state.rows[index]!.value = -index;
			checksum = change.state.rows.at(-1)!.value;
			break;
		case "queue":
			for (let index = 0; index < queueOperations; index++) {
				change.state.rows.shift();
				change.state.rows.push({ id: size + index, value: index, payload: "queue" });
			}
			checksum = change.state.rows.length;
			break;
		case "sort":
			change.state.rows.sort((left, right) => left.id - right.id);
			checksum = change.state.rows[0]!.id;
			break;
		case "dense":
			for (let index = 0; index < size; index++) change.state.rows[index]!.value = -index;
			checksum = change.state.rows.at(-1)!.value;
			break;
		case "unshift": {
			const inserted = Array.from({ length: 100_000 }, (_, id) => ({ id: -id, value: id, payload: "inserted" }));
			Reflect.apply(change.state.rows.unshift, change.state.rows, inserted);
			checksum = change.state.rows.length;
			break;
		}
		default:
			throw new Error(`Unhandled benchmark scenario ${scenario}`);
	}
	mutateMs = performance.now() - start;
	samplePeak();
	const prepareStart = performance.now();
	let prepared: PreparedLike | undefined = change.prepare();
	prepareMs = performance.now() - prepareStart;
	samplePeak();
	const serializeStart = performance.now();
	const serialized = JSON.stringify(prepared.ops);
	serializeMs = performance.now() - serializeStart;
	opBytes = Buffer.byteLength(serialized);
	operationCount = prepared.ops.length;
	samplePeak();
	const adoptStart = performance.now();
	tracker.adopt(prepared);
	adoptMs = performance.now() - adoptStart;
	change = undefined;
	prepared = undefined;
}

const scenarioWorkMs = mutateMs + prepareMs + serializeMs + adoptMs + acquireMs + enqueueMs + deliveryMs;
samplePeak();
await gc();
const retainedHeap = process.memoryUsage().heapUsed;
const retainedMiB = (retainedHeap - baselineHeap) / MiB;
const retainedOverReadyMiB = (retainedHeap - readyHeap) / MiB;
const watcherRoots = watchers.length;
const queuedBatchReferences = watchers.reduce((total, watcher) => total + watcher.queue.length, 0);
const listenerCount = borrowedListeners.length;
watchers = [];
borrowedListeners = [];
await gc();
const releasedRetainedMiB = (process.memoryUsage().heapUsed - baselineHeap) / MiB;
console.log(
	JSON.stringify({
		mode,
		scenario,
		size,
		trial,
		queueOperations,
		watchProfile: WATCH_SCENARIOS.has(scenario) ? "local-sparse-array-leaf" : null,
		watchCount: watcherRoots + listenerCount,
		watchUpdates: authoritySequence,
		queuedBatchReferences,
		importMs,
		mutateMs,
		prepareMs,
		serializeMs,
		adoptMs,
		acquireMs,
		enqueueMs,
		deliveryMs,
		scenarioWorkMs,
		opBytes,
		operationCount,
		checksum,
		readyMiB: (readyHeap - baselineHeap) / MiB,
		sampledAcquireMiB,
		sampledTransientMiB: (peakHeap - readyHeap) / MiB,
		retainedMiB,
		retainedOverReadyMiB,
		postAcquireRetainedMiB,
		postLagRetainedMiB,
		postDeliveryRetainedMiB,
		releasedRetainedMiB,
		maxRssMiB: process.resourceUsage().maxRSS / 1024,
	}),
);

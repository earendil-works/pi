import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { setImmediate } from "node:timers/promises";
import type { Draft } from "../../src/delta/draft.ts";
import { applyImmutable, type JsonValue, type NonEmptyPath, type Op, type Path, track } from "../../src/delta/index.ts";

// Provisional Pico5 benchmark schemas. They intentionally model architecture and
// workload shape, not a committed public API or persisted wire format.
const PROVISIONAL_SCHEMA = "pico5.conversation-view.provisional.v0";
const MiB = 1024 * 1024;
const MOUNTED_KEYS = ["config", "inbox", "turn", "preferences", "live"] as const;
const DOCUMENT_WATCH_KEYS = ["config", "inbox", "preferences", "live"] as const;

type Mode = "tracker";
type Scenario =
	| "projection-control"
	| "normal"
	| "fanout"
	| "delayed-start-lag"
	| "churn-reconnect"
	| "overflow-reset"
	| "branch-head-replacement";
type MountedKey = (typeof MOUNTED_KEYS)[number];
type DocumentKey = MountedKey | "audit";
type JsonObject = Record<string, JsonValue>;
type ConfigDoc = {
	schema: string;
	model: { provider: string; modelId: string };
	thinkingLevel: string;
	selectedTools: string[];
	sections: Array<{ id: string; title: string; instructions: string }>;
	tools: Array<{ name: string; description: string; inputSchema: JsonObject }>;
	temperature: number;
	revision: number;
};
type InboxItem = { id: number; mode: string; text: string };
type InboxDoc = { schema: string; items: InboxItem[]; revision: number };
type TurnDoc = {
	schema: string;
	stage: string;
	message: string;
	toolSlots: Array<{ callId: string; name: string; status: string; preview: string }>;
	revision: number;
};
type PreferencesDoc = {
	schema: string;
	theme: string;
	keymap: string;
	compactTools: boolean;
	fontScale: number;
	editorProfile: string;
	shortcuts: Record<string, string>;
	revision: number;
};
type LiveDoc = {
	schema: string;
	status: string;
	tokens: number;
	cost: number;
	heartbeat: number;
	generation: { stage: string; attempt: number; partial: string; retryAt?: number };
	tools: Array<{ callId: string; name: string; status: string; progress: number; output: string }>;
};
type AuditDoc = { schema: string; commits: number; note: string };
type TranscriptEntry = {
	id: number;
	parent: number | null;
	kind: "user" | "assistant" | "tool-result" | "application";
	data: JsonObject;
};
type ConversationView = {
	schema: string;
	conversation: { id: string; head: number | null };
	docs: Record<MountedKey, JsonObject>;
	entries: TranscriptEntry[];
};
type PreparedLike<T extends object> = {
	readonly base: T;
	readonly value: T;
	readonly ops: readonly Op[];
	abort(): void;
};
type ChangeLike<T extends object> = { readonly state: Draft<T>; prepare(): PreparedLike<T>; abort(): void };
type TrackerLike<T extends object> = {
	readonly value: T;
	beginChange(): ChangeLike<T>;
	adopt(prepared: PreparedLike<T>): void;
};
type DeltaFrame = { readonly kind: "delta"; readonly sequence: number; readonly ops: readonly Op[] };
type WatchType = "conversation" | "document";
type Watch<T extends object> = {
	readonly snapshot: T;
	readonly baseSequence: number;
	readonly baseHash: string;
	deliveredSequence: number;
	pendingOperationCount: number;
	readonly queue: DeltaFrame[];
	readonly started: boolean;
	readonly watchType: WatchType;
};
type DocumentWatch = Watch<JsonObject> & { readonly key: DocumentKey };
type Distribution = {
	count: number;
	totalMs: number;
	medianMs: number;
	p95Ms: number;
	p99Ms: number;
	minMs: number;
	maxMs: number;
};
type PhaseName =
	| "mutation"
	| "prepare"
	| "adopt"
	| "synthesize"
	| "projectApply"
	| "project"
	| "enqueue"
	| "sessionLine"
	| "delivery"
	| "opSerialize"
	| "resetSerialize"
	| "conversationAcquire"
	| "documentAcquire"
	| "conversationSerialize"
	| "documentSerialize"
	| "resetClone";
type PhaseSamples = Record<PhaseName, number[]>;
type ScenarioConfig = {
	conversationWatchCount: 0 | 1 | 8;
	documentWatchCount: 0 | 4 | 16;
	started: boolean;
	queueCapacity: number | undefined;
};
type DocMutation = { readonly key: DocumentKey; readonly mutate: (draft: Draft<JsonObject>) => void };
type CommitPlan = {
	readonly docs: readonly DocMutation[];
	readonly entryKind?: TranscriptEntry["kind"];
	readonly branch?: boolean;
	readonly unmountedOnly: boolean;
	readonly expectedConversationNoop: boolean;
};

const MODES = new Set<Mode>(["tracker"]);
const SCENARIOS = new Set<Scenario>([
	"projection-control",
	"normal",
	"fanout",
	"delayed-start-lag",
	"churn-reconnect",
	"overflow-reset",
	"branch-head-replacement",
]);
const mode = process.argv[2] as Mode;
const scenario = process.argv[3] as Scenario;
const headlineEntries = Number(process.argv[4] ?? 512);
const commitTarget = Number(process.argv[5] ?? 1_000);
const trial = Number(process.argv[6] ?? 0);
const overflowQueueOperationCapacity = Number(process.argv[7] ?? 256);
if (!MODES.has(mode)) throw new Error(`Unknown mode ${mode}`);
if (!SCENARIOS.has(scenario)) throw new Error(`Unknown scenario ${scenario}`);
if (!Number.isSafeInteger(headlineEntries) || headlineEntries < 1) throw new RangeError("Invalid entry count");
if (!Number.isSafeInteger(commitTarget) || commitTarget < 1) throw new RangeError("Invalid commit count");
if (!Number.isSafeInteger(overflowQueueOperationCapacity) || overflowQueueOperationCapacity < 1) {
	throw new RangeError("Invalid queue operation capacity");
}

const scenarioConfig = (name: Scenario): ScenarioConfig => {
	switch (name) {
		case "projection-control":
			return { conversationWatchCount: 0, documentWatchCount: 0, started: true, queueCapacity: undefined };
		case "normal":
			return { conversationWatchCount: 1, documentWatchCount: 4, started: true, queueCapacity: undefined };
		case "fanout":
			return { conversationWatchCount: 8, documentWatchCount: 16, started: true, queueCapacity: undefined };
		case "delayed-start-lag":
			return { conversationWatchCount: 1, documentWatchCount: 4, started: false, queueCapacity: undefined };
		case "churn-reconnect":
			return { conversationWatchCount: 1, documentWatchCount: 4, started: true, queueCapacity: undefined };
		case "overflow-reset":
			return {
				conversationWatchCount: 1,
				documentWatchCount: 4,
				started: false,
				queueCapacity: overflowQueueOperationCapacity,
			};
		case "branch-head-replacement":
			return { conversationWatchCount: 1, documentWatchCount: 4, started: false, queueCapacity: undefined };
	}
};
const config = scenarioConfig(scenario);

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

function hashJson(value: unknown): string {
	return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function payloadText(length: number, seed: number): string {
	const bytes = Buffer.allocUnsafe(length);
	let state = (seed ^ 0x9e3779b9) >>> 0;
	for (let index = 0; index < length; index++) {
		state ^= state << 13;
		state ^= state >>> 17;
		state ^= state << 5;
		bytes[index] = 32 + ((state >>> 0) % 95);
	}
	return bytes.toString("ascii");
}

function makeEntry(id: number, parent: number | null, kind: TranscriptEntry["kind"]): TranscriptEntry {
	switch (kind) {
		case "user":
			return {
				id,
				parent,
				kind,
				data: { role: "user", content: payloadText(2_400 + (id % 600), id), timestamp: id * 10 },
			};
		case "assistant":
			return {
				id,
				parent,
				kind,
				data: {
					role: "assistant",
					content: [{ type: "text", text: payloadText(5_500 + (id % 2_000), id) }],
					model: "claude-sonnet-provisional",
					usage: { input: 2_048 + id, output: 512 + (id % 256), cached: id % 1_024 },
				},
			};
		case "tool-result":
			return {
				id,
				parent,
				kind,
				data: {
					callId: `call-${id}`,
					tool: id % 2 === 0 ? "read" : "bash",
					status: "completed",
					output: payloadText(11_000 + (id % 5_000), id),
				},
			};
		case "application":
			return {
				id,
				parent,
				kind,
				data: {
					namespace: "pico5.provisional",
					event: "artifact.updated",
					payload: payloadText(3_200 + (id % 1_000), id),
				},
			};
	}
}

function entryKindAt(index: number): TranscriptEntry["kind"] {
	const cycle: readonly TranscriptEntry["kind"][] = [
		"user",
		"assistant",
		"assistant",
		"tool-result",
		"application",
		"assistant",
		"tool-result",
	];
	return cycle[index % cycle.length]!;
}

function resolveActiveLineage(records: ReadonlyMap<number, TranscriptEntry>, head: number | null): TranscriptEntry[] {
	const reversed: TranscriptEntry[] = [];
	const seen = new Set<number>();
	let current = head;
	while (current !== null) {
		if (seen.has(current)) throw new Error(`Transcript cycle at ${current}`);
		seen.add(current);
		const entry = records.get(current);
		if (entry === undefined) throw new Error(`Missing transcript entry ${current}`);
		reversed.push(entry);
		current = entry.parent;
	}
	reversed.reverse();
	return reversed;
}

function createTracker<T extends object>(value: T): TrackerLike<T> {
	return track(value) as unknown as TrackerLike<T>;
}

function prefixDocumentOperations(key: MountedKey, operations: readonly Op[]): Op[] {
	const prefix: Path = ["docs", key];
	return operations.map((operation): Op => {
		if (operation[0] === "r") return ["s", prefix as NonEmptyPath, operation[1]];
		const path = [...prefix, ...operation[1]];
		switch (operation[0]) {
			case "s":
				return ["s", path as unknown as NonEmptyPath, operation[2]];
			case "d":
				return ["d", path as unknown as NonEmptyPath];
			case "a":
				return ["a", path as unknown as NonEmptyPath, operation[2]];
			case "t":
				return ["t", path as unknown as NonEmptyPath, operation[2]];
			case "p":
				return ["p", path, operation[2], operation[3], operation[4]];
			case "m":
				return ["m", path, operation[2]];
			default:
				throw new TypeError(`Unknown operation ${(operation as readonly [unknown])[0]}`);
		}
	});
}

function commonEntryPrefix(left: readonly TranscriptEntry[], right: readonly TranscriptEntry[]): number {
	let index = 0;
	while (index < left.length && index < right.length && left[index]!.id === right[index]!.id) index += 1;
	return index;
}

function initialDocuments(): Record<DocumentKey, JsonObject> {
	const sections = Array.from({ length: 32 }, (_, index) => ({
		id: `section-${index}`,
		title: `Configuration section ${index}`,
		instructions: payloadText(1_850 + (index % 5) * 80, 10_000 + index),
	}));
	const tools = Array.from({ length: 24 }, (_, index) => ({
		name: `tool_${index}`,
		description: payloadText(320 + (index % 4) * 40, 20_000 + index),
		inputSchema: {
			type: "object",
			properties: {
				path: { type: "string", description: payloadText(120, 30_000 + index) },
				query: { type: "string", description: payloadText(120, 31_000 + index) },
			},
			required: ["path"],
		},
	}));
	const inboxItems = Array.from(
		{ length: 16 },
		(_, index): InboxItem => ({
			id: index + 1,
			mode: index % 3 === 0 ? "steer" : "followUp",
			text: payloadText(960 + (index % 4) * 48, 40_000 + index),
		}),
	);
	const liveTools = Array.from({ length: 8 }, (_, index) => ({
		callId: `initial-call-${index}`,
		name: index % 2 === 0 ? "read" : "bash",
		status: index < 2 ? "running" : "waiting",
		progress: index < 2 ? 0.25 : 0,
		output: payloadText(640 + index * 96, 50_000 + index),
	}));
	return {
		config: {
			schema: "pico5.doc.config.provisional.v0",
			model: { provider: "anthropic", modelId: "claude-sonnet-provisional" },
			thinkingLevel: "medium",
			selectedTools: tools.slice(0, 12).map((tool) => tool.name),
			sections,
			tools,
			temperature: 0.2,
			revision: 0,
		} as unknown as JsonObject,
		inbox: { schema: "pico5.doc.inbox.provisional.v0", items: inboxItems, revision: 0 } as unknown as JsonObject,
		turn: {
			schema: "pico5.doc.turn.provisional.v0",
			stage: "streaming",
			message: payloadText(640, 60_000),
			toolSlots: [{ callId: "initial-call-0", name: "read", status: "running", preview: "reading" }],
			revision: 0,
		} as unknown as JsonObject,
		preferences: {
			schema: "pico5.doc.preferences.provisional.v0",
			theme: "dark",
			keymap: "default",
			compactTools: false,
			fontScale: 1,
			editorProfile: payloadText(2_400, 70_000),
			shortcuts: Object.fromEntries(
				Array.from({ length: 24 }, (_, index) => [`command.${index}`, `ctrl+${String.fromCharCode(97 + index)}`]),
			),
			revision: 0,
		} as unknown as JsonObject,
		live: {
			schema: "pico5.doc.live.provisional.v0",
			status: "streaming",
			tokens: 8_192,
			cost: 0.024,
			heartbeat: 0,
			generation: { stage: "streaming", attempt: 1, partial: payloadText(8_192, 80_000) },
			tools: liveTools,
		} as unknown as JsonObject,
		audit: { schema: "pico5.doc.audit.unmounted.provisional.v0", commits: 0, note: "" } as unknown as JsonObject,
	};
}

await collect();
const processBaselineHeap = process.memoryUsage().heapUsed;

const phaseSamples: PhaseSamples = {
	mutation: [],
	prepare: [],
	adopt: [],
	synthesize: [],
	projectApply: [],
	project: [],
	enqueue: [],
	sessionLine: [],
	delivery: [],
	opSerialize: [],
	resetSerialize: [],
	conversationAcquire: [],
	documentAcquire: [],
	conversationSerialize: [],
	documentSerialize: [],
	resetClone: [],
};
const records = new Map<number, TranscriptEntry>();
let head: number | null = null;
let nextEntryId = 1;
for (let index = 0; index < headlineEntries; index++) {
	const entry = makeEntry(nextEntryId++, head, entryKindAt(index));
	records.set(entry.id, entry);
	head = entry.id;
}
const documentTrackers = {} as Record<DocumentKey, TrackerLike<JsonObject>>;
for (const [key, value] of Object.entries(initialDocuments()) as Array<[DocumentKey, JsonObject]>) {
	documentTrackers[key] = createTracker(value);
}

function rebuildExpectedView(): ConversationView {
	const docs = {} as Record<MountedKey, JsonObject>;
	for (const key of MOUNTED_KEYS) docs[key] = cloneTrusted(documentTrackers[key].value);
	return {
		schema: PROVISIONAL_SCHEMA,
		conversation: { id: "conversation-1", head },
		docs,
		entries: cloneTrusted(resolveActiveLineage(records, head)),
	};
}

let aggregate = rebuildExpectedView();
const initialAggregateBytes = Buffer.byteLength(JSON.stringify(aggregate));
let conversationSequence = 0;
const documentSequences = Object.fromEntries(
	(Object.keys(documentTrackers) as DocumentKey[]).map((key) => [key, 0]),
) as Record<DocumentKey, number>;
let conversationWatches: Array<Watch<ConversationView>> = [];
let documentWatches: DocumentWatch[] = [];
let queuedFrameReferences = 0;
let queuedOperationReferences = 0;
const queuedFrameRefCounts = new Map<DeltaFrame, number>();
let peakQueueReferences = 0;
let peakQueuedOperationReferences = 0;
let peakPendingOperationsPerWatch = 0;
let peakUniqueQueuedBatches = 0;
let deliveryFrameReferences = 0;
let deliveryOperationReferences = 0;
let aggregateOperationCount = 0;
let aggregateOperationBytes = 0;
let documentOperationCount = 0;
let documentOperationBytes = 0;
let publishedAggregateBatches = 0;
let publishedDocumentBatches = 0;
let conversationRegistrations = 0;
let documentRegistrations = 0;
let conversationBaseBytes = 0;
let documentBaseBytes = 0;
let resetCount = 0;
let resetBytes = 0;
let noOpCommitCount = 0;
let unmountedCommitCount = 0;
let unmountedPublicationViolations = 0;
let sessionCommitCount = 0;
let peakHeap = process.memoryUsage().heapUsed;
const deferredResetFrames: DeltaFrame[] = [];

function samplePeak(): void {
	peakHeap = Math.max(peakHeap, process.memoryUsage().heapUsed);
}

async function collect(): Promise<void> {
	assert.ok(global.gc, "benchmark worker requires --expose-gc");
	for (let attempt = 0; attempt < 3; attempt++) {
		await setImmediate();
		global.gc();
	}
}

function distribution(values: readonly number[]): Distribution {
	if (values.length === 0) return { count: 0, totalMs: 0, medianMs: 0, p95Ms: 0, p99Ms: 0, minMs: 0, maxMs: 0 };
	const ordered = [...values].sort((left, right) => left - right);
	return {
		count: ordered.length,
		totalMs: ordered.reduce((total, value) => total + value, 0),
		medianMs: ordered[Math.floor(ordered.length / 2)]!,
		p95Ms: ordered[Math.min(ordered.length - 1, Math.floor(ordered.length * 0.95))]!,
		p99Ms: ordered[Math.min(ordered.length - 1, Math.floor(ordered.length * 0.99))]!,
		minMs: ordered[0]!,
		maxMs: ordered.at(-1)!,
	};
}

function snapshotHash(value: object): string {
	return hashJson(value);
}

function serializeBaseSnapshot(watchType: WatchType, snapshot: object): string {
	const phase = watchType === "conversation" ? "conversationSerialize" : "documentSerialize";
	const start = performance.now();
	const encoded = JSON.stringify(snapshot);
	phaseSamples[phase].push(performance.now() - start);
	const bytes = Buffer.byteLength(encoded);
	if (watchType === "conversation") conversationBaseBytes += bytes;
	else documentBaseBytes += bytes;
	return createHash("sha256").update(encoded).digest("hex");
}

function captureSnapshot<T extends object>(value: T, phase: "conversationAcquire" | "documentAcquire"): T {
	const start = performance.now();
	const snapshot = value;
	phaseSamples[phase].push(performance.now() - start);
	samplePeak();
	return snapshot;
}

function createWatch<T extends object>(value: T, sequence: number, started: boolean, watchType: WatchType): Watch<T> {
	const acquirePhase = watchType === "conversation" ? "conversationAcquire" : "documentAcquire";
	const snapshot = captureSnapshot(value, acquirePhase);
	if (watchType === "conversation") conversationRegistrations += 1;
	else documentRegistrations += 1;
	return {
		snapshot,
		baseSequence: sequence,
		baseHash: serializeBaseSnapshot(watchType, snapshot),
		deliveredSequence: sequence,
		pendingOperationCount: 0,
		queue: [],
		started,
		watchType,
	};
}

function verifySnapshotUnchanged(watch: Watch<object>): void {
	assert.equal(snapshotHash(watch.snapshot), watch.baseHash);
}

function clearWatchQueue(watch: Watch<object>): void {
	queuedFrameReferences -= watch.queue.length;
	queuedOperationReferences -= watch.pendingOperationCount;
	for (const frame of watch.queue) {
		const references = queuedFrameRefCounts.get(frame)! - 1;
		if (references === 0) queuedFrameRefCounts.delete(frame);
		else queuedFrameRefCounts.set(frame, references);
	}
	watch.queue.length = 0;
	watch.pendingOperationCount = 0;
}

function retainQueuedFrame(watch: Watch<object>, frame: DeltaFrame): void {
	watch.queue.push(frame);
	watch.pendingOperationCount += frame.ops.length;
	queuedFrameReferences += 1;
	queuedOperationReferences += frame.ops.length;
	queuedFrameRefCounts.set(frame, (queuedFrameRefCounts.get(frame) ?? 0) + 1);
}

function resetWatch<T extends object>(watch: Watch<T>, value: T, sequence: number): void {
	clearWatchQueue(watch as unknown as Watch<object>);
	const cloneStart = performance.now();
	const resetValue = value;
	phaseSamples.resetClone.push(performance.now() - cloneStart);
	const frame: DeltaFrame = {
		kind: "delta",
		sequence,
		ops: [["r", resetValue as unknown as JsonValue]],
	};
	retainQueuedFrame(watch as unknown as Watch<object>, frame);
	deferredResetFrames.push(frame);
	resetCount += 1;
}

function enqueueWatch<T extends object>(watch: Watch<T>, frame: DeltaFrame, current: T): void {
	const previous = watch.queue.at(-1)?.sequence ?? watch.deliveredSequence;
	assert.equal(frame.sequence, previous + 1);
	if (config.queueCapacity !== undefined && watch.pendingOperationCount + frame.ops.length > config.queueCapacity) {
		resetWatch(watch, current, frame.sequence);
		return;
	}
	retainQueuedFrame(watch as unknown as Watch<object>, frame);
}

function sampleQueueMetrics(): void {
	peakQueueReferences = Math.max(peakQueueReferences, queuedFrameReferences);
	peakQueuedOperationReferences = Math.max(peakQueuedOperationReferences, queuedOperationReferences);
	peakUniqueQueuedBatches = Math.max(peakUniqueQueuedBatches, queuedFrameRefCounts.size);
	for (const watch of conversationWatches) {
		peakPendingOperationsPerWatch = Math.max(peakPendingOperationsPerWatch, watch.pendingOperationCount);
	}
	for (const watch of documentWatches) {
		peakPendingOperationsPerWatch = Math.max(peakPendingOperationsPerWatch, watch.pendingOperationCount);
	}
}

function acquireInitialWatches(): void {
	for (let index = 0; index < config.conversationWatchCount; index++) {
		conversationWatches.push(createWatch(aggregate, conversationSequence, config.started, "conversation"));
	}
	for (let index = 0; index < config.documentWatchCount; index++) {
		const key = DOCUMENT_WATCH_KEYS[index % DOCUMENT_WATCH_KEYS.length]!;
		documentWatches.push({
			...createWatch(documentTrackers[key].value, documentSequences[key], config.started, "document"),
			key,
		});
	}
}

function planCommit(index: number): CommitPlan {
	const docs: DocMutation[] = [];
	const cycle = index % 100;
	if (cycle < 70) {
		docs.push({
			key: "live",
			mutate: (draft) => {
				const live = draft as unknown as Draft<LiveDoc>;
				const limit = 4_096 + (index % 8) * 4_096;
				const chunk = payloadText(384 + (index % 5) * 64, 100_000 + index);
				live.generation.partial = `${live.generation.partial}${chunk}`.slice(-limit);
				live.generation.stage = "streaming";
				live.status = "streaming";
				live.tokens += 24 + (index % 17);
				live.cost += 0.0002;
				live.heartbeat = index;
			},
		});
	} else if (cycle < 90) {
		docs.push({
			key: "live",
			mutate: (draft) => {
				const live = draft as unknown as Draft<LiveDoc>;
				const slot = live.tools[index % live.tools.length]!;
				slot.status = cycle % 4 === 0 ? "completed" : "running";
				slot.progress = Math.min(1, slot.progress + 0.125);
				slot.output = `${slot.output.slice(-2_048)}${payloadText(512, 110_000 + index)}`;
				live.heartbeat = index;
			},
		});
	} else if (cycle < 94) {
		docs.push({
			key: "inbox",
			mutate: (draft) => {
				const inbox = draft as unknown as Draft<InboxDoc>;
				inbox.items.push({
					id: 1_000_000 + index,
					mode: cycle % 2 === 0 ? "steer" : "followUp",
					text: payloadText(1_024, 120_000 + index),
				});
				if (inbox.items.length > 20) inbox.items.shift();
				inbox.revision += 1;
			},
		});
	} else if (cycle < 96) {
		docs.push(
			{
				key: "live",
				mutate: (draft) => {
					const live = draft as unknown as Draft<LiveDoc>;
					live.status = cycle === 94 ? "admitting" : "ready";
					live.generation.stage = cycle === 94 ? "requesting" : "completed";
					live.heartbeat = index;
				},
			},
			{
				key: "turn",
				mutate: (draft) => {
					const turn = draft as unknown as Draft<TurnDoc>;
					turn.stage = cycle === 94 ? "requesting" : "idle";
					turn.message = cycle === 94 ? payloadText(720, 130_000 + index) : "";
					turn.revision += 1;
				},
			},
		);
	} else if (cycle === 96) {
		docs.push({
			key: "config",
			mutate: (draft) => {
				const configDoc = draft as unknown as Draft<ConfigDoc>;
				configDoc.thinkingLevel = index % 200 === 96 ? "high" : "medium";
				configDoc.temperature = 0.15 + (Math.floor(index / 100) % 4) * 0.05;
				const section = configDoc.sections[Math.floor(index / 100) % configDoc.sections.length]!;
				section.instructions = payloadText(section.instructions.length, 140_000 + index);
				configDoc.revision += 1;
			},
		});
	} else if (cycle === 97) {
		docs.push(
			{
				key: "preferences",
				mutate: (draft) => {
					const preferences = draft as unknown as Draft<PreferencesDoc>;
					preferences.theme = index % 200 === 97 ? "dim" : "dark";
					preferences.compactTools = !preferences.compactTools;
					preferences.editorProfile = payloadText(2_400 + (index % 4) * 256, 150_000 + index);
					preferences.revision += 1;
				},
			},
			{
				key: "turn",
				mutate: (draft) => {
					const turn = draft as unknown as Draft<TurnDoc>;
					turn.stage = "configured";
					turn.revision += 1;
				},
			},
		);
	} else if (cycle === 98) {
		docs.push(
			{
				key: "live",
				mutate: (draft) => {
					const live = draft as unknown as Draft<LiveDoc>;
					live.status = "retrying";
					live.generation.stage = "retrying";
					live.generation.attempt += 1;
					live.generation.retryAt = 1_700_000_000_000 + index * 100;
					live.heartbeat = index;
				},
			},
			{
				key: "turn",
				mutate: (draft) => {
					const turn = draft as unknown as Draft<TurnDoc>;
					turn.stage = "retrying";
					turn.revision += 1;
				},
			},
		);
	} else {
		docs.push(
			{
				key: "audit",
				mutate: (draft) => {
					const audit = draft as unknown as Draft<AuditDoc>;
					audit.commits += 1;
					audit.note = `unmounted-${index}`;
				},
			},
			{
				key: "config",
				mutate: (draft) => {
					const configDoc = draft as unknown as Draft<ConfigDoc>;
					configDoc.model = {
						provider: configDoc.model.provider,
						modelId: configDoc.model.modelId,
					};
				},
			},
		);
		return {
			docs,
			unmountedOnly: true,
			expectedConversationNoop: true,
		};
	}
	const settlement = cycle === 94 || cycle === 95;
	const branch = scenario === "branch-head-replacement" && cycle === 95 && index >= 100;
	return {
		docs,
		entryKind: settlement ? (cycle === 94 ? "user" : "assistant") : undefined,
		branch,
		unmountedOnly: false,
		expectedConversationNoop: false,
	};
}

function applyProjectedBatch(publicBatch: readonly Op[]): void {
	aggregate = applyImmutable(aggregate, publicBatch);
}

function enqueuePublishedBatches(
	aggregateFrame: DeltaFrame | undefined,
	documentFrames: readonly DocumentWatchFrame[],
): void {
	const start = performance.now();
	if (aggregateFrame !== undefined) {
		for (const watch of conversationWatches) enqueueWatch(watch, aggregateFrame, aggregate);
	}
	for (const documentFrame of documentFrames) {
		for (const watch of documentWatches) {
			if (watch.key === documentFrame.key)
				enqueueWatch(watch, documentFrame.frame, documentTrackers[watch.key].value);
		}
	}
	sampleQueueMetrics();
	phaseSamples.enqueue.push(performance.now() - start);
}

type DocumentWatchFrame = { readonly key: DocumentKey; readonly frame: DeltaFrame };

function serializePublishedBatches(
	aggregateFrame: DeltaFrame | undefined,
	documentFrames: readonly DocumentWatchFrame[],
): void {
	const start = performance.now();
	if (aggregateFrame !== undefined) {
		aggregateOperationBytes += Buffer.byteLength(JSON.stringify(aggregateFrame.ops));
	}
	for (const { frame } of documentFrames) documentOperationBytes += Buffer.byteLength(JSON.stringify(frame.ops));
	phaseSamples.opSerialize.push(performance.now() - start);
}

function finishResetSerialization(): void {
	if (deferredResetFrames.length === 0) return;
	const start = performance.now();
	for (const frame of deferredResetFrames) resetBytes += Buffer.byteLength(JSON.stringify(frame.ops));
	phaseSamples.resetSerialize.push(performance.now() - start);
	deferredResetFrames.length = 0;
}

function isResetJump(frame: DeltaFrame, previousSequence: number): boolean {
	return frame.sequence > previousSequence + 1 && frame.ops.length === 1 && frame.ops[0]![0] === "r";
}

async function forwardOpsOnly(frame: DeltaFrame): Promise<void> {
	// Models WatchHandle.start's serialized async listener. It forwards operations
	// only; it intentionally does not construct or update a consumer-side replica.
	await Promise.resolve();
	deliveryFrameReferences += 1;
	deliveryOperationReferences += frame.ops.length;
}

async function drainStartedWatches(): Promise<void> {
	const start = performance.now();
	for (const watch of conversationWatches) {
		if (!watch.started) continue;
		for (const frame of watch.queue) {
			assert.ok(frame.sequence === watch.deliveredSequence + 1 || isResetJump(frame, watch.deliveredSequence));
			await forwardOpsOnly(frame);
			watch.deliveredSequence = frame.sequence;
		}
		clearWatchQueue(watch as unknown as Watch<object>);
		assert.equal(watch.deliveredSequence, conversationSequence);
	}
	for (const watch of documentWatches) {
		if (!watch.started) continue;
		for (const frame of watch.queue) {
			assert.ok(frame.sequence === watch.deliveredSequence + 1 || isResetJump(frame, watch.deliveredSequence));
			await forwardOpsOnly(frame);
			watch.deliveredSequence = frame.sequence;
		}
		clearWatchQueue(watch);
		assert.equal(watch.deliveredSequence, documentSequences[watch.key]);
	}
	phaseSamples.delivery.push(performance.now() - start);
}

async function commit(index: number): Promise<void> {
	const plan = planCommit(index);
	const conversationBefore = conversationSequence;
	const queuedBefore = conversationWatches.reduce((total, watch) => total + watch.queue.length, 0);
	const sessionStart = performance.now();
	const mutationStart = performance.now();
	const pending: Array<{ key: DocumentKey; change: ChangeLike<JsonObject> }> = [];
	for (const mutation of plan.docs) {
		const change = documentTrackers[mutation.key].beginChange();
		mutation.mutate(change.state);
		pending.push({ key: mutation.key, change });
	}
	if (plan.entryKind !== undefined) {
		let parent = head;
		if (plan.branch) {
			const active = resolveActiveLineage(records, head);
			parent = active[Math.max(0, active.length - 48)]?.id ?? null;
		}
		const entry = makeEntry(nextEntryId++, parent, plan.entryKind);
		records.set(entry.id, entry);
		head = entry.id;
	}
	phaseSamples.mutation.push(performance.now() - mutationStart);

	const prepareStart = performance.now();
	const prepared = pending.map(({ key, change }) => ({ key, change, prepared: change.prepare() }));
	phaseSamples.prepare.push(performance.now() - prepareStart);

	const adoptStart = performance.now();
	for (const item of prepared) documentTrackers[item.key].adopt(item.prepared);
	phaseSamples.adopt.push(performance.now() - adoptStart);

	const projectStart = performance.now();
	const synthesizeStart = performance.now();
	const rawAggregateOperations: Op[] = [];
	const documentFrames: DocumentWatchFrame[] = [];
	for (const item of prepared) {
		if (item.prepared.ops.length === 0) continue;
		documentSequences[item.key] += 1;
		const documentOps = item.prepared.ops;
		documentOperationCount += documentOps.length;
		publishedDocumentBatches += 1;
		documentFrames.push({
			key: item.key,
			frame: { kind: "delta", sequence: documentSequences[item.key], ops: documentOps },
		});
		if (item.key !== "audit") rawAggregateOperations.push(...prefixDocumentOperations(item.key, documentOps));
	}
	if (plan.entryKind !== undefined) {
		const previousEntries = aggregate.entries;
		const nextEntries = resolveActiveLineage(records, head);
		const common = commonEntryPrefix(previousEntries, nextEntries);
		if (common !== previousEntries.length || common !== nextEntries.length) {
			rawAggregateOperations.push([
				"p",
				["entries"],
				common,
				previousEntries.length - common,
				cloneTrusted(nextEntries.slice(common)) as unknown as JsonValue[],
			]);
			rawAggregateOperations.push(["s", ["conversation", "head"], head]);
		}
	}
	let aggregateFrame: DeltaFrame | undefined;
	if (rawAggregateOperations.length > 0) {
		conversationSequence += 1;
		aggregateOperationCount += rawAggregateOperations.length;
		publishedAggregateBatches += 1;
		aggregateFrame = { kind: "delta", sequence: conversationSequence, ops: rawAggregateOperations };
	}
	phaseSamples.synthesize.push(performance.now() - synthesizeStart);

	const projectApplyStart = performance.now();
	if (aggregateFrame !== undefined) {
		// Immutable application may safely share public placements with the projection.
		applyProjectedBatch(aggregateFrame.ops);
	}
	phaseSamples.projectApply.push(performance.now() - projectApplyStart);
	phaseSamples.project.push(performance.now() - projectStart);

	enqueuePublishedBatches(aggregateFrame, documentFrames);
	phaseSamples.sessionLine.push(performance.now() - sessionStart);
	sessionCommitCount += 1;
	samplePeak();
	serializePublishedBatches(aggregateFrame, documentFrames);
	finishResetSerialization();
	await drainStartedWatches();
	samplePeak();

	if (plan.expectedConversationNoop) {
		noOpCommitCount += 1;
		assert.equal(aggregateFrame, undefined);
	}
	if (plan.unmountedOnly) {
		unmountedCommitCount += 1;
		const queuedAfter = conversationWatches.reduce((total, watch) => total + watch.queue.length, 0);
		if (conversationSequence !== conversationBefore || queuedAfter !== queuedBefore)
			unmountedPublicationViolations += 1;
	}
}

function registerConversationWatch(started: boolean): void {
	conversationWatches.push(createWatch(aggregate, conversationSequence, started, "conversation"));
}

function registerDocumentWatch(key: DocumentKey, started: boolean): void {
	documentWatches.push({
		...createWatch(documentTrackers[key].value, documentSequences[key], started, "document"),
		key,
	});
}

function verifyAndDropConversationWatch(watch: Watch<ConversationView>): void {
	verifySnapshotUnchanged(watch);
	if (watch.started) assert.equal(watch.deliveredSequence, conversationSequence);
	conversationWatches = conversationWatches.filter((candidate) => candidate !== watch);
}

function verifyAndDropDocumentWatch(watch: DocumentWatch): void {
	verifySnapshotUnchanged(watch);
	if (watch.started) assert.equal(watch.deliveredSequence, documentSequences[watch.key]);
	documentWatches = documentWatches.filter((candidate) => candidate !== watch);
}

await collect();
const baselineHeap = process.memoryUsage().heapUsed;
acquireInitialWatches();
await collect();
const readyHeap = process.memoryUsage().heapUsed;
const postAcquireRetainedMiB = (readyHeap - baselineHeap) / MiB;
samplePeak();

const churnInterval = Math.max(8, Math.floor(commitTarget / 10));
for (let index = 0; index < commitTarget; index++) {
	await commit(index);
	if (scenario === "churn-reconnect" && (index + 1) % churnInterval === 0) {
		const current = conversationWatches[0];
		if (current !== undefined) verifyAndDropConversationWatch(current);
		registerConversationWatch(true);
		const key = DOCUMENT_WATCH_KEYS[Math.floor((index + 1) / churnInterval) % DOCUMENT_WATCH_KEYS.length]!;
		const currentDocument = documentWatches.find((watch) => watch.key === key);
		if (currentDocument !== undefined) verifyAndDropDocumentWatch(currentDocument);
		registerDocumentWatch(key, true);
	}
}

await collect();
const queuedHeap = process.memoryUsage().heapUsed;
const postWorkRetainedMiB = (queuedHeap - baselineHeap) / MiB;
samplePeak();

function replayWatch<T extends object>(watch: Watch<T>, expected: T, expectedSequence: number): void {
	verifySnapshotUnchanged(watch);
	if (watch.started) {
		assert.equal(watch.deliveredSequence, expectedSequence);
		return;
	}
	let value = cloneTrusted(watch.snapshot);
	let sequence = watch.baseSequence;
	for (const frame of watch.queue) {
		assert.ok(frame.sequence === sequence + 1 || isResetJump(frame, sequence));
		value = applyImmutable(value, frame.ops);
		sequence = frame.sequence;
	}
	assert.equal(sequence, expectedSequence);
	assert.deepEqual(value, expected);
}

let expectedView: ConversationView | undefined = rebuildExpectedView();
assert.deepEqual(aggregate, expectedView);
expectedView = undefined;
for (const watch of conversationWatches) replayWatch(watch, aggregate, conversationSequence);
for (const watch of documentWatches) {
	replayWatch(watch, documentTrackers[watch.key].value, documentSequences[watch.key]);
}
assert.equal(unmountedPublicationViolations, 0);
assert.equal(noOpCommitCount, Math.floor(commitTarget / 100));
assert.equal(unmountedCommitCount, Math.floor(commitTarget / 100));
assert.equal(sessionCommitCount, commitTarget);

await collect();
const verifiedHeap = process.memoryUsage().heapUsed;
const postVerificationRetainedMiB = (verifiedHeap - baselineHeap) / MiB;
const finalQueueReferences =
	conversationWatches.reduce((total, watch) => total + watch.queue.length, 0) +
	documentWatches.reduce((total, watch) => total + watch.queue.length, 0);
const finalQueuedOperationReferences =
	conversationWatches.reduce((total, watch) => total + watch.pendingOperationCount, 0) +
	documentWatches.reduce((total, watch) => total + watch.pendingOperationCount, 0);
const finalUniqueQueuedBatches = new Set([
	...conversationWatches.flatMap((watch) => watch.queue),
	...documentWatches.flatMap((watch) => watch.queue),
]).size;
assert.equal(finalQueueReferences, queuedFrameReferences);
assert.equal(finalQueuedOperationReferences, queuedOperationReferences);
assert.equal(finalUniqueQueuedBatches, queuedFrameRefCounts.size);
assert.equal(deferredResetFrames.length, 0);
for (const watch of conversationWatches) clearWatchQueue(watch as unknown as Watch<object>);
for (const watch of documentWatches) clearWatchQueue(watch);
conversationWatches = [];
documentWatches = [];
assert.equal(queuedFrameReferences, 0);
assert.equal(queuedOperationReferences, 0);
assert.equal(queuedFrameRefCounts.size, 0);
await collect();
const releasedHeap = process.memoryUsage().heapUsed;
const releaseHeapMiB = (releasedHeap - baselineHeap) / MiB;

const phaseDistributions = Object.fromEntries(
	(Object.keys(phaseSamples) as PhaseName[]).map((name) => [name, distribution(phaseSamples[name])]),
) as Record<PhaseName, Distribution>;
const checksum =
	aggregate.entries.length +
	Number(aggregate.conversation.head ?? 0) +
	conversationSequence +
	MOUNTED_KEYS.reduce((total, key) => total + JSON.stringify(aggregate.docs[key]).length, 0);

console.log(
	JSON.stringify({
		mode,
		scenario,
		trial,
		provisionalSchema: PROVISIONAL_SCHEMA,
		headlineEntries,
		commitTarget,
		initialAggregateBytes,
		conversationWatchCount: config.conversationWatchCount,
		documentWatchCount: config.documentWatchCount,
		queueCapacity: config.queueCapacity ?? null,
		queueCapacityUnit: "pending-operations",
		deliveryModel: "async-serialized-ops-only-no-consumer-apply",
		conversationSequence,
		documentSequences,
		publishedAggregateBatches,
		publishedDocumentBatches,
		conversationRegistrations,
		documentRegistrations,
		conversationBaseBytes,
		documentBaseBytes,
		noOpCommitCount,
		unmountedCommitCount,
		resetCount,
		resetBytes,
		deliveryFrameReferences,
		deliveryOperationReferences,
		aggregateOperationCount,
		aggregateOperationBytes,
		documentOperationCount,
		documentOperationBytes,
		peakQueueReferences,
		peakQueuedOperationReferences,
		peakPendingOperationsPerWatch,
		peakUniqueQueuedBatches,
		finalQueueReferences,
		finalQueuedOperationReferences,
		finalUniqueQueuedBatches,
		phaseDistributions,
		authorityReadyMiB: (baselineHeap - processBaselineHeap) / MiB,
		postAcquireRetainedMiB,
		postWorkRetainedMiB,
		postVerificationRetainedMiB,
		releaseHeapMiB,
		releaseTotalMiB: (releasedHeap - processBaselineHeap) / MiB,
		peakHeapMiB: (peakHeap - baselineHeap) / MiB,
		peakTotalHeapMiB: (peakHeap - processBaselineHeap) / MiB,
		maxRssMiB: process.resourceUsage().maxRSS / 1024,
		checksum,
	}),
);

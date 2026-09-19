import { type Context, defineService, type MutableReplicatedState, type ReplicatedState } from "@earendil-works/chord";
import type { Op, Path, Seg } from "@earendil-works/chord/delta";
import type { ConversationHandle, Harness } from "./harness.ts";
import type {
	ConversationSpec,
	ConversationView,
	Entry,
	EntryScan,
	Envelope,
	Id,
	JsonObject,
	NewEntry,
	SendInput,
	ViewEvent,
} from "./types.ts";
import { WATCH_CAPACITY, type Watch } from "./view.ts";

export type PublishedConversationView = ConversationView & {
	commit: { events: ViewEvent[] };
};

export interface PicoConversationService {
	readonly view: ReplicatedState<PublishedConversationView>;
	send(input: SendInput, ctx: Context): Promise<Id>;
	write(entry: NewEntry, ctx: Context): Promise<Id>;
	inputAbort(id: Id, ctx: Context): Promise<"aborted" | "already_placed" | "not_found">;
	configSet(patch: JsonObject, ctx: Context): Promise<void>;
	abort(ctx: Context): Promise<void>;
	reset(handoff: string | null, ctx: Context): Promise<void>;
	collapse(instructions: string | null, ctx: Context): Promise<Id>;
	fork(at: Id | "start", spec: Omit<ConversationSpec, "parent">, ctx: Context): Promise<Id>;
	entries(scan: EntryScan, ctx: Context): Promise<Entry[]>;
}

/** Local registration/control plane and remote keyed conversation contract used by Chord facets. */
export const PicoHarnessService = defineService<Harness>("pi.harness", { local: true });
export const PicoConversationService = defineService<PicoConversationService>("pi.conversation");

export function createPicoConversationService<Cfg extends object>(
	harness: Pick<Harness, "abortInput" | "entries">,
	conversation: ConversationHandle<Cfg>,
	view: ReplicatedState<PublishedConversationView>,
): PicoConversationService {
	return {
		view,
		send: (input, ctx) => conversation.send(input, ctx).then((handle) => handle.id),
		write: (entry, ctx) => conversation.write(entry, ctx),
		inputAbort: (id, ctx) => harness.abortInput(id, ctx, conversation.id),
		configSet: (patch, ctx) => conversation.config.set(patch as never, ctx),
		abort: (ctx) => conversation.abort(ctx),
		reset: (handoff, ctx) => conversation.reset(handoff ?? undefined, ctx),
		collapse: (instructions, ctx) => conversation.collapse(instructions ?? undefined, ctx),
		fork: (at, spec, ctx) => conversation.fork(at, spec, ctx).then((child) => child.id),
		entries: (scan, ctx) => harness.entries({ ...scan, conversationId: conversation.id }, ctx),
	};
}

export interface ChordViewBridge {
	readonly view: MutableReplicatedState<PublishedConversationView>;
	readonly closed: boolean;
	close(): void;
}

export interface ChordViewBridgeOptions {
	capacity?: number;
	/** Called after the raw watch is closed. The owner should close and respawn its keyed service instance. */
	onFailure?: (error: Error) => void;
}

/**
 * Adapt Pico's commit-granular envelopes to one Chord publication per commit.
 * The raw listener only enqueues. Applying ops and publishing happen together,
 * off the Session line, with no await between them.
 */
export async function attachChordView(
	conversation: Pick<ConversationHandle, "watch">,
	createState: (initial: PublishedConversationView) => MutableReplicatedState<PublishedConversationView>,
	ctx: Context,
	opts: ChordViewBridgeOptions = {},
): Promise<ChordViewBridge> {
	const watch = await conversation.watch(ctx);
	const view = createState({ ...structuredClone(watch.view), commit: { events: [] } });
	return bridgeWatch(watch, view, ctx, opts);
}

function bridgeWatch(
	watch: Watch,
	view: MutableReplicatedState<PublishedConversationView>,
	ctx: Context,
	opts: ChordViewBridgeOptions,
): ChordViewBridge {
	const capacity = opts.capacity ?? WATCH_CAPACITY;
	if (!Number.isSafeInteger(capacity) || capacity < 1)
		throw new RangeError("Chord view queue capacity must be positive");
	const queue: Envelope[] = [];
	let scheduled = false;
	let closed = false;
	const fail = (cause: unknown) => {
		if (closed) return;
		closed = true;
		queue.length = 0;
		watch.stop();
		try {
			opts.onFailure?.(cause instanceof Error ? cause : new Error(String(cause)));
		} catch {}
	};
	const drain = () => {
		scheduled = false;
		while (!closed && queue.length > 0) {
			const envelope = queue.shift()!;
			try {
				applyTracked(view.state, envelope.ops);
				view.state.commit.events = structuredClone(envelope.events);
				view.publish(ctx);
			} catch (error) {
				fail(error);
			}
		}
	};
	watch.start((envelope) => {
		if (closed) return;
		if (queue.length >= capacity) {
			fail(new Error(`Pico-to-Chord view queue exceeded ${capacity} envelopes`));
			return;
		}
		queue.push(envelope);
		if (scheduled) return;
		scheduled = true;
		queueMicrotask(drain);
	});
	return {
		view,
		get closed() {
			return closed;
		},
		close() {
			if (closed) return;
			closed = true;
			queue.length = 0;
			watch.stop();
		},
	};
}

function applyTracked(root: PublishedConversationView, ops: readonly Op[]): void {
	for (const op of ops) {
		if (op[0] === "r") throw new Error("live Pico envelope unexpectedly replaced the view root");
		const path = op[1];
		if (op[0] === "p") {
			const target = resolve(root, path);
			if (!Array.isArray(target)) throw new Error(`Pico splice path is not an array: ${path.join(".")}`);
			target.splice(op[2], op[3], ...structuredClone(op[4]));
			continue;
		}
		const parent = resolve(root, path.slice(0, -1));
		if (parent === null || typeof parent !== "object")
			throw new Error(`Pico operation parent is not an object: ${path.join(".")}`);
		const key = path[path.length - 1]!;
		if (op[0] === "d") {
			if (Array.isArray(parent)) parent.splice(key as number, 1);
			else delete (parent as Record<PropertyKey, unknown>)[key];
			continue;
		}
		const record = parent as Record<PropertyKey, unknown>;
		if (op[0] === "s") record[key] = structuredClone(op[2]);
		else if (op[0] === "a") record[key] = `${String(record[key])}${op[2]}`;
		else record[key] = String(record[key]).slice(op[2]);
	}
}

function resolve(root: unknown, path: Path): unknown {
	let value = root;
	for (const segment of path) {
		if (value === null || typeof value !== "object") return undefined;
		value = (value as Record<Seg, unknown>)[segment];
	}
	return value;
}

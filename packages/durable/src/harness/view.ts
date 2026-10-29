import {
	type Context,
	type JsonValue,
	Watch,
	type WatchCall,
	type WatchEnd,
	type WatchHandle,
} from "@earendil-works/chord";
import { withoutAbortSignal } from "@earendil-works/chord/context";
import { applyImmutable, type NonEmptyPath, type Op, type Path } from "@earendil-works/chord/delta";
import { idFromNumber } from "../ids.ts";
import {
	closeEndOf,
	closeEnds,
	contained,
	guardObserver,
	type ObservedCommit,
	observation,
	type SessionImpl,
} from "../session/session.ts";
import type {
	ConversationDocToken,
	ConversationId,
	ConversationRecord,
	Cursor,
	DocumentId,
	EntryId,
	EntryQuery,
	EntryRecord,
	JsonObject,
	Observation,
	Observer,
	Storage,
} from "../types.ts";
import { AgentDoc } from "./agent.ts";
import { InboxDoc } from "./inbox.ts";
import { LiveDoc } from "./live.ts";
import { ProviderDoc } from "./provider.ts";
import { UsageDoc } from "./usage.ts";
import { closedError } from "./util.ts";

/** Structural view of one conversation: a window over its transcript and its built-in documents (spec §9.3). */
export type ConversationView = {
	readonly conversation: ConversationRecord;
	/**
	 * A window over the transcript, its fork-aware history (`Conversation.entries()`), in entry ID order. Head markers
	 * such as compaction summaries sit where they were written; their `head` tells where the entries they summarize end.
	 */
	readonly entries: readonly EntryRecord[];
	/** ID of the entry just before the window; absent when the window starts the transcript. */
	readonly before?: EntryId;
	/** Built-in conversation documents keyed by kind; absent documents are absent. */
	readonly docs: Readonly<Record<string, JsonObject>>;
};

/**
 * Which entries a view's window holds (spec §9.3). The window holds between `min` and `max` entries: it starts with
 * the newest `min` entries, takes appends, and once it would hold more than `max`, drops its oldest in one splice down
 * to `min`. With `from`, it starts at `from` instead when at most `max` entries are at or after it.
 */
export type ConversationWindow = {
	/**
	 * Where the first value's window starts, inclusive, such as right after the newest entry a client has
	 * (`ConversationTranscript.resume`). It selects only that first value: every entry committed after the attachment is
	 * appended, whatever its ID. A `from` past the newest entry starts the window empty, with `before` the newest entry.
	 */
	readonly from?: EntryId;
	/** Default 50; an integer, at least 1. */
	readonly min?: number;
	/** Default `2 * min`; an integer, at least `min`. */
	readonly max?: number;
};

/** Default `ConversationWindow.min`. */
const DEFAULT_WINDOW_MIN = 50;

/** Receives each next revision of one observer's window, and the Session's close. */
export type ViewObserver = {
	advance(call: WatchCall<ConversationView>, context: Context): void;
	/** The Session closed (`ended`), or failed (`failed`). */
	end(end: WatchEnd): void;
};

const MOUNTED = [
	AgentDoc,
	LiveDoc,
	InboxDoc,
	ProviderDoc,
	UsageDoc,
] as unknown as readonly ConversationDocToken<JsonObject>[];
const MOUNTED_KINDS: ReadonlySet<string> = new Set(MOUNTED.map((token) => token.definition.kind));
const SCAN_PAGE_SIZE = 256;

/** One observer of a mount and its window: the bounds and the revision it was last given. */
type Windowed = {
	readonly min: number;
	readonly max: number;
	value: ConversationView;
	readonly observer: ViewObserver;
};

/**
 * One conversation's mount: the documents it shows, shared by every observer, and the observers, each with its own
 * window over the entries.
 */
type Mount = {
	readonly conversation: ConversationRecord;
	docs: Readonly<Record<string, JsonObject>>;
	/** Mounted incarnation and definition version per kind; another incarnation or version is set whole. */
	readonly incarnations: Map<string, { id: DocumentId; version: number }>;
	readonly observers: Set<Windowed>;
};

const VIEWS = new WeakMap<object, ConversationViews>();

/** The view mounts of a Harness, for adapters built on them. */
export function conversationViews(harness: object): ConversationViews {
	const views = VIEWS.get(harness);
	if (views === undefined) throw new Error("Not a Harness");
	return views;
}

/** A window with its defaults applied. */
type WindowBounds = { readonly from: EntryId | undefined; readonly min: number; readonly max: number };

/** `window` with its defaults; throws a `RangeError` for bounds that are not integers or `max` below `min`. */
function resolveWindow(window: ConversationWindow | undefined): WindowBounds {
	const min = window?.min ?? DEFAULT_WINDOW_MIN;
	if (!Number.isSafeInteger(min) || min < 1) throw new RangeError(`Window min must be an integer >= 1, got ${min}`);
	const max = window?.max ?? 2 * min;
	if (!Number.isSafeInteger(max) || max < min) {
		throw new RangeError(`Window max must be an integer >= min (${min}), got ${max}`);
	}
	const from = window?.from;
	if (from !== undefined && !Number.isSafeInteger(from)) {
		throw new RangeError(`Window from must be an entry ID, got ${from}`);
	}
	return { from, min, max };
}

/**
 * The Harness's conversation view mounts: at most one per conversation, built on the Session line by its first
 * observer and dropped with its last. Each mount advances from the Session's commits as memory adopts them, deferred ones
 * (`CommitPersistence`) before they are stored, and hands each observer the next revision of its own window.
 */
export class ConversationViews {
	readonly #session: SessionImpl;
	readonly #storage: Storage;
	readonly #mounts = new Map<ConversationId, Mount>();
	#closed = false;

	constructor(session: SessionImpl, storage: Storage) {
		this.#session = session;
		this.#storage = storage;
		VIEWS.set(session, this);
		session.followCommits((publication, context) => {
			for (const [id, mount] of this.#mounts)
				advance(id, mount, publication, context, (error) => this.report(error));
		});
		session.subscribeClose(() => {
			this.#closed = true;
			const ends = closeEnds(this.#session.failure);
			for (const mount of this.#mounts.values())
				for (const windowed of [...mount.observers]) {
					contained(
						() => windowed.observer.end(closeEndOf(windowed.observer, ends)),
						(error) => this.report(error),
					);
				}
			this.#mounts.clear();
		});
	}

	/** Report an observer's listener error through the Harness. */
	report(error: unknown): void {
		this.#session.report(error);
	}

	/**
	 * Attach a synchronous observer of the view (`Harness.observeConversation()`), behind `guardObserver()`; `context`
	 * governs only the attachment.
	 */
	async observe(
		id: ConversationId,
		observer: Observer<ConversationView>,
		context: Context,
		window?: ConversationWindow,
	): Promise<Observation<ConversationView>> {
		let value!: ConversationView;
		const attached = await this.attach(
			id,
			window,
			(current, release) => {
				value = current;
				return guardObserver(observer, release, (error) => this.report(error));
			},
			context,
		);
		const signal = context.abortSignal;
		if (signal?.aborted) {
			attached.detach();
			throw signal.reason;
		}
		return observation(value, attached.observer);
	}

	/** A serialized watch of the view, an observer of its mount; aborting `context` ends it `aborted`. */
	async watch(
		id: ConversationId,
		context: Context,
		window?: ConversationWindow,
	): Promise<WatchHandle<ConversationView>> {
		const { observer } = await this.attach(
			id,
			window,
			(value, release) => new Watch<ConversationView>(value, release, (error) => this.#session.report(error)),
			context,
		);
		const signal = context.abortSignal;
		if (signal?.aborted) {
			observer.abort();
			throw signal.reason;
		}
		if (signal !== undefined) observer.observeAbort(signal);
		return observer;
	}

	/**
	 * Register an observer created from its window's first revision, atomically on the Session line: it sees every later
	 * publication and nothing earlier. `release` drops it, and the mount with its last observer.
	 */
	async attach<O extends ViewObserver>(
		id: ConversationId,
		window: ConversationWindow | undefined,
		create: (value: ConversationView, release: () => void) => O,
		context: Context,
	): Promise<{ observer: O; detach: () => void }> {
		const bounds = resolveWindow(window);
		return this.#session.readOnLine(async () => {
			const mount = this.#mounts.get(id) ?? (await this.#build(id, context));
			const { entries, before } = await loadWindow(this.#storage, id, bounds, context);
			const value = view(mount.conversation, entries, before, mount.docs);
			let windowed: Windowed | undefined;
			const detach = (): void => {
				if (windowed !== undefined) mount.observers.delete(windowed);
				if (mount.observers.size === 0 && this.#mounts.get(id) === mount) this.#mounts.delete(id);
			};
			const observer = create(value, detach);
			// Close or cancellation may begin while the mount hydrates; register nothing then.
			if (this.#closed) throw closedError(this.#session);
			context.abortSignal?.throwIfAborted();
			windowed = { min: bounds.min, max: bounds.max, value, observer };
			this.#mounts.set(id, mount);
			mount.observers.add(windowed);
			return { observer, detach };
		});
	}

	async #build(id: ConversationId, context: Context): Promise<Mount> {
		const conversation = await this.#storage.conversation(id, context);
		if (conversation === undefined) throw new Error(`Conversation ${id} does not exist`);
		const docs: Record<string, JsonObject> = {};
		const incarnations = new Map<string, { id: DocumentId; version: number }>();
		for (const token of MOUNTED) {
			const loaded = await this.#session.conversationDocumentOnLine(token, id, context);
			if (loaded === undefined) continue;
			docs[token.definition.kind] = loaded.value;
			incarnations.set(token.definition.kind, { id: loaded.record.id, version: loaded.version });
		}
		return { conversation, docs, incarnations, observers: new Set() };
	}
}

/** A view revision; `before` is a key only when set. */
function view(
	conversation: ConversationRecord,
	entries: readonly EntryRecord[],
	before: EntryId | undefined,
	docs: Readonly<Record<string, JsonObject>>,
): ConversationView {
	return before === undefined ? { conversation, entries, docs } : { conversation, entries, before, docs };
}

/**
 * A new observer's window, read on the Session line with bounded scans: the entries from `from` when at most `max` are
 * at or after it, otherwise the newest `min`, and the entry before them.
 */
async function loadWindow(
	storage: Storage,
	conversationId: ConversationId,
	bounds: WindowBounds,
	context: Context,
): Promise<{ entries: readonly EntryRecord[]; before: EntryId | undefined }> {
	const { from, min, max } = bounds;
	if (from !== undefined) {
		const since = await scanUpTo(storage, { conversationId, minEntryId: from, order: "ascending" }, max + 1, context);
		if (since.length <= max) {
			const query = { conversationId, maxEntryId: idFromNumber<EntryId>(from - 1) };
			const previous = (await storage.scanEntries(query, 1, undefined, context)).items[0];
			return { entries: since, before: previous?.id };
		}
	}
	const newest = await scanUpTo(storage, { conversationId }, min + 1, context);
	const before = newest.length > min ? newest.pop()!.id : undefined;
	return { entries: newest.reverse(), before };
}

/** Up to `limit` entries of `query`, following cursors past short pages. */
async function scanUpTo(storage: Storage, query: EntryQuery, limit: number, context: Context): Promise<EntryRecord[]> {
	const entries: EntryRecord[] = [];
	let cursor: Cursor | undefined;
	do {
		const page = await storage.scanEntries(query, Math.min(SCAN_PAGE_SIZE, limit - entries.length), cursor, context);
		entries.push(...page.items);
		cursor = page.next;
	} while (cursor !== undefined && entries.length < limit);
	return entries;
}

/**
 * Derive the mount's operations from one publication and hand each observer the next revision of its window; one that
 * throws is reported through `report`, and the others still get theirs. Documents are applied once and shared; each
 * window takes the appended entries and, past its `max`, drops its oldest down to its `min` in one splice.
 */
function advance(
	id: ConversationId,
	mount: Mount,
	publication: ObservedCommit,
	context: Context,
	report: (error: unknown) => void,
): void {
	const docOps: Op[] = [];
	// Entry writes are published in ID order.
	const appended: EntryRecord[] = [];
	for (const change of publication.changes) {
		if (change.type === "entry" && change.value.conversationId === id) {
			appended.push(change.value);
			continue;
		}
		if (change.type !== "document" || change.conversationId !== id) continue;
		const kind = change.record.kind;
		if (!MOUNTED_KINDS.has(kind) || change.record.key !== undefined) continue;
		const path: NonEmptyPath = ["docs", kind];
		const mounted = mount.incarnations.get(kind);
		if (change.kind === "retire") {
			if (mounted?.id !== change.record.id) continue;
			mount.incarnations.delete(kind);
			docOps.push(["d", path]);
		} else if (mounted?.id === change.record.id && mounted.version === change.version) {
			for (const op of change.ops) docOps.push(prefixed(op, path));
		} else {
			mount.incarnations.set(kind, { id: change.record.id, version: change.version });
			docOps.push(["s", path, change.value]);
		}
	}
	if (docOps.length === 0 && appended.length === 0) return;
	if (docOps.length > 0) mount.docs = applyImmutable({ docs: mount.docs }, docOps).docs;
	const frameContext = withoutAbortSignal(context);
	const inserted = appended as unknown as JsonValue[];
	for (const windowed of [...mount.observers]) {
		const previous = windowed.value;
		let entries = previous.entries;
		let before = previous.before;
		let ops: Op[] = docOps;
		if (appended.length > 0) {
			ops = [...docOps, ["p", ["entries"], entries.length, 0, inserted]];
			entries = entries.concat(appended);
			if (entries.length > windowed.max) {
				const drop = entries.length - windowed.min;
				before = entries[drop - 1]!.id;
				entries = entries.slice(drop);
				ops.push(["p", ["entries"], 0, drop, []], ["s", ["before"], before]);
			}
		}
		windowed.value = view(mount.conversation, entries, before, mount.docs);
		const call: WatchCall<ConversationView> = { kind: "value", value: windowed.value, ops, retired: false };
		contained(() => windowed.observer.advance(call, frameContext), report);
	}
}

/** `op` moved under `prefix`; a root replacement becomes a set of the prefix. */
function prefixed(op: Op, prefix: NonEmptyPath): Op {
	const at = (path: Path): NonEmptyPath => [...prefix, ...path] as unknown as NonEmptyPath;
	switch (op[0]) {
		case "r":
			return ["s", prefix, op[1]];
		case "p":
			return ["p", at(op[1]), op[2], op[3], op[4]];
		case "m":
			return ["m", at(op[1]), op[2]];
		case "s":
			return ["s", at(op[1]), op[2]];
		case "d":
			return ["d", at(op[1])];
		case "a":
			return ["a", at(op[1]), op[2]];
		case "t":
			return ["t", at(op[1]), op[2]];
	}
}

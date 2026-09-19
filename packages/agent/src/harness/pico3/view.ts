import { applyImmutable, type Op, type Tracker, track } from "@earendil-works/chord/delta";
import type { CommitResult, Session } from "./session.ts";
import type {
	AnyKind,
	Conversation,
	ConversationView,
	DocRef,
	Envelope,
	GenerationStatus,
	Id,
	JsonObject,
	JsonValue,
	RewindableState,
	StickyState,
	Task,
	ToolSlot,
	TurnView,
	ViewEvent,
} from "./types.ts";

export const WATCH_CAPACITY = 256;

export interface Watch {
	readonly view: ConversationView;
	readonly revision: number;
	readonly closed: boolean;
	start(listener: (envelope: Envelope) => void): void;
	stop(): void;
}

export function applyEnvelope(view: ConversationView, envelope: Envelope): ConversationView {
	return applyImmutable(view, envelope.ops) as ConversationView;
}

type Listener = (envelope: Envelope) => void;
type ViewRecord = {
	readonly conversationId: Id;
	readonly tracker: Tracker<ConversationView>;
	readonly watchers: Set<WatchImpl>;
	revision: number;
};
type Delivery = { envelope: Envelope; watchers: WatchImpl[] };

export class ViewManager {
	private readonly records = new Map<Id, ViewRecord>();
	private readonly deliveries: Delivery[] = [];
	private readonly session: Session;
	private readonly onReport: (error: unknown) => void;

	constructor(session: Session, onReport: (error: unknown) => void) {
		this.session = session;
		this.onReport = onReport;
	}

	watch(conversation: Conversation, entries: EntryList): Watch {
		let record = this.records.get(conversation.id);
		if (record === undefined) {
			const tracker = track(this.build(conversation, entries));
			tracker.flush();
			record = { conversationId: conversation.id, tracker, watchers: new Set(), revision: 0 };
			this.records.set(conversation.id, record);
		}
		const watcher = new WatchImpl(structuredClone(record.tracker.target), record.revision, this.onReport, () => {
			record!.watchers.delete(watcher);
			if (record!.watchers.size === 0 && this.records.get(conversation.id) === record)
				this.records.delete(conversation.id);
		});
		record.watchers.add(watcher);
		return watcher;
	}

	/** Runs on the Session line after persistence and in-memory indexes update. */
	update(result: CommitResult<unknown>): void {
		for (const record of [...this.records.values()]) {
			const conversation = this.session.conversationRecords.get(record.conversationId);
			if (conversation === undefined) continue;
			try {
				const changes = result.changes;
				const appended = changes.entries.filter((entry) => entry.conversationId === record.conversationId);
				const documentChanges = changes.docs.filter(
					(change) => change.ref.doc === "session" || change.ref.conversationId === record.conversationId,
				);
				const taskChanged = changes.tasks.some((task) => task.conversationId === record.conversationId);
				const events = changes.events
					.filter((scoped) => scoped.conversationId === record.conversationId)
					.map((scoped) => scoped.event);
				if (appended.length === 0 && documentChanges.length === 0 && !taskChanged && events.length === 0) continue;

				const entryOps = applyEntries(record.tracker, appended);
				const state = record.tracker.state;
				const rewindableChanged = documentChanges.some(
					(change) => change.ref.doc === "rewindable" && change.ref.conversationId === record.conversationId,
				);
				const stickyChanged = documentChanges.some(
					(change) => change.ref.doc === "sticky" && change.ref.conversationId === record.conversationId,
				);
				const configChanged = events.some((event) => event.type === "config.changed");
				const pluginChanged = documentChanges.some((change) => touchesKey(change.ops, "plugins"));
				const rewindable =
					rewindableChanged || configChanged || pluginChanged
						? this.document<RewindableState>({ doc: "rewindable", conversationId: record.conversationId })
						: undefined;
				const sticky =
					stickyChanged || taskChanged || configChanged || pluginChanged
						? this.document<StickyState>({ doc: "sticky", conversationId: record.conversationId })
						: undefined;

				if (configChanged) syncRecord(state.config, this.config(rewindable!, sticky!));
				if (stickyChanged) syncArray(state.inbox, structuredClone(sticky!.inbox));
				if (stickyChanged || taskChanged) {
					syncOptional(state, "turn", this.turn(record.conversationId, sticky!).turn);
					syncOptional(state, "compaction", this.compaction(record.conversationId).compaction);
					syncRecord(state.tasks, this.tasks(record.conversationId, sticky!));
				}
				if (pluginChanged) {
					const session = this.document<JsonObject>({ doc: "session" });
					syncRecord(state.plugins, this.plugins(rewindable!, sticky!, session));
				}

				const ops = [...entryOps, ...record.tracker.flush()];
				if (ops.length === 0 && events.length === 0) continue;
				const envelope = Object.freeze({
					revision: ++record.revision,
					ops: Object.freeze(ops) as unknown as Op[],
					events: Object.freeze(events) as unknown as ViewEvent[],
				}) satisfies Envelope;
				this.deliveries.push({ envelope, watchers: [...record.watchers] });
			} catch (error) {
				this.records.delete(record.conversationId);
				for (const watcher of [...record.watchers]) watcher.fail(error);
			}
		}
	}

	/** Runs after the Session line; listeners are synchronous and ordered. */
	deliver(): void {
		for (const delivery of this.deliveries.splice(0)) {
			for (const watcher of delivery.watchers) watcher.accept(delivery.envelope);
		}
	}

	close(): void {
		const records = [...this.records.values()];
		this.records.clear();
		this.deliveries.length = 0;
		for (const record of records) for (const watcher of [...record.watchers]) watcher.stop();
	}

	private build(conversation: Conversation, entries: EntryList): ConversationView {
		const rewindable = this.document<RewindableState>({ doc: "rewindable", conversationId: conversation.id });
		const sticky = this.document<StickyState>({ doc: "sticky", conversationId: conversation.id });
		const session = this.document<JsonObject>({ doc: "session" });
		const { sections: _sections, ...publicConversation } = conversation;
		return {
			conversation: structuredClone(publicConversation),
			entries: structuredClone(entries),
			config: this.config(rewindable, sticky),
			inbox: structuredClone(sticky.inbox),
			...this.turn(conversation.id, sticky),
			...this.compaction(conversation.id),
			tasks: this.tasks(conversation.id, sticky),
			plugins: this.plugins(rewindable, sticky, session),
		};
	}

	private document<T>(ref: DocRef): T {
		const value = this.session.loadedDocument(ref);
		if (value === undefined) throw new Error(`view document ${ref.doc} is not loaded`);
		return value as T;
	}

	private config(rewindable: RewindableState, sticky: StickyState): ConversationView["config"] {
		const out: ConversationView["config"] = {};
		for (const [key, doc] of this.session.defaults.route) {
			const source = doc === "rewindable" ? rewindable : sticky;
			const value = key in source ? source[key] : this.session.defaults[doc][key];
			if (value !== undefined) out[key] = structuredClone(value);
		}
		return out;
	}

	private turn(conversationId: Id, sticky: StickyState): { turn?: TurnView } {
		const live = [...this.session.liveTasks.values()].filter((task) => task.conversationId === conversationId);
		const turnTasks = live.filter((task) => this.session.kinds.get(task.kind)?.turn === true);
		if (turnTasks.length === 0) return {};
		const generation = turnTasks.find((task) => task.kind === "pi.generation");
		const postTools = turnTasks.find((task) => task.kind === "pi.post_tools");
		const inputTask = generation ?? postTools;
		const inputs = inputTask === undefined ? [] : inputIds(inputTask);
		const turn: TurnView = {
			inputs,
			...(generation === undefined
				? {}
				: { generation: generationStatus(generation, sticky.turn.message !== undefined) }),
			...(sticky.turn.message === undefined ? {} : { message: structuredClone(sticky.turn.message) }),
			tools: sticky.turn.tools.map(stripPrivateToolState),
		};
		return { turn };
	}

	private compaction(conversationId: Id): { compaction?: ConversationView["compaction"] } {
		const task = [...this.session.liveTasks.values()].find(
			(candidate) => candidate.conversationId === conversationId && candidate.kind === "pi.collapse",
		);
		if (task === undefined) return {};
		const input = task.input as { reason: "threshold" | "manual" | "overflow" };
		const checkpoint = task.checkpoint as { phase?: string; attempt?: number; untilMs?: number } | undefined;
		return {
			compaction: {
				taskId: task.id,
				reason: input.reason,
				stage: checkpoint?.phase === "retrying" ? "retrying" : "summarizing",
				attempt: checkpoint?.attempt ?? 1,
				...(checkpoint?.phase === "retrying" && checkpoint.untilMs !== undefined
					? { retryAt: checkpoint.untilMs }
					: {}),
			},
		};
	}

	private tasks(conversationId: Id, sticky: StickyState): ConversationView["tasks"] {
		const out: ConversationView["tasks"] = {};
		for (const task of this.session.liveTasks.values()) {
			const kind = this.session.kinds.get(task.kind);
			if (
				task.conversationId !== conversationId ||
				kind === undefined ||
				kind.turn === true ||
				task.kind === "pi.collapse"
			)
				continue;
			const slot = sticky.tasks[task.id];
			out[task.id] = {
				kind: task.kind,
				...(task.background ? { background: true as const } : {}),
				...(task.abort ? { marked: true as const } : {}),
				status: describe(kind, task, slot),
			};
		}
		return out;
	}

	private plugins(rewindable: RewindableState, sticky: StickyState, session: JsonObject): ConversationView["plugins"] {
		const out: ConversationView["plugins"] = {};
		const sessionPlugins = (session.plugins ?? {}) as { [key: string]: JsonObject };
		for (const [id, registration] of this.session.namespaces) {
			if (registration.project === undefined) continue;
			const merged: JsonObject = {
				...registration.defaults.rewindable,
				...registration.defaults.sticky,
				...registration.defaults.session,
				...(rewindable.plugins[id] ?? {}),
				...(sticky.plugins[id] ?? {}),
				...(sessionPlugins[id] ?? {}),
			};
			out[id] = strictJson(registration.project(structuredClone(merged)), `namespace ${id} view`);
		}
		return out;
	}
}

type EntryList = ConversationView["entries"];

class WatchImpl implements Watch {
	readonly view: ConversationView;
	private readonly initialRevision: number;
	private readonly onReport: (error: unknown) => void;
	private readonly onStop: () => void;
	private listener: Listener | undefined;
	private readonly buffer: Envelope[] = [];
	private stopped = false;

	constructor(view: ConversationView, revision: number, onReport: (error: unknown) => void, onStop: () => void) {
		this.view = view;
		this.initialRevision = revision;
		this.onReport = onReport;
		this.onStop = onStop;
	}

	get revision(): number {
		return this.initialRevision;
	}
	get closed(): boolean {
		return this.stopped;
	}

	start(listener: Listener): void {
		if (this.listener !== undefined || this.stopped) return;
		this.listener = listener;
		for (const envelope of this.buffer.splice(0)) {
			if (this.stopped) break;
			this.deliver(envelope);
		}
	}

	stop(): void {
		if (this.stopped) return;
		this.stopped = true;
		this.buffer.length = 0;
		this.onStop();
	}

	accept(envelope: Envelope): void {
		if (this.stopped) return;
		if (this.listener === undefined) {
			if (this.buffer.length >= WATCH_CAPACITY) {
				this.stop();
				this.report(new Error(`watch capacity ${WATCH_CAPACITY} exceeded before start()`));
				return;
			}
			this.buffer.push(envelope);
			return;
		}
		this.deliver(envelope);
	}

	private deliver(envelope: Envelope): void {
		try {
			this.listener!(envelope);
		} catch (error) {
			this.fail(error);
		}
	}

	fail(error: unknown): void {
		this.stop();
		this.report(error);
	}

	private report(error: unknown): void {
		try {
			this.onReport(error);
		} catch {}
	}
}

function applyEntries(tracker: Tracker<ConversationView>, appended: EntryList): Op[] {
	const ops: Op[] = [];
	const entries = tracker.state.entries;
	for (const entry of appended) {
		if (entry.head !== undefined) {
			const retained = entries.findIndex((candidate) => candidate.id >= entry.head!);
			const remove = retained < 0 ? entries.length : retained;
			if (remove > 0) {
				ops.push(...tracker.flush());
				entries.splice(0, remove);
				tracker.flush();
				ops.push(["p", ["entries"], 0, remove, []]);
			}
		}
		entries.push(structuredClone(entry));
	}
	return ops;
}

function inputIds(task: Task): Id[] {
	const inputs = (task.input as { inputs?: JsonValue }).inputs;
	return Array.isArray(inputs) ? inputs.filter((value): value is Id => typeof value === "number") : [];
}

function generationStatus(task: Task, streaming: boolean): GenerationStatus {
	if (task.status === "pending" && task.after.length > 0) return { stage: "waiting", on: "compaction" };
	const checkpoint = task.checkpoint as
		| {
				phase?: string;
				attempt?: number;
				untilMs?: number;
				lastError?: string;
				pollAt?: number;
		  }
		| undefined;
	if (checkpoint?.phase === "requesting")
		return { stage: streaming ? "streaming" : "requesting", attempt: checkpoint.attempt ?? 1 };
	if (checkpoint?.phase === "retrying")
		return {
			stage: "retrying",
			attempt: checkpoint.attempt ?? 1,
			retryAt: checkpoint.untilMs ?? 0,
			lastError: checkpoint.lastError ?? "",
		};
	if (checkpoint?.phase === "deferred")
		return { stage: "deferred", attempt: checkpoint.attempt ?? 1, pollAt: checkpoint.pollAt ?? 0 };
	return { stage: "preparing" };
}

function stripPrivateToolState(slot: ToolSlot): Omit<ToolSlot, "memos"> {
	const { memos: _memos, ...view } = structuredClone(slot);
	return view;
}

function describe(kind: AnyKind, task: Task, slot: JsonObject | undefined): JsonValue {
	if (typeof kind.describe !== "function")
		return { phase: task.checkpoint?.phase ?? (task.status === "pending" ? "pending" : "running") };
	const publicSlot = slot === undefined ? undefined : structuredClone(slot);
	if (publicSlot !== undefined) delete publicSlot.memos;
	const value = (kind.describe as (task: Task & { readonly slot?: Readonly<JsonObject> }) => JsonValue)({
		...task,
		...(publicSlot === undefined ? {} : { slot: publicSlot }),
	});
	return strictJson(value, `task kind ${task.kind} describe`);
}

function strictJson(value: JsonValue, what: string): JsonValue {
	const encoded = JSON.stringify(value);
	if (encoded === undefined) throw new Error(`${what} returned a non-JSON value`);
	return JSON.parse(encoded) as JsonValue;
}

function touchesKey(ops: readonly Op[], key: string): boolean {
	return ops.some((op) => op[0] === "r" || op[1][0] === key);
}

function syncOptional(target: object, key: string, next: unknown): void {
	const record = target as Record<string, unknown>;
	if (next === undefined) {
		delete record[key];
		return;
	}
	const current = record[key];
	if (same(current, next)) return;
	if (isRecord(current) && isRecord(next)) syncRecord(current, next);
	else record[key] = structuredClone(next);
}

function syncRecord(target: Record<string, unknown>, next: Record<string, unknown>): void {
	for (const key of Object.keys(target)) if (!(key in next)) delete target[key];
	for (const [key, value] of Object.entries(next)) {
		const current = target[key];
		if (same(current, value)) continue;
		if (Array.isArray(current) && Array.isArray(value)) {
			syncArray(current, value);
			continue;
		}
		if (isRecord(current) && isRecord(value)) {
			syncRecord(current, value);
			continue;
		}
		target[key] = structuredClone(value);
	}
}

function syncArray(target: unknown[], next: unknown[]): void {
	let prefix = 0;
	while (prefix < target.length && prefix < next.length) {
		if (same(target[prefix], next[prefix])) {
			prefix++;
			continue;
		}
		const current = target[prefix];
		const replacement = next[prefix];
		if (!isRecord(current) || !isRecord(replacement) || !sameArrayItem(current, replacement)) break;
		syncRecord(current, replacement);
		prefix++;
	}
	if (prefix === target.length && prefix === next.length) return;
	if (prefix === target.length) {
		target.push(...structuredClone(next.slice(prefix)));
		return;
	}
	target.splice(prefix, target.length - prefix, ...structuredClone(next.slice(prefix)));
}

function sameArrayItem(current: Record<string, unknown>, next: Record<string, unknown>): boolean {
	if (typeof current.id === "number" || typeof next.id === "number") return current.id === next.id;
	if (typeof current.callId === "string" || typeof next.callId === "string") return current.callId === next.callId;
	if (typeof current.type === "string" || typeof next.type === "string") return current.type === next.type;
	return false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function same(a: unknown, b: unknown): boolean {
	if (Object.is(a, b)) return true;
	return JSON.stringify(a) === JSON.stringify(b);
}

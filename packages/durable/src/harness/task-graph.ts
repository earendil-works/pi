import { type Context, type JsonValue, Watch, type WatchCall, type WatchHandle } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT, withoutAbortSignal } from "@earendil-works/chord/context";
import { applyImmutable, type Op } from "@earendil-works/chord/delta";
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
	ConversationId,
	JoinPolicy,
	Observation,
	Observer,
	Storage,
	TaskId,
	TaskOutcome,
	TaskRecord,
} from "../types.ts";
import { type BlockedReason, type BlockedSubject, blockedSubject } from "./scheduler.ts";
import { closedError, scanAll } from "./util.ts";

/** A live task's durable status without its checkpoint and outcome payloads (spec §9.4). */
export type TaskGraphState =
	| { readonly status: "pending" | "running"; readonly phase: string }
	| {
			readonly status: "waiting";
			readonly phase: string;
			readonly on: readonly TaskId[];
			readonly policy: JoinPolicy;
	  }
	/** Asleep until the Harness clock reaches `until`. */
	| { readonly status: "sleeping"; readonly phase: string; readonly until: number }
	/** Outcome held until its ordinary owned work drains. */
	| { readonly status: "completing"; readonly outcome: TaskOutcome<JsonValue>["status"] };

export type TaskGraphNode = {
	readonly id: TaskId;
	readonly kind: string;
	readonly conversationId: ConversationId;
	/** Owner task; absent for a conversation-owned task. */
	readonly owner?: TaskId;
	readonly background: boolean;
	readonly abortRequested: boolean;
	readonly state: TaskGraphState;
	/**
	 * Why it cannot run here, when it cannot: no registered definition takes it (`missing_task`, `task_too_old`,
	 * `migration_failed`). Follows registry changes.
	 */
	readonly blocked?: BlockedReason;
	/** Conversations this task owns, in ID order. */
	readonly conversations: readonly ConversationId[];
};

/** Every live task of the Session (spec §9.4). */
export type TaskGraph = {
	/** Every live task, keyed by its decimal ID. */
	readonly tasks: Readonly<Record<string, TaskGraphNode>>;
};

export type TaskGraphWatch = WatchHandle<TaskGraph>;

type AnyTaskRecord = TaskRecord<JsonValue, JsonValue, JsonValue>;
type Mount = {
	value: TaskGraph;
	/** Watches and guarded host observers (`observeTaskGraph()`). */
	readonly observers: Set<Observer<TaskGraph>>;
	/** What the blocked reason reads of each live task, so a registry change can derive it again without payloads. */
	readonly records: Map<string, BlockedSubject>;
};

/** What the graph asks the scheduler: a task's blocked reason, and when reasons may change without a commit. */
export type TaskGraphBlocking = {
	readonly blocked: (record: BlockedSubject) => BlockedReason | undefined;
	readonly subscribeBlocked: (listener: () => void) => () => void;
};

const LIVE_STATUSES = ["pending", "running", "waiting", "sleeping", "completing"] as const;
const SCAN_PAGE_SIZE = 256;

/**
 * The Harness's task graph mount: built on the Session line by its first observer and dropped with its last. It
 * advances from the Session's commit publications, which are durable.
 */
export class TaskGraphView {
	readonly #session: SessionImpl;
	readonly #storage: Storage;
	readonly #blocking: TaskGraphBlocking;
	#mount: Mount | undefined;
	#closed = false;

	constructor(session: SessionImpl, storage: Storage, blocking: TaskGraphBlocking) {
		this.#session = session;
		this.#storage = storage;
		this.#blocking = blocking;
		session.followCommits((publication, context) => {
			// A commit held in memory changes documents only, which the graph does not show.
			if (this.#mount === undefined || publication.kind === "memory") return;
			advance(this.#mount, publication, context, blocking.blocked, (error) => session.report(error));
		});
		blocking.subscribeBlocked(() => this.#refreshBlocked());
		session.subscribeClose(() => {
			this.#closed = true;
			const ends = closeEnds(this.#session.failure);
			for (const observer of [...(this.#mount?.observers ?? [])]) {
				contained(
					() => observer.end(closeEndOf(observer, ends)),
					(error) => session.report(error),
				);
			}
			this.#mount = undefined;
		});
	}

	/**
	 * Attach a synchronous observer of the graph (`Harness.observeTaskGraph()`), behind `guardObserver()`; `context`
	 * governs only the attachment.
	 */
	async observe(observer: Observer<TaskGraph>, context: Context): Promise<Observation<TaskGraph>> {
		let value!: TaskGraph;
		const attached = await this.#attach((current, release) => {
			value = current;
			return guardObserver(observer, release, (error) => this.#session.report(error));
		}, context);
		const signal = context.abortSignal;
		if (signal?.aborted) {
			attached.detach();
			throw signal.reason;
		}
		return observation(value, attached.observer);
	}

	/** A serialized watch of the graph, an observer of its mount; aborting `context` ends it `aborted`. */
	async watch(context: Context): Promise<TaskGraphWatch> {
		const { observer } = await this.#attach(
			(value, release) => new Watch<TaskGraph>(value, release, (error) => this.#session.report(error)),
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

	/** Register an observer created from the current revision, atomically on the Session line. */
	#attach<O extends Observer<TaskGraph>>(
		create: (value: TaskGraph, release: () => void) => O,
		context: Context,
	): Promise<{ observer: O; detach: () => void }> {
		return this.#session.readOnLine(async () => {
			const mount = this.#mount ?? { ...(await this.#build(context)), observers: new Set<Observer<TaskGraph>>() };
			const detach = (): void => {
				mount.observers.delete(observer);
				if (mount.observers.size === 0 && this.#mount === mount) this.#mount = undefined;
			};
			const observer = create(mount.value, detach);
			// Close or cancellation may begin while the mount builds; register nothing then.
			if (this.#closed) throw closedError(this.#session);
			context.abortSignal?.throwIfAborted();
			this.#mount = mount;
			mount.observers.add(observer);
			return { observer, detach };
		});
	}

	/** On the Session line: derive every node's blocked reason again, and publish the ones that changed. */
	#refreshBlocked(): void {
		if (this.#mount === undefined || this.#closed) return;
		this.#session
			.readOnLine(async () => {
				const mount = this.#mount;
				if (mount === undefined) return;
				const ops: Op[] = [];
				for (const [key, record] of mount.records) {
					const blocked = this.#blocking.blocked(record);
					if (blocked === mount.value.tasks[key]?.blocked) continue;
					ops.push(
						blocked === undefined ? ["d", ["tasks", key, "blocked"]] : ["s", ["tasks", key, "blocked"], blocked],
					);
				}
				publish(mount, ops, BACKGROUND_CONTEXT, (error) => this.#session.report(error));
			})
			// Rejected only once the Session is closing or failed.
			.catch(() => {});
	}

	async #build(context: Context): Promise<Omit<Mount, "observers">> {
		const tasks: Record<string, TaskGraphNode> = {};
		const live = new Map<string, BlockedSubject>();
		const records: AnyTaskRecord[] = [];
		for (const status of LIVE_STATUSES) {
			records.push(
				...(await scanAll((cursor) => this.#storage.scanTasks({ status }, SCAN_PAGE_SIZE, cursor, context))),
			);
		}
		records.sort((a, b) => a.id - b.id);
		for (const record of records) {
			const owned = await scanAll((cursor) =>
				this.#storage.scanConversations({ ownerTaskId: record.id }, SCAN_PAGE_SIZE, cursor, context),
			);
			const conversations = owned.map((conversation) => conversation.id).sort((a, b) => a - b);
			const subject = blockedSubject(record);
			tasks[String(record.id)] = nodeOf(record, conversations, this.#blocking.blocked(subject));
			live.set(String(record.id), subject);
		}
		return { value: { tasks }, records: live };
	}
}

/**
 * Derive the mount's operations from one publication, apply them, and hand the revision to every observer; one that
 * throws is reported through `report`, and the others still get it.
 */
function advance(
	mount: Mount,
	publication: ObservedCommit,
	context: Context,
	blocked: TaskGraphBlocking["blocked"],
	report: (error: unknown) => void,
): void {
	const ops: Op[] = [];
	// Nodes this publication set or deleted, over the mount's value.
	const changed = new Map<string, TaskGraphNode | undefined>();
	const node = (key: string): TaskGraphNode | undefined =>
		changed.has(key) ? changed.get(key) : mount.value.tasks[key];
	for (const change of publication.changes) {
		if (change.type !== "task") continue;
		const record = change.value;
		const key = String(record.id);
		const previous = node(key);
		if (record.state.status === "terminal") {
			mount.records.delete(key);
			if (previous === undefined) continue;
			ops.push(["d", ["tasks", key]]);
			changed.set(key, undefined);
			continue;
		}
		const subject = blockedSubject(record);
		mount.records.set(key, subject);
		const next = nodeOf(record, previous?.conversations ?? [], blocked(subject));
		if (previous !== undefined && JSON.stringify(next) === JSON.stringify(previous)) continue;
		ops.push(["s", ["tasks", key], next as unknown as JsonValue]);
		changed.set(key, next);
	}
	// After the tasks, so a conversation created with its owner task in one commit finds the owner's node. Change order
	// within a publication is unspecified, so each owner's list is sorted again.
	const created = new Map<string, ConversationId[]>();
	for (const change of publication.changes) {
		if (change.type !== "conversation" || change.value.owner === undefined) continue;
		const key = String(change.value.owner.taskId);
		if (node(key) !== undefined) created.set(key, [...(created.get(key) ?? []), change.value.id]);
	}
	for (const [key, ids] of created) {
		const conversations = [...node(key)!.conversations, ...ids].sort((a, b) => a - b);
		ops.push(["s", ["tasks", key, "conversations"], conversations]);
	}
	publish(mount, ops, context, report);
}

/** Apply `ops` to the mount and hand the revision to every observer; one that throws is reported. */
function publish(mount: Mount, ops: Op[], context: Context, report: (error: unknown) => void): void {
	if (ops.length === 0) return;
	mount.value = applyImmutable(mount.value, ops);
	const frameContext = withoutAbortSignal(context);
	const call: WatchCall<TaskGraph> = { kind: "value", value: mount.value, ops, retired: false };
	for (const observer of [...mount.observers]) contained(() => observer.advance(call, frameContext), report);
}

function nodeOf(
	record: AnyTaskRecord,
	conversations: readonly ConversationId[],
	blocked: BlockedReason | undefined,
): TaskGraphNode {
	return {
		id: record.id,
		kind: record.kind,
		conversationId: record.conversationId,
		...(record.owner === undefined ? {} : { owner: record.owner }),
		background: record.background,
		abortRequested: record.abortRequested,
		state: stateOf(record),
		conversations,
		...(blocked === undefined ? {} : { blocked }),
	};
}

function stateOf(record: AnyTaskRecord): TaskGraphState {
	const state = record.state;
	switch (state.status) {
		case "pending":
		case "running":
			return { status: state.status, phase: phaseOf(state.checkpoint) };
		case "waiting":
			return { status: "waiting", phase: phaseOf(state.checkpoint), on: [...state.on], policy: state.policy };
		case "sleeping":
			return { status: "sleeping", phase: phaseOf(state.checkpoint), until: state.until };
		// Terminal records never reach here: they leave the graph.
		case "completing":
		case "terminal":
			return { status: "completing", outcome: state.outcome.status };
	}
}

function phaseOf(checkpoint: JsonValue): string {
	return (checkpoint as { readonly phase: string }).phase;
}

import { type AttachedReplicatedState, type Context, type JsonValue, replicatedState } from "@earendil-works/chord";
import { withoutAbortSignal } from "@earendil-works/chord/context";
import { applyImmutable, type Op } from "@earendil-works/chord/delta";
import { CommittedStateSource, CommittedWatch } from "../session/observation.ts";
import type { SessionImpl } from "../session/session.ts";
import type {
	CommitPublication,
	ConversationId,
	JoinPolicy,
	Storage,
	TaskId,
	TaskOutcome,
	TaskRecord,
	WatchHandle,
} from "../types.ts";
import { closedError, scanAll } from "./util.ts";

/** A live task's durable status without its checkpoint and outcome payloads (spec §9.5). */
export type TaskGraphState =
	| { readonly status: "pending" | "running"; readonly phase: string }
	| {
			readonly status: "waiting";
			readonly phase: string;
			readonly on: readonly TaskId[];
			readonly policy: JoinPolicy;
	  }
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
	/** Conversations this task owns, in ID order. */
	readonly conversations: readonly ConversationId[];
};

/** Every live task of the Session (spec §9.5). */
export type TaskGraph = {
	/** Every live task, keyed by its decimal ID. */
	readonly tasks: Readonly<Record<string, TaskGraphNode>>;
};

export type TaskGraphWatch = WatchHandle<TaskGraph>;

type AnyTaskRecord = TaskRecord<JsonValue, JsonValue, JsonValue>;
type Observer = CommittedStateSource<TaskGraph> | CommittedWatch<TaskGraph>;
type Mount = { value: TaskGraph; readonly observers: Set<Observer> };

const LIVE_STATUSES = ["pending", "running", "waiting", "completing"] as const;
const SCAN_PAGE_SIZE = 256;

/**
 * The Harness's task graph mount: built on the Session line by its first observer and dropped with its last. It
 * advances from the Session's commit publications, which are durable.
 */
export class TaskGraphView {
	readonly #session: SessionImpl;
	readonly #storage: Storage;
	#mount: Mount | undefined;
	#closed = false;

	constructor(session: SessionImpl, storage: Storage) {
		this.#session = session;
		this.#storage = storage;
		session.subscribeCommits((publication, context) => {
			if (this.#mount !== undefined) advance(this.#mount, publication, context);
		});
		session.subscribeClose(() => {
			this.#closed = true;
			for (const observer of [...(this.#mount?.observers ?? [])]) observer.closeSession();
			this.#mount = undefined;
		});
	}

	/** A disposable read-only Chord state of the graph. */
	async state(context: Context): Promise<AttachedReplicatedState<TaskGraph>> {
		const { observer, detach } = await this.#attach(
			(value, release) => new CommittedStateSource<TaskGraph>(value, release),
			context,
		);
		try {
			return replicatedState(observer);
		} catch (error) {
			detach();
			throw error;
		}
	}

	/** A serialized exact-frame watch of the graph; cancelling `context` stops it. */
	async watch(context: Context): Promise<TaskGraphWatch> {
		const { observer } = await this.#attach(
			(value, release) => new CommittedWatch<TaskGraph>(value, release),
			context,
		);
		const signal = context.abortSignal;
		if (signal?.aborted) {
			observer.cancel();
			throw signal.reason;
		}
		if (signal !== undefined) observer.observeCancellation(signal);
		return observer;
	}

	/** Register an observer created from the current revision, atomically on the Session line. */
	#attach<O extends Observer>(
		create: (value: TaskGraph, release: () => void) => O,
		context: Context,
	): Promise<{ observer: O; detach: () => void }> {
		return this.#session.readOnLine(async () => {
			const mount = this.#mount ?? { value: await this.#build(context), observers: new Set<Observer>() };
			const detach = (): void => {
				mount.observers.delete(observer);
				if (mount.observers.size === 0 && this.#mount === mount) this.#mount = undefined;
			};
			const observer = create(mount.value, detach);
			// Close or cancellation may begin while the mount builds; register nothing then.
			if (this.#closed) throw closedError();
			context.abortSignal?.throwIfAborted();
			this.#mount = mount;
			mount.observers.add(observer);
			return { observer, detach };
		});
	}

	async #build(context: Context): Promise<TaskGraph> {
		const tasks: Record<string, TaskGraphNode> = {};
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
			tasks[String(record.id)] = nodeOf(record, conversations);
		}
		return { tasks };
	}
}

/** Derive the mount's operations from one publication, apply them, and hand the revision to every observer. */
function advance(mount: Mount, publication: CommitPublication, context: Context): void {
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
			if (previous === undefined) continue;
			ops.push(["d", ["tasks", key]]);
			changed.set(key, undefined);
			continue;
		}
		const next = nodeOf(record, previous?.conversations ?? []);
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
	if (ops.length === 0) return;
	mount.value = applyImmutable(mount.value, ops);
	const frameContext = withoutAbortSignal(context);
	for (const observer of [...mount.observers]) observer.advance(mount.value, ops, frameContext);
}

function nodeOf(record: AnyTaskRecord, conversations: readonly ConversationId[]): TaskGraphNode {
	return {
		id: record.id,
		kind: record.kind,
		conversationId: record.conversationId,
		...(record.owner === undefined ? {} : { owner: record.owner }),
		background: record.background,
		abortRequested: record.abortRequested,
		state: stateOf(record),
		conversations,
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
		// Terminal records never reach here: they leave the graph.
		case "completing":
		case "terminal":
			return { status: "completing", outcome: state.outcome.status };
	}
}

function phaseOf(checkpoint: JsonValue): string {
	return (checkpoint as { readonly phase: string }).phase;
}

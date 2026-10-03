import { type Context, copyJson, type JsonValue } from "@earendil-works/chord";
import { awaitWithContext, withAbortSignal } from "@earendil-works/chord/context";
import type { Models } from "@earendil-works/pi-ai";
import type { ExecutionEnv } from "../env/index.ts";
import type { SessionImpl } from "../session/session.ts";
import type { Transaction } from "../session/transaction.ts";
import type {
	CommitPublication,
	ConversationId,
	DocumentWatch,
	EntryId,
	EntryRecord,
	HookRunner,
	JsonObject,
	NextTaskState,
	RunningTask,
	Storage,
	TaskDefinition,
	TaskId,
	TaskOutcome,
	TaskRecord,
	TaskRuntime,
	TaskState,
} from "../types.ts";
import { agentHooks } from "./agent.ts";
import { readContext } from "./context.ts";
import type {
	Agent,
	AnyTask,
	ConversationHandle,
	HarnessInspection,
	RegistryReader,
	RegistrySnapshot,
	Settings,
	SettledTask,
	TaskInspection,
} from "./types.ts";
import { closedError, scanAll, Waiters } from "./util.ts";

type AnyTaskRecord = TaskRecord<JsonValue, JsonValue, JsonValue>;
/** A record that can still run code: pending, running, or waiting. */
type RunnableTaskRecord = Extract<
	AnyTaskRecord,
	{ readonly state: { readonly status: "pending" | "running" | "waiting" } }
>;
type Checkpoint = { readonly phase: string };
type ErasedDefinition = TaskDefinition<JsonValue, Checkpoint, JsonValue, object>;
type ErasedRuntime = TaskRuntime<JsonValue, Checkpoint, JsonValue, object>;
type ErasedRunningTask = RunningTask<JsonValue, Checkpoint, JsonValue>;

const SCAN_PAGE_SIZE = 256;
/** Longest delay `setTimeout` supports; longer sleeps wait in several steps. */
const MAX_TIMER_DELAY = 2_147_483_647;
const LIVE_STATUSES = ["pending", "running", "waiting", "completing"] as const;

/** Why a pending task cannot be reserved under a registry snapshot. Derived, never persisted. */
type BlockedReason = "missing_task" | "task_too_old" | "migration_failed";

type Resolution =
	| { readonly kind: "ready"; readonly task: AnyTask; readonly record: RunnableTaskRecord }
	| { readonly kind: "blocked"; readonly reason: BlockedReason };

/** A definition that can take a record, or why none can; deciding it runs no task code. */
type Fit =
	| { readonly task: AnyTask; readonly migrates: boolean }
	| { readonly reason: BlockedReason; readonly error?: unknown };

/** One in-memory execution of a task in run or abort mode. */
type Invocation = {
	readonly taskId: TaskId;
	readonly conversationId: ConversationId;
	readonly mode: "run" | "abort";
	readonly controller: AbortController;
	/** Context passed to handlers; cancelled by `controller`. */
	readonly context: Context;
	/** Watches acquired through the runtime; stopped at invocation end. */
	readonly watches: Set<DocumentWatch<JsonObject>>;
	ended: boolean;
	readonly done: Promise<void>;
	readonly finish: () => void;
};

/** What a runtime reads for the phase handler it serves: the phase's snapshot and task, and its lazily resolved agent. */
type Phase = {
	readonly snapshot: () => RegistrySnapshot;
	readonly task: () => AnyTask;
	agent: Promise<Agent> | undefined;
};

type Reservation = {
	readonly invocation: Invocation;
	readonly task: AnyTask;
	readonly snapshot: RegistrySnapshot;
};

/** Replacement definition already reported as unable to take over, per invocation. */
type ReportedTask = { readonly task: AnyTask | undefined } | undefined;

/** Outcome of the phase that just returned, judged by the next step. */
type PhaseResult = { readonly checkpoint: Checkpoint; readonly failure?: { readonly error: unknown } };

/** Step decision: continue with the next phase, end the invocation, or end it by writing `faulted`. */
type Decision = boolean | { readonly fault: unknown };

/** Terminal outcomes the scheduler writes without running task code. */
export type SchedulerOutcome = Extract<TaskOutcome<JsonValue>, { readonly status: "faulted" | "orphaned" }>;

/** An invocation a conversation handle is bound to: its signal, and a check that throws once it ended. */
export type InvocationBinding = { readonly signal: AbortSignal; check(): void };

/** The immutable ownership fields of a task. */
type TaskNode = Pick<AnyTaskRecord, "conversationId" | "owner" | "background">;

/** Where a walk up the ownership tree continues: an owner task, or a conversation. */
type Up = { readonly task: TaskId } | { readonly conversation: ConversationId };

/** One step of a walk up: an owner task with its node, a conversation, or an owner edge that is not loaded yet. */
type Step =
	| { readonly task: TaskId; readonly node: TaskNode }
	| { readonly conversation: ConversationId }
	| { readonly unknown: true };

/** Candidate records a commit staged; they override committed records in ownership walks. */
type Overlay = {
	readonly tasks: ReadonlyMap<TaskId, AnyTaskRecord>;
	readonly edges: ReadonlyMap<ConversationId, TaskId | null>;
};

/** Where ordinary ownership traversal starts: one conversation, or every ownerless conversation. */
type Scope = { readonly conversation: ConversationId } | { readonly roots: true };

export type TaskSchedulerOptions = {
	readonly session: SessionImpl;
	readonly storage: Storage;
	readonly registry: RegistryReader;
	readonly models: Models;
	/** Resolve a conversation's agent against a snapshot; the runtime calls it at most once per phase. */
	readonly agent: (conversationId: ConversationId, snapshot: RegistrySnapshot, context: Context) => Promise<Agent>;
	/** Resolve the settings; read at each access. */
	readonly settings: () => Settings;
	/** Build a conversation's environment with `HarnessOptions.env`. */
	readonly env: (conversationId: ConversationId, context: Context) => Promise<ExecutionEnv | undefined>;
	readonly now: () => number;
	readonly report: (error: unknown) => void;
	/** Harness cleanup staged in the commit that makes an outcome the scheduler wrote itself terminal. */
	readonly settleOutcome: (tx: Transaction, record: AnyTaskRecord, outcome: SchedulerOutcome) => Promise<void>;
	/** Withdraw a conversation's queued inputs, for conversation abort and abort cascades. */
	readonly withdrawInputs: (tx: Transaction, conversationId: ConversationId) => Promise<void>;
	/** Invocation-bound handle of an existing conversation, for task runtimes and tools. */
	readonly conversation: (
		id: ConversationId,
		binding: InvocationBinding,
		context: Context,
	) => Promise<ConversationHandle | undefined>;
	/** Context for scheduler commits and invocations; carries no caller cancellation. */
	readonly context: Context;
};

/**
 * Durable task scheduler of one Harness.
 *
 * `#live` mirrors every committed non-terminal task record: pending, running, waiting, and completing. The synchronous
 * commit listener updates it on the Session line, so code running on the line reads exactly the committed state from it.
 *
 * Tasks and conversations form one ownership tree (spec §5.5): a task's parent is its owner task, or its conversation;
 * a conversation's parent is its owner task, if any. Walks up that tree decide cascades, idle scopes, and whether a
 * task's ordinary owned work is live, which holds its outcome as `completing` and delays its abort handler.
 *
 * Invariant: every task transition is decided and written by one callback serialized on the Session line. That covers
 * reservation, marks, runtime commits, finalization, and the synchronous step before each phase, which applies the
 * precedence rules and writes a fault or handover. Handlers and joins run off the line. An invocation ends inside the
 * step that decides its end, so a runtime commit it queued either lands before that decision or is rejected.
 */
export class TaskScheduler {
	readonly #session: SessionImpl;
	readonly #storage: Storage;
	readonly #registry: RegistryReader;
	readonly #models: Models;
	readonly #agent: TaskSchedulerOptions["agent"];
	readonly #settings: TaskSchedulerOptions["settings"];
	readonly #env: TaskSchedulerOptions["env"];
	readonly #now: () => number;
	readonly #report: (error: unknown) => void;
	readonly #settleOutcome: TaskSchedulerOptions["settleOutcome"];
	readonly #withdrawInputs: TaskSchedulerOptions["withdrawInputs"];
	readonly #conversation: TaskSchedulerOptions["conversation"];
	readonly #context: Context;
	readonly #live = new Map<TaskId, AnyTaskRecord>();
	readonly #invocations = new Map<TaskId, Invocation>();
	readonly #taskWaiters = new Waiters<TaskId, SettledTask<JsonValue>>();
	/** Idle waiters by conversation; `undefined` waits for the whole Harness. */
	readonly #idleWaiters = new Waiters<ConversationId | undefined, void>();
	/** Definition whose migration failed per task; retried only once the registry resolves another definition. */
	readonly #failedMigrations = new Map<TaskId, { readonly task: AnyTask; readonly error: unknown }>();
	/** Owner task of each loaded conversation, `null` when ownerless. */
	readonly #edges = new Map<ConversationId, TaskId | null>();
	/** Tasks that own a loaded conversation; their nodes stay in `#settled` once terminal. */
	readonly #conversationOwners = new Set<TaskId>();
	/** Ownership fields of terminal tasks that walks pass through. */
	readonly #settled = new Map<TaskId, TaskNode>();
	/**
	 * `failFast` waiters the next reconcile checks for a failed task in `on`: at open, when they start waiting, and when
	 * one of their tasks fails.
	 */
	readonly #failFastChecks = new Set<TaskId>();
	#reconcileScheduled = false;
	#cascadePending = false;
	#unsubscribeRegistry: () => void = () => {};
	#enabled = false;
	#closing = false;
	#dirty = false;
	#draining = false;

	constructor(options: TaskSchedulerOptions) {
		this.#session = options.session;
		this.#storage = options.storage;
		this.#registry = options.registry;
		this.#models = options.models;
		this.#agent = options.agent;
		this.#settings = options.settings;
		this.#env = options.env;
		this.#now = options.now;
		this.#report = options.report;
		this.#settleOutcome = options.settleOutcome;
		this.#withdrawInputs = options.withdrawInputs;
		this.#conversation = options.conversation;
		this.#context = options.context;
	}

	/** Load live tasks and change surviving `running` tasks back to `pending`. Dispatches nothing. */
	async open(context: Context): Promise<void> {
		this.#session.subscribeCommits((publication) => this.#observe(publication));
		this.#session.subscribeClose(() => this.#seal());
		this.#unsubscribeRegistry = this.#registry.subscribe(() => this.#kick());
		await this.#session.commitWith(async (tx) => {
			// Every table read before the first write.
			const scans = [];
			for (const status of LIVE_STATUSES) {
				scans.push(await scanAll((cursor) => tx.scanTasks({ status }, SCAN_PAGE_SIZE, cursor)));
			}
			for (const records of scans) {
				for (const record of records) {
					this.#live.set(record.id, record);
					if (record.state.status === "running") {
						tx.setTask(withState(record, { status: "pending", checkpoint: record.state.checkpoint }));
					}
					if (record.state.status === "waiting" && record.state.policy === "failFast") {
						this.#failFastChecks.add(record.id);
					}
				}
			}
		}, context);
		// Derive abort marks a crash left unapplied below cancelled owners, and finalize held outcomes.
		this.#cascadePending = true;
		this.#scheduleReconcile();
	}

	/** Enable scheduling. Idempotent; the kick does nothing once closing. */
	resume(): void {
		this.#enabled = true;
		this.#kick();
	}

	/** Wait for every invocation signalled by `#seal()`. Writes nothing. */
	async join(): Promise<void> {
		await Promise.allSettled([...this.#invocations.values()].map((invocation) => invocation.done));
	}

	/**
	 * Commit the abort mark, or settle a task that no registered definition can take as `orphaned` when nothing it owns
	 * is live, then join the run invocation seen on the line; the commit listener signalled it. The abort invocation
	 * starts once the task's ordinary owned work is gone. A `completing` task is only marked.
	 */
	async abort(id: TaskId, context: Context): Promise<"marked" | "terminal"> {
		const marked = await this.#session.commitWith(async (tx) => {
			const current = await tx.task(id);
			if (current === undefined) throw new Error(`Task ${id} does not exist`);
			if (current.state.status === "terminal") return { result: "terminal" as const };
			const invocation = this.#invocations.get(id);
			if (invocation === undefined && current.state.status !== "completing") {
				await this.#loadScopes(false);
				if (!this.#ownedLive().has(id)) {
					const resolution = this.#resolve(current as RunnableTaskRecord, this.#registry.snapshot());
					if (resolution.kind === "blocked") {
						await this.#terminate(tx, current, { status: "orphaned", reason: resolution.reason });
						return { result: "marked" as const };
					}
				}
			}
			if (!current.abortRequested) tx.setTask({ ...current, abortRequested: true });
			return { result: "marked" as const, run: invocation?.mode === "run" ? invocation : undefined };
		}, context);
		// The commit listener signalled the run; join it.
		if (marked.run !== undefined) await awaitWithContext(marked.run.done, context);
		return marked.result;
	}

	async waitForTask(id: TaskId, context: Context): Promise<SettledTask<JsonValue>> {
		// Check and register on the line so no terminal publication falls between them.
		const found = await this.#session.readOnLine(async () => {
			if (this.#closing) throw closedError();
			if (this.#live.has(id)) return { promise: this.#taskWaiters.add(id, context) };
			const record = await this.#storage.task(id, context);
			if (record === undefined) throw new Error(`Task ${id} does not exist`);
			return { promise: Promise.resolve(record as SettledTask<JsonValue>) };
		});
		return found.promise;
	}

	/**
	 * Resolve when ordinary traversal from the conversation, or from every ownerless conversation, reaches no live
	 * non-background task.
	 */
	waitForIdle(conversationId: ConversationId | undefined, context: Context): Promise<void> {
		if (this.#closing) return Promise.reject(closedError());
		if (this.#idle(conversationId)) return Promise.resolve();
		this.#scheduleReconcile();
		return this.#idleWaiters.add(conversationId, context);
	}

	/**
	 * `Conversation.abort()`: in one commit, withdraw the queued inputs and mark every live non-background task that
	 * ordinary traversal from the conversation reaches; resolves once the scope is idle. With `background`, traversal
	 * crosses background boundaries, and the wait also covers every task it reached.
	 */
	async abortConversation(conversationId: ConversationId, background: boolean, context: Context): Promise<void> {
		const reached = await this.#session.commitWith(async (tx) => {
			const queued = await this.#loadScopes(true);
			const scope = { conversation: conversationId };
			const reached: TaskId[] = [];
			for (const record of this.#live.values()) {
				if (record.background && !background) continue;
				if (this.#inScope(parentOf(record), scope, background) !== true) continue;
				reached.push(record.id);
				if (!record.abortRequested) tx.setTask({ ...record, abortRequested: true });
			}
			for (const id of queued) {
				if (this.#inScope({ conversation: id }, scope, background) === true) await this.#withdrawInputs(tx, id);
			}
			return reached;
		}, context);
		if (background) for (const id of reached) await this.waitForTask(id, context);
		await this.waitForIdle(conversationId, context);
	}

	// ─── Scheduling ────────────────────────────────────────────────────────

	#observe(publication: CommitPublication): void {
		const updated: AnyTaskRecord[] = [];
		const failed: TaskId[] = [];
		let changed = false;
		for (const change of publication.changes) {
			if (change.type !== "task") continue;
			changed = true;
			const record = change.value;
			const previous = this.#live.get(record.id);
			if (failedOutcome(record) && (previous === undefined || !failedOutcome(previous))) failed.push(record.id);
			if (record.state.status === "terminal") {
				this.#live.delete(record.id);
				this.#failedMigrations.delete(record.id);
				this.#failFastChecks.delete(record.id);
				if (this.#conversationOwners.has(record.id)) this.#settled.set(record.id, nodeOf(record));
				this.#taskWaiters.resolve(record.id, record as SettledTask<JsonValue>);
				// Its owner may finalize now.
				this.#scheduleReconcile();
				continue;
			}
			if (record.abortRequested && previous?.abortRequested !== true) {
				this.#cascadePending = true;
				// Signal a run invocation of the newly marked task; its next step ends it.
				const invocation = this.#invocations.get(record.id);
				if (invocation?.mode === "run") invocation.controller.abort();
			}
			const status = record.state.status;
			if (status === "completing" && previous?.state.status !== "completing") {
				if (cancellationIntent(record)) this.#cascadePending = true;
				this.#scheduleReconcile();
			}
			if (status === "waiting" && record.state.policy === "failFast" && previous?.state.status !== "waiting") {
				this.#failFastChecks.add(record.id);
				this.#scheduleReconcile();
			}
			this.#live.set(record.id, record);
			updated.push(record);
		}
		for (const id of failed) {
			for (const record of this.#live.values()) {
				const state = record.state;
				if (state.status === "waiting" && state.policy === "failFast" && state.on.includes(id)) {
					this.#failFastChecks.add(record.id);
					this.#scheduleReconcile();
				}
			}
		}
		for (const change of publication.changes) {
			if (change.type === "conversation" && !this.#edges.has(change.value.id)) {
				this.#setEdge(change.value.id, change.value.owner?.taskId ?? null);
			}
		}
		for (const change of publication.changes) {
			// A queued input below a cancelled owner is withdrawn, even after its cascade.
			if (change.type !== "submission" || change.value.status !== "queued" || change.value.type !== "input")
				continue;
			const up = { conversation: change.value.conversationId };
			if (!this.#chainKnown(up) || this.#belowCancelled(up)) this.#cascadePending = true;
		}
		for (const record of updated) {
			// Work created below a cancelled owner, even after its cascade, is aborted too.
			if (!this.#chainKnown(parentOf(record))) this.#scheduleReconcile();
			else if (!record.background && !record.abortRequested && this.#belowCancelled(parentOf(record))) {
				this.#cascadePending = true;
			}
		}
		// Also retries, with the next commit of any kind, a cascade whose commit failed.
		if (this.#cascadePending) this.#scheduleReconcile();
		if (!changed) return;
		this.#resolveIdleWaiters();
		this.#kick();
	}

	#resolveIdleWaiters(): void {
		for (const conversationId of this.#idleWaiters.keys()) {
			if (this.#idle(conversationId)) this.#idleWaiters.resolve(conversationId);
		}
	}

	// ─── Ownership ───────────────────────────────────────────────────────────

	#scheduleReconcile(): void {
		if (this.#reconcileScheduled || this.#closing) return;
		this.#reconcileScheduled = true;
		queueMicrotask(() => void this.#reconcile());
	}

	/**
	 * One commit that applies what committed records imply: abort marks below live owners with cancellation intent
	 * (spec §5.4), `failFast` marks (spec §5.5), withdrawn queued inputs below cancelled owners, and the final terminal
	 * record of every `completing` task whose ordinary owned work is gone. The durable records are the intent, so this
	 * also repairs whatever a crash left unapplied. Resolves idle waiters that the loaded edges decide.
	 */
	async #reconcile(): Promise<void> {
		this.#reconcileScheduled = false;
		const cascade = this.#cascadePending;
		this.#cascadePending = false;
		const checks = [...this.#failFastChecks];
		this.#failFastChecks.clear();
		try {
			await this.#session.commitWith(async (tx) => {
				if (this.#closing) return;
				const queued = await this.#loadScopes(cascade);
				const marked = new Set<TaskId>();
				const mark = (record: AnyTaskRecord): void => {
					if (record.abortRequested || marked.has(record.id)) return;
					marked.add(record.id);
					tx.setTask({ ...record, abortRequested: true });
				};
				// Loading edges can reveal a cancelled owner, so marks are derived on every pass.
				for (const record of this.#live.values()) {
					if (!record.background && this.#belowCancelled(parentOf(record))) mark(record);
				}
				for (const id of checks) {
					const waiter = this.#live.get(id);
					if (waiter?.state.status !== "waiting" || !(await this.#anyFailed(waiter.state.on))) continue;
					// Every other live task: the failed one keeps its own outcome.
					for (const member of waiter.state.on) {
						const record = this.#live.get(member);
						if (record !== undefined && !failedOutcome(record)) mark(record);
					}
				}
				for (const id of queued) if (this.#belowCancelled({ conversation: id })) await this.#withdrawInputs(tx, id);
				await this.#finalize(tx);
			}, this.#context);
		} catch (error) {
			// Any pass may have staged marks, so a failed one is retried with the next commit.
			this.#cascadePending = true;
			for (const id of checks) this.#failFastChecks.add(id);
			if (!this.#closing) this.#report(error);
		}
		this.#resolveIdleWaiters();
	}

	/** Whether any of `ids` holds or ended with an outcome other than `completed`. */
	async #anyFailed(ids: readonly TaskId[]): Promise<boolean> {
		for (const id of ids) {
			const record = this.#live.get(id) ?? (await this.#storage.task(id, this.#context));
			if (record !== undefined && failedOutcome(record)) return true;
		}
		return false;
	}

	/**
	 * Write the terminal record of every `completing` task without live ordinary owned work. Finalizing one can free its
	 * owner, so this repeats over the commit's candidates until nothing changes. A held scheduler outcome gets its
	 * Harness cleanup here.
	 */
	async #finalize(tx: Transaction): Promise<void> {
		for (;;) {
			const overlay = overlayOf(tx);
			const owned = this.#ownedLive(overlay);
			const done = [...this.#liveRecords(overlay)].filter(
				(record) => record.state.status === "completing" && !owned.has(record.id),
			);
			if (done.length === 0) return;
			for (const record of done) {
				const outcome = (record.state as { readonly outcome: TaskOutcome<JsonValue> }).outcome;
				tx.setTask(withState(record, { status: "terminal", outcome }));
				// REMINDER: only the scheduler writes `faulted` and `orphaned` (spec §5.4); their cleanup waits for this commit.
				if (outcome.status === "faulted" || outcome.status === "orphaned") {
					await this.#settleOutcome(tx, record, outcome);
				}
			}
		}
	}

	/**
	 * Load the owner chains of every live task and, with `queued`, of every conversation with queued submissions, on the
	 * Session line; returns the latter. Reads committed Storage directly, so it may run inside a commit callback.
	 */
	async #loadScopes(queued: boolean): Promise<ConversationId[]> {
		for (const record of [...this.#live.values()]) {
			if (!this.#chainKnown(parentOf(record))) await this.#loadChain(parentOf(record));
		}
		if (!queued) return [];
		const submissions = await scanAll((cursor) =>
			this.#storage.scanSubmissions({ status: "queued" }, SCAN_PAGE_SIZE, cursor, this.#context),
		);
		const conversations = [...new Set(submissions.map((submission) => submission.conversationId))];
		for (const id of conversations) await this.#loadChain({ conversation: id });
		return conversations;
	}

	/** Load the owner edges and task nodes from `start` up to its ownerless root. */
	async #loadChain(start: Up, overlay?: Overlay): Promise<void> {
		let at: Up | undefined = start;
		while (at !== undefined) {
			if ("task" in at) {
				let node = this.#node(at.task, overlay);
				if (node === undefined) {
					const record = await this.#storage.task(at.task, this.#context);
					if (record === undefined) return;
					node = nodeOf(record);
					if (record.state.status === "terminal") this.#settled.set(record.id, node);
				}
				at = parentOf(node);
			} else {
				let edge = this.#edge(at.conversation, overlay);
				if (edge === undefined) {
					const record = await this.#storage.conversation(at.conversation, this.#context);
					edge = record?.owner?.taskId ?? null;
					this.#setEdge(at.conversation, edge);
				}
				at = edge === null ? undefined : { task: edge };
			}
		}
	}

	#setEdge(conversationId: ConversationId, owner: TaskId | null): void {
		this.#edges.set(conversationId, owner);
		if (owner !== null) this.#conversationOwners.add(owner);
	}

	/** Owner task of a conversation, `null` when ownerless, `undefined` while not loaded. */
	#edge(id: ConversationId, overlay?: Overlay): TaskId | null | undefined {
		return overlay?.edges.has(id) === true ? overlay.edges.get(id) : this.#edges.get(id);
	}

	#node(id: TaskId, overlay?: Overlay): TaskNode | undefined {
		return overlay?.tasks.get(id) ?? this.#live.get(id) ?? this.#settled.get(id);
	}

	/** Walk up from `start`: owner tasks and conversations, ending at an ownerless root or an edge not loaded yet. */
	*#above(start: Up, overlay?: Overlay): Generator<Step> {
		let at: Up | undefined = start;
		while (at !== undefined) {
			if ("task" in at) {
				const node = this.#node(at.task, overlay);
				if (node === undefined) {
					yield { unknown: true };
					return;
				}
				yield { task: at.task, node };
				at = parentOf(node);
			} else {
				yield { conversation: at.conversation };
				const edge = this.#edge(at.conversation, overlay);
				if (edge === undefined) {
					yield { unknown: true };
					return;
				}
				at = edge === null ? undefined : { task: edge };
			}
		}
	}

	/** Whether every owner above `start` is loaded. */
	#chainKnown(start: Up, overlay?: Overlay): boolean {
		for (const step of this.#above(start, overlay)) if ("unknown" in step) return false;
		return true;
	}

	/** Live records, with the overlay's candidates replacing committed ones; terminal candidates are gone. */
	*#liveRecords(overlay?: Overlay): Generator<AnyTaskRecord> {
		for (const record of this.#live.values()) {
			const candidate = overlay?.tasks.get(record.id) ?? record;
			if (candidate.state.status !== "terminal") yield candidate;
		}
		if (overlay === undefined) return;
		for (const record of overlay.tasks.values()) {
			if (!this.#live.has(record.id) && record.state.status !== "terminal") yield record;
		}
	}

	/**
	 * Every task with live ordinary owned work (spec §5.5), mapped to that work: each live non-background task counts for
	 * every owner task above it up to and including the first background one. Owner chains must be loaded.
	 */
	#ownedLive(overlay?: Overlay): Map<TaskId, TaskId[]> {
		const owned = new Map<TaskId, TaskId[]>();
		for (const record of this.#liveRecords(overlay)) {
			if (record.background) continue;
			for (const step of this.#above(parentOf(record), overlay)) {
				if ("unknown" in step) break;
				if (!("task" in step)) continue;
				const below = owned.get(step.task);
				if (below === undefined) owned.set(step.task, [record.id]);
				else below.push(record.id);
				if (step.node.background) break;
			}
		}
		return owned;
	}

	/**
	 * Whether ordinary traversal from `scope` reaches `start`: walking up reaches the scope's conversation, or an
	 * ownerless one for `roots`, without crossing a background owner, unless `crossBackground`. `undefined` while an
	 * edge is not loaded.
	 */
	#inScope(start: Up, scope: Scope, crossBackground = false): boolean | undefined {
		for (const step of this.#above(start)) {
			if ("unknown" in step) return undefined;
			if ("conversation" in step) {
				if ("conversation" in scope && step.conversation === scope.conversation) return true;
			} else if (step.node.background && !crossBackground) {
				return false;
			}
		}
		return "roots" in scope;
	}

	/**
	 * Whether a live owner's cancellation intent reaches `start`: walking up finds an owner with intent before a
	 * background owner without it. Terminal owners never cascade (spec §5.4).
	 */
	#belowCancelled(start: Up): boolean {
		for (const step of this.#above(start)) {
			if ("unknown" in step) return false;
			if (!("task" in step)) continue;
			const live = this.#live.get(step.task);
			if (live !== undefined && cancellationIntent(live)) return true;
			if (step.node.background) return false;
		}
		return false;
	}

	/** Close listener: runs synchronously once admission is sealed, before `join()`. */
	#seal(): void {
		this.#closing = true;
		this.#unsubscribeRegistry();
		const error = closedError();
		this.#taskWaiters.rejectAll(error);
		this.#idleWaiters.rejectAll(error);
		for (const invocation of this.#invocations.values()) invocation.controller.abort();
	}

	#kick(): void {
		this.#dirty = true;
		if (this.#draining || !this.#enabled || this.#closing) return;
		this.#draining = true;
		// Never commit synchronously from a commit or registry listener.
		queueMicrotask(() => void this.#drain());
	}

	async #drain(): Promise<void> {
		try {
			while (this.#dirty && this.#enabled && !this.#closing) {
				this.#dirty = false;
				for (const reservation of await this.#reserve()) this.#start(reservation);
			}
		} catch (error) {
			if (!this.#closing) this.#report(error);
		} finally {
			this.#draining = false;
			// A wakeup that arrived during a failed pass still needs its pass.
			if (this.#dirty) this.#kick();
		}
	}

	/** Reserve every eligible task in one commit; orphan abort-marked tasks no definition can take. */
	async #reserve(): Promise<Reservation[]> {
		const reservations: Reservation[] = [];
		try {
			await this.#session.commitWith(async (tx) => {
				if (!this.#enabled || this.#closing) return;
				await this.#loadScopes(false);
				const owned = this.#ownedLive();
				// Taken once per pass, and only when some task is a candidate.
				let snapshot: RegistrySnapshot | undefined;
				for (const record of [...this.#live.values()]) {
					if (this.#invocations.has(record.id) || this.#waitingOn(record, owned).length > 0) continue;
					if (record.state.status === "completing") continue;
					const runnable = record as RunnableTaskRecord;
					const mode = record.abortRequested ? "abort" : "run";
					snapshot ??= this.#registry.snapshot();
					const resolution = this.#resolve(runnable, snapshot);
					if (resolution.kind === "blocked") {
						if (mode === "abort") {
							await this.#terminate(tx, record, { status: "orphaned", reason: resolution.reason });
						}
						continue;
					}
					if (resolution.record !== runnable || record.state.status !== "running") {
						tx.setTask(
							withState(resolution.record, {
								status: "running",
								checkpoint: resolution.record.state.checkpoint,
							}),
						);
					}
					// Registered on the line, so marks and later reservations see it and close joins it.
					const invocation = this.#createInvocation(record, mode);
					reservations.push({ invocation, task: resolution.task, snapshot });
				}
			}, this.#context);
		} catch (error) {
			for (const { invocation } of reservations) {
				this.#invocations.delete(invocation.taskId);
				invocation.finish();
			}
			throw error;
		}
		return reservations;
	}

	/**
	 * Live tasks a task waits for before its next invocation: its live ordinary owned work when abort-marked, since
	 * abort runs bottom-up, otherwise the live part of the `on` of a wait.
	 */
	#waitingOn(record: AnyTaskRecord, owned: ReadonlyMap<TaskId, readonly TaskId[]>): readonly TaskId[] {
		if (record.abortRequested) return owned.get(record.id) ?? [];
		if (record.state.status !== "waiting") return [];
		return record.state.on.filter((id) => this.#live.has(id));
	}

	/** Resolve the record's definition by kind, migrating an older stored version. */
	#resolve(record: RunnableTaskRecord, snapshot: RegistrySnapshot): Resolution {
		const fit = this.#fit(record, snapshot.task(record.kind));
		if ("reason" in fit) return { kind: "blocked", reason: fit.reason };
		if (!fit.migrates) return { kind: "ready", task: fit.task, record };
		const definition = erased(fit.task);
		try {
			if (definition.migrate === undefined) throw missingMigration(record, definition);
			const migrated = definition.migrate(record.input, record.state.checkpoint, record.version);
			const state = { ...record.state, checkpoint: copyJson(migrated.checkpoint) };
			const migratedRecord = { ...record, version: definition.version, input: copyJson(migrated.input), state };
			return { kind: "ready", task: fit.task, record: migratedRecord as RunnableTaskRecord };
		} catch (error) {
			this.#failedMigrations.set(record.id, { task: fit.task, error });
			this.#report(error);
			return { kind: "blocked", reason: "migration_failed" };
		}
	}

	#fit(record: AnyTaskRecord, task: AnyTask | undefined): Fit {
		if (task === undefined) return { reason: "missing_task" };
		const version = task.definition.version;
		if (version === record.version) return { task, migrates: false };
		if (version < record.version) return { reason: "task_too_old" };
		const failed = this.#failedMigrations.get(record.id);
		if (failed?.task === task) return { reason: "migration_failed", error: failed.error };
		return { task, migrates: true };
	}

	/**
	 * Scheduling state and every live task with its derived state, read on the Session line. Runs no task code: a
	 * pending migration shows as `ready` with `migrates`, and only a migration the scheduler already tried, or one that
	 * cannot exist, shows as failed.
	 */
	async inspect(
		snapshot: RegistrySnapshot,
	): Promise<{ scheduling: HarnessInspection["scheduling"]; tasks: TaskInspection[] }> {
		await this.#loadScopes(false);
		const owned = this.#ownedLive();
		const tasks: TaskInspection[] = [];
		for (const record of this.#live.values()) {
			tasks.push({ record, state: this.#inspectTask(record, snapshot, owned) });
		}
		const scheduling = this.#closing ? "closing" : this.#enabled ? "running" : "paused";
		return { scheduling, tasks };
	}

	#inspectTask(
		record: AnyTaskRecord,
		snapshot: RegistrySnapshot,
		owned: ReadonlyMap<TaskId, readonly TaskId[]>,
	): TaskInspection["state"] {
		if (this.#invocations.has(record.id)) return { kind: "running" };
		if (record.state.status === "completing") return { kind: "completing" };
		const on = this.#waitingOn(record, owned);
		if (on.length > 0) return { kind: "waiting", on };
		const fit = this.#fit(record, snapshot.task(record.kind));
		if ("reason" in fit) return { kind: "blocked", ...fit };
		if (fit.migrates && fit.task.definition.migrate === undefined) {
			return { kind: "blocked", reason: "migration_failed", error: missingMigration(record, erased(fit.task)) };
		}
		return { kind: "ready", migrates: fit.migrates };
	}

	#createInvocation(record: AnyTaskRecord, mode: "run" | "abort"): Invocation {
		const controller = new AbortController();
		const { promise: done, resolve: finish } = Promise.withResolvers<void>();
		const invocation: Invocation = {
			taskId: record.id,
			conversationId: record.conversationId,
			mode,
			controller,
			context: withAbortSignal(controller.signal, this.#context),
			watches: new Set(),
			ended: false,
			done,
			finish: () => finish(),
		};
		this.#invocations.set(record.id, invocation);
		return invocation;
	}

	#start(reservation: Reservation): void {
		const invocation = reservation.invocation;
		void (async () => {
			try {
				if (invocation.mode === "run") await this.#run(reservation);
				else await this.#runAbort(reservation);
			} catch (error) {
				this.#report(error);
			} finally {
				this.#end(invocation);
				invocation.finish();
				this.#kick();
			}
		})();
	}

	/** Run phase handlers, each preceded by a step that decides on the line whether the invocation continues. */
	async #run(reservation: Reservation): Promise<void> {
		const invocation = reservation.invocation;
		const state = { task: reservation.task, snapshot: reservation.snapshot, reported: undefined as ReportedTask };
		const phase: Phase = { snapshot: () => state.snapshot, task: () => state.task, agent: undefined };
		const runtime = this.#runtime(invocation, phase);
		let previous: PhaseResult | undefined;
		for (;;) {
			const current = await this.#step(invocation, (tx, current) => this.#decide(tx, current, previous, state));
			// Close may seal between the decision and dispatch.
			if (current === undefined || this.#closing) return;
			const checkpoint = current.state.checkpoint;
			// Each phase handler resolves its agent afresh, at first use.
			phase.agent = undefined;
			try {
				await erased(state.task).phases[checkpoint.phase]!(current, runtime, invocation.context);
				previous = { checkpoint };
			} catch (error) {
				previous = { checkpoint, failure: { error } };
			}
		}
	}

	/**
	 * Precedence rules for a run invocation, on the line. Rules 1 (terminal, `completing`, or `waiting`) and 2 (closing)
	 * are applied by `#step`. Returns whether the invocation continues with the next phase.
	 */
	#decide(
		tx: Transaction,
		current: ErasedRunningTask,
		previous: PhaseResult | undefined,
		state: { task: AnyTask; snapshot: RegistrySnapshot; reported: ReportedTask },
	): Decision {
		// 3. abort mark: end; a fresh abort invocation starts once the task's ordinary owned work is gone.
		if (current.abortRequested) return false;
		if (previous === undefined) return true;
		// 4. uncaught error.
		if (previous.failure !== undefined) return { fault: previous.failure.error };
		// 6. no durable progress.
		if (jsonEqual(current.state.checkpoint, previous.checkpoint)) {
			const message = `Task ${current.kind} phase ${previous.checkpoint.phase} returned without durable progress`;
			return { fault: new Error(message) };
		}
		// 5. progress: refresh the snapshot; hand over to a replacement definition that can take the task.
		state.snapshot = this.#registry.snapshot();
		const next = state.snapshot.task(current.kind);
		if (next !== state.task) {
			if (next !== undefined && canReserve(next, current)) {
				tx.setTask(withState(current, { status: "pending", checkpoint: current.state.checkpoint }));
				return false;
			}
			if (state.reported === undefined || state.reported.task !== next) {
				state.reported = { task: next };
				const cause = next === undefined ? "missing_task" : "incompatible_task";
				this.#report(
					new Error(`Task ${current.id} keeps running under its old ${current.kind} definition`, { cause }),
				);
			}
		}
		return true;
	}

	/** Run the abort handler once; rules 1, 2, and 4 apply, and returning without an outcome faults. */
	async #runAbort(reservation: Reservation): Promise<void> {
		const invocation = reservation.invocation;
		const current = this.#live.get(invocation.taskId) as ErasedRunningTask | undefined;
		if (current === undefined || this.#closing) return;
		let failure: { readonly error: unknown } | undefined;
		try {
			const phase: Phase = { snapshot: () => reservation.snapshot, task: () => reservation.task, agent: undefined };
			const runtime = this.#runtime(invocation, phase);
			await erased(reservation.task).abort(current, runtime, invocation.context);
		} catch (error) {
			failure = { error };
		}
		const message = `Abort handler of task ${invocation.taskId} returned without a terminal outcome`;
		await this.#step(invocation, () => ({ fault: failure?.error ?? new Error(message) }));
	}

	/**
	 * One synchronous decision on the Session line. A task that is no longer running (rule 1: terminal, `completing`, or
	 * `waiting`) or a closing Harness (rule 2) ends the invocation without a write; otherwise `decide` may stage a write
	 * and returns whether the invocation continues. Ending happens inside the callback, before a fault's Harness
	 * cleanup. A rejected step, such as admission after close, also ends the invocation.
	 */
	async #step(
		invocation: Invocation,
		decide: (tx: Transaction, current: ErasedRunningTask) => Decision,
	): Promise<ErasedRunningTask | undefined> {
		try {
			return await this.#session.commitWith(async (tx) => {
				const found = this.#live.get(invocation.taskId);
				const current = found?.state.status === "running" ? (found as ErasedRunningTask) : undefined;
				const decision = current !== undefined && !this.#closing ? decide(tx, current) : false;
				if (decision === true) return current;
				this.#end(invocation);
				if (decision !== false) {
					const message = decision.fault instanceof Error ? decision.fault.message : String(decision.fault);
					await this.#terminate(tx, current!, { status: "faulted", error: { message } });
				}
				return undefined;
			}, this.#context);
		} catch (error) {
			this.#end(invocation);
			if (!this.#closing) this.#report(error);
			return undefined;
		}
	}

	/**
	 * Write an outcome the scheduler decided. While the task's ordinary owned work is live it holds as `completing` and
	 * its Harness cleanup waits for the final commit (spec §5.5, rule 4); otherwise it is terminal with its cleanup.
	 */
	async #terminate(tx: Transaction, record: AnyTaskRecord, outcome: SchedulerOutcome): Promise<void> {
		await this.#loadScopes(false);
		if (this.#ownedLive(overlayOf(tx)).has(record.id)) {
			tx.setTask(withState(record, { status: "completing", outcome }));
			return;
		}
		tx.setTask(withState(record, { status: "terminal", outcome }));
		await this.#settleOutcome(tx, record, outcome);
	}

	/**
	 * Replace a running task's state with what it committed. A terminal state holds as `completing` while ordinary owned
	 * work is live, judged on the commit's candidates, so work the same commit creates below the task counts. A wait is
	 * validated first.
	 */
	async #commitState(
		tx: Transaction,
		invocation: Invocation,
		current: ErasedRunningTask,
		next: NextTaskState<Checkpoint, JsonValue>,
	): Promise<void> {
		if (next.status === "waiting") await this.#validateWait(tx, invocation, current, next.on, next.policy);
		if (next.status === "terminal") {
			const overlay = overlayOf(tx);
			await this.#loadScopes(false);
			for (const record of overlay.tasks.values()) await this.#loadChain(parentOf(record), overlay);
			if (this.#ownedLive(overlay).has(current.id)) {
				tx.setTask(withState(current, { status: "completing", outcome: next.outcome }));
				return;
			}
		}
		tx.setTask(withState(current, next));
	}

	/**
	 * A wait names existing tasks, and `failFast` only tasks the waiter owns. It may not close a cycle in the wait-for
	 * graph, whose edges run from each task to what it waits on and to its ordinary owned work (spec §5.5). An abort
	 * handler cannot wait.
	 *
	 * Invariant: the wait-for graph is acyclic. Only a wait adds an edge between existing tasks, so checking each wait
	 * maintains it.
	 */
	async #validateWait(
		tx: Transaction,
		invocation: Invocation,
		current: ErasedRunningTask,
		on: readonly TaskId[],
		policy: string,
	): Promise<void> {
		if (invocation.mode === "abort") throw new Error(`Abort handler of task ${current.id} cannot wait`);
		const overlay = overlayOf(tx);
		const reached = new Set<TaskId>();
		for (const id of on) {
			const member = overlay.tasks.get(id) ?? this.#live.get(id) ?? (await this.#storage.task(id, this.#context));
			if (member === undefined) throw new Error(`Task ${id} does not exist`);
			if (policy === "failFast" && member.owner !== current.id) {
				throw new Error(`Task ${current.id} can wait failFast only on tasks it owns; ${id} is not one`);
			}
			// Its own children already hold the waiter, so waiting on them adds no edge.
			if (member.owner !== current.id && this.#live.has(id)) reached.add(id);
		}
		if (reached.size === 0) return;
		await this.#loadScopes(false);
		const owned = this.#ownedLive();
		// The tasks reachable from the targets; iterating a set also visits what is added to it during the loop.
		for (const id of reached) {
			for (const successor of this.#waitingOn(this.#live.get(id)!, owned)) reached.add(successor);
			for (const successor of owned.get(id) ?? []) reached.add(successor);
		}
		if (reached.has(current.id)) throw new Error(`Task ${current.id} cannot close a wait cycle`);
	}

	/** End an invocation: its runtime operations reject from now on, its signal aborts, its watches stop, and its task is free. */
	#end(invocation: Invocation): void {
		if (invocation.ended) return;
		invocation.ended = true;
		if (this.#invocations.get(invocation.taskId) === invocation) this.#invocations.delete(invocation.taskId);
		for (const watch of invocation.watches) void watch.stop();
		// Pending waits bound to the invocation, such as a tool's waitForTask(), reject with it.
		invocation.controller.abort(endedError(invocation));
	}

	/** No live non-background task in the scope; a task whose owner edges are not loaded yet counts as inside. */
	#idle(conversationId: ConversationId | undefined): boolean {
		const scope: Scope = conversationId === undefined ? { roots: true } : { conversation: conversationId };
		for (const record of this.#live.values()) {
			if (!record.background && this.#inScope(parentOf(record), scope) !== false) return false;
		}
		return true;
	}

	// ─── Invocation runtime ──────────────────────────────────────────────────

	#runtime(invocation: Invocation, phase: Phase): ErasedRuntime {
		// Resolved at most once per phase handler, at first use, with the invocation's context; fixed for the phase.
		const agent = (): Promise<Agent> => {
			if (invocation.ended) return Promise.reject(endedError(invocation));
			if (phase.agent === undefined) {
				phase.agent = this.#agent(invocation.conversationId, phase.snapshot(), invocation.context);
				// A caller that stops waiting must not leave the shared resolution's failure unobserved.
				phase.agent.catch(() => {});
			}
			return phase.agent;
		};
		const hooks: HookRunner<Record<string, unknown>> = {
			each: async (name, invoke) => {
				for (const handlers of agentHooks(await agent(), phase.task().definition.name)) {
					const handler = (handlers as Record<string, unknown>)[name];
					if (typeof handler !== "function") continue;
					try {
						await invoke(handler.bind(handlers));
					} catch (error) {
						if (invocation.controller.signal.aborted) throw error;
						this.#report(error);
					}
				}
			},
		};
		const settings = this.#settings;
		return {
			taskId: invocation.taskId as TaskId<JsonValue>,
			conversationId: invocation.conversationId,
			signal: invocation.controller.signal,
			models: this.#models,
			agent: (context) =>
				invocation.ended ? Promise.reject(endedError(invocation)) : awaitWithContext(agent(), context),
			get settings() {
				return settings();
			},
			env: (context) => this.#read(invocation, () => this.#env(invocation.conversationId, context)),
			hooks: hooks as ErasedRuntime["hooks"],
			get registry() {
				return phase.snapshot();
			},
			commit: (change, context) =>
				this.#gated(
					invocation,
					async (tx, current) => {
						const next = await change(tx, current);
						if (next !== undefined) await this.#commitState(tx, invocation, current, next);
					},
					context,
				),
			memo: ((name: string, ...rest: readonly unknown[]) => {
				if (rest.length === 1) {
					return this.#read(invocation, async () => memoOf(this.#live.get(invocation.taskId), name));
				}
				const candidate = rest[0] as JsonValue;
				return this.#gated(
					invocation,
					(tx, current) => {
						const winner = memoOf(current, name);
						if (winner !== undefined) return winner;
						tx.setTask({ ...current, memos: { ...current.memos, [name]: candidate } } as AnyTaskRecord);
						return candidate;
					},
					rest[1] as Context,
				);
			}) as ErasedRuntime["memo"],
			sleep: (until, context) => this.#sleep(invocation, until, context),
			watchDoc: ((...args: readonly unknown[]) => this.#watchDoc(invocation, args)) as ErasedRuntime["watchDoc"],
			snapshot: ((...args: readonly unknown[]) =>
				this.#read(invocation, () =>
					sessionMethod(this.#session, "snapshot")(...args),
				)) as ErasedRuntime["snapshot"],
			snapshotAsOf: ((...args: readonly unknown[]) =>
				this.#read(invocation, () =>
					sessionMethod(this.#session, "snapshotAsOf")(...args),
				)) as ErasedRuntime["snapshotAsOf"],
			getTask: ((id: TaskId, context: Context) =>
				this.#read(invocation, () =>
					this.#session.readOnLine(() => this.#storage.task(id, context)),
				)) as ErasedRuntime["getTask"],
			waitForTask: ((id: TaskId, context: Context) =>
				this.#read(invocation, () =>
					this.waitForTask(id, withAbortSignal(invocation.controller.signal, context)),
				)) as ErasedRuntime["waitForTask"],
			outcomes: ((ids: readonly TaskId[], context: Context) =>
				this.#read(invocation, () =>
					this.#session.readOnLine(async () => {
						const outcomes: TaskOutcome<JsonValue>[] = [];
						for (const id of ids) {
							const state = (await this.#storage.task(id, context))?.state;
							if (state?.status !== "terminal") throw new Error(`Task ${id} is not terminal`);
							outcomes.push(state.outcome);
						}
						return outcomes;
					}),
				)) as ErasedRuntime["outcomes"],
			conversation: (id, context) =>
				this.#read(invocation, () =>
					this.#conversation(
						id,
						{
							signal: invocation.controller.signal,
							check: () => {
								if (invocation.ended) throw endedError(invocation);
							},
						},
						context,
					),
				),
			entry: ((...args: readonly unknown[]) => {
				const [token, id, context] =
					args.length === 2
						? [undefined, args[0] as EntryId, args[1] as Context]
						: [args[0] as { readonly kind: string }, args[1] as EntryId, args[2] as Context];
				return this.#read(invocation, async () => {
					const found = await this.#session.readOnLine(() =>
						this.#storage.entry(invocation.conversationId, id, context),
					);
					const entry: EntryRecord | undefined = found?.entry;
					return token === undefined || entry?.kind === token.kind ? entry : undefined;
				});
			}) as ErasedRuntime["entry"],
			context: (conversationId, context, at) =>
				this.#read(invocation, () => readContext(this.#session, this.#storage, conversationId, context, at)),
			now: () => {
				if (invocation.ended) throw endedError(invocation);
				return this.#now();
			},
			report: (error) => {
				if (invocation.ended) throw endedError(invocation);
				this.#report(error);
			},
		};
	}

	/** Run a committed-state read unless the invocation has ended. */
	async #read<T>(invocation: Invocation, read: () => Promise<T>): Promise<T> {
		if (invocation.ended) throw endedError(invocation);
		return read();
	}

	/** Commit after rereading the task on the line and gating the invocation. */
	#gated<T>(
		invocation: Invocation,
		change: (tx: Transaction, current: ErasedRunningTask) => T | Promise<T>,
		context: Context,
	): Promise<T> {
		if (invocation.ended) return Promise.reject(endedError(invocation));
		return this.#session.commitWith(
			async (tx) => {
				if (invocation.ended) throw endedError(invocation);
				if (this.#closing) throw closedError();
				const found = this.#live.get(invocation.taskId);
				if (found === undefined) throw new Error(`Task ${invocation.taskId} is terminal`);
				if (found.state.status !== "running") throw new Error(`Task ${invocation.taskId} is ${found.state.status}`);
				const current = found as ErasedRunningTask;
				if (invocation.mode === "run" && current.abortRequested) {
					throw new Error(`Task ${invocation.taskId} has a durable abort mark`);
				}
				return change(tx, current);
			},
			context,
			{ conversationId: invocation.conversationId, taskId: invocation.taskId },
		);
	}

	/** Wait until the Harness clock reaches `until`, rechecking it after every timer. */
	async #sleep(invocation: Invocation, until: number, context: Context): Promise<void> {
		if (invocation.ended) throw endedError(invocation);
		const signals = [invocation.controller.signal];
		if (context.abortSignal !== undefined) signals.push(context.abortSignal);
		const signal = AbortSignal.any(signals);
		for (;;) {
			signal.throwIfAborted();
			const remaining = until - this.#now();
			if (remaining <= 0) return;
			await delay(Math.min(remaining, MAX_TIMER_DELAY), signal);
		}
	}

	async #watchDoc(invocation: Invocation, args: readonly unknown[]): Promise<DocumentWatch<JsonObject> | undefined> {
		if (invocation.ended) throw endedError(invocation);
		const watch = (await sessionMethod(this.#session, "watchDoc")(...args)) as DocumentWatch<JsonObject> | undefined;
		if (watch === undefined) return undefined;
		if (invocation.ended) {
			void watch.stop();
			throw endedError(invocation);
		}
		invocation.watches.add(watch);
		void watch.closed.then(() => invocation.watches.delete(watch));
		return watch;
	}
}

/** A live owner's durable cancellation intent: its abort mark, or a held outcome other than `completed`. */
function cancellationIntent(record: AnyTaskRecord): boolean {
	return record.state.status !== "terminal" && (record.abortRequested || failedOutcome(record));
}

/** Whether the record holds or ends with an outcome other than `completed`. */
function failedOutcome(record: AnyTaskRecord): boolean {
	const state = record.state;
	return (state.status === "completing" || state.status === "terminal") && state.outcome.status !== "completed";
}

function parentOf(node: TaskNode): Up {
	return node.owner !== undefined ? { task: node.owner } : { conversation: node.conversationId };
}

function nodeOf(record: AnyTaskRecord): TaskNode {
	return {
		conversationId: record.conversationId,
		...(record.owner === undefined ? {} : { owner: record.owner }),
		background: record.background,
	};
}

function overlayOf(tx: Transaction): Overlay {
	const tasks = new Map(tx.stagedTasks().map((record) => [record.id, record]));
	const edges = new Map(tx.stagedConversations().map((record) => [record.id, record.owner?.taskId ?? null]));
	return { tasks, edges };
}

/** Own memo entry only; memo names such as `toString` must not resolve to inherited properties. */
function memoOf(record: AnyTaskRecord | undefined, name: string): JsonValue | undefined {
	const memos = record?.memos;
	return memos !== undefined && Object.hasOwn(memos, name) ? memos[name] : undefined;
}

/** Overloaded Session method bound for forwarding an argument list unchanged. */
function sessionMethod(
	session: SessionImpl,
	name: "snapshot" | "snapshotAsOf" | "watchDoc",
): (...args: readonly unknown[]) => Promise<unknown> {
	return (session[name] as (...args: readonly unknown[]) => Promise<unknown>).bind(session);
}

function missingMigration(record: AnyTaskRecord, definition: ErasedDefinition): Error {
	return new Error(`Task ${record.kind} version ${definition.version} has no migration from ${record.version}`);
}

function erased(task: AnyTask): ErasedDefinition {
	return task.definition as unknown as ErasedDefinition;
}

function endedError(invocation: Invocation): Error {
	return new Error(`Task ${invocation.taskId} invocation has ended`);
}

/** Replace a live record's state; memos disappear once an outcome is decided. */
function withState(record: AnyTaskRecord, state: TaskState<JsonValue, JsonValue>): AnyTaskRecord {
	if (state.status !== "terminal" && state.status !== "completing") return { ...record, state } as AnyTaskRecord;
	const { memos: _memos, ...rest } = record;
	return { ...rest, state };
}

/** Whether a definition can take the task at reservation: same version, or newer with a migration. */
function canReserve(task: AnyTask, record: AnyTaskRecord): boolean {
	const definition = task.definition;
	return (
		definition.version === record.version || (definition.version > record.version && definition.migrate !== undefined)
	);
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		const onAbort = (): void => {
			clearTimeout(timer);
			reject(signal.reason);
		};
		const timer = setTimeout(() => {
			signal.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		signal.addEventListener("abort", onAbort, { once: true });
	});
}

/** Structural equality of two JSON values; object key order is ignored. */
function jsonEqual(left: JsonValue | undefined, right: JsonValue | undefined): boolean {
	if (left === right) return true;
	if (typeof left !== "object" || typeof right !== "object" || left === null || right === null) return false;
	if (Array.isArray(left) || Array.isArray(right)) {
		if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
		return left.every((value, index) => jsonEqual(value, right[index]));
	}
	const keys = Object.keys(left);
	if (keys.length !== Object.keys(right).length) return false;
	return keys.every((key) => Object.hasOwn(right, key) && jsonEqual(left[key], right[key]));
}

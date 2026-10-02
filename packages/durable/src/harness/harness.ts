import type { AttachedReplicatedState, Context, JsonValue } from "@earendil-works/chord";
import { withAbortSignal, withoutAbortSignal } from "@earendil-works/chord/context";
import { ResetEntry } from "../entries.ts";
import type { ExecutionEnv } from "../env/index.ts";
import { SessionImpl } from "../session/session.ts";
import type { Transaction } from "../session/transaction.ts";
import type {
	ConversationId,
	ConversationOwnership,
	ConversationRecord,
	Cursor,
	EntryId,
	EntryQuery,
	EntryRecord,
	Page,
	Storage,
	SubmissionId,
	TaskId,
	TaskRecord,
	Tx,
} from "../types.ts";
import { ROOT_CONVERSATION_ID } from "../types.ts";
import { AgentDoc, configure, createAgent, resolveAgent, resolveSettings } from "./agent.ts";
import { createCompaction } from "./compaction.ts";
import { readContext } from "./context.ts";
import { InboxDoc, withdrawQueuedInputs } from "./inbox.ts";
import { LiveDoc, settleSchedulerOutcome } from "./live.ts";
import { BUILTIN_TASKS } from "./registry.ts";
import { type InvocationBinding, TaskScheduler } from "./scheduler.ts";
import { Submissions } from "./submissions.ts";
import { type TaskGraph, TaskGraphView, type TaskGraphWatch } from "./task-graph.ts";
import type {
	Agent,
	AgentChange,
	CompactionResult,
	ContextView,
	Conversation,
	ConversationAbortOptions,
	ConversationCreateOptions,
	ConversationHandle,
	ConversationInit,
	ConversationWatch,
	HarnessInspection,
	HarnessOptions,
	Harness as HarnessType,
	RegistrySnapshot,
	SettledTask,
	Submission,
	SubmissionDraft,
	ToolRegistration,
} from "./types.ts";
import { addUsageState, UsageDoc, type UsageState } from "./usage.ts";
import { scanAll } from "./util.ts";
import { type ConversationView, ConversationViews } from "./view.ts";

const SCAN_PAGE_SIZE = 256;

type CreateTarget =
	| { readonly kind: "root" }
	| { readonly kind: "independent"; readonly ownership: ConversationOwnership }
	| {
			readonly kind: "fork";
			readonly parentId: ConversationId;
			readonly at: EntryId;
			readonly ownership: ConversationOwnership;
	  };

/** What the conveniences apply in the creating commit, after the creation hook. */
type CreateOptions = { readonly agent?: AgentChange; readonly init?: ConversationInit };

/** Harness-private services used by Conversation handles. */
type ConversationHost<Tool extends ToolRegistration> = {
	readonly harness: HarnessImpl<Tool>;
	readonly storage: Storage;
	readonly tasks: TaskScheduler;
	readonly submissions: Submissions;
	readonly views: ConversationViews;
	readonly now: () => number;
	create(target: CreateTarget, options: CreateOptions, context: Context): Promise<Conversation>;
};

class ConversationImpl<Tool extends ToolRegistration> implements Conversation {
	readonly id: ConversationId;
	readonly #host: ConversationHost<Tool>;

	constructor(id: ConversationId, host: ConversationHost<Tool>) {
		this.id = id;
		this.#host = host;
	}

	agent(context: Context): Promise<Agent> {
		return this.#host.harness.resolveAgent(this.id, undefined, context);
	}

	configure(change: AgentChange, context: Context): Promise<void> {
		return this.#host.harness.commitWith((tx) => configure(tx, this.id, change), context);
	}

	submit(submission: SubmissionDraft, context: Context): Promise<Submission> {
		return this.#host.submissions.submit(this.id, submission, context);
	}

	compact(instructions: string | undefined, context: Context): Promise<TaskId<CompactionResult>> {
		this.#host.tasks.resume();
		const input = { reason: "manual", ...(instructions === undefined ? {} : { instructions }) } as const;
		return this.#host.harness.commitWith((tx) => createCompaction(tx, this.id, input), context);
	}

	async reset(handoff: string | undefined, context: Context): Promise<void> {
		const model =
			handoff === undefined
				? {}
				: { model: [{ role: "user", content: handoff, timestamp: this.#host.now() } as const] };
		const entry = { kind: ResetEntry.kind, head: "self", ...model } as const;
		await this.#host.submissions.submit(this.id, { type: "write", entry }, context);
	}

	commit<T>(change: (tx: Tx) => T | Promise<T>, context: Context): Promise<T> {
		return this.#host.harness.commitWith(change, context, { conversationId: this.id });
	}

	context(context: Context): Promise<ContextView> {
		return readContext(this.#host.harness, this.#host.storage, this.id, context);
	}

	entries(
		query: Omit<EntryQuery, "conversationId">,
		limit: number,
		cursor: Cursor | undefined,
		context: Context,
	): Promise<Page<EntryRecord, Cursor>> {
		const bounded: EntryQuery = {
			conversationId: this.id,
			...(query.minEntryId === undefined ? {} : { minEntryId: query.minEntryId }),
			...(query.maxEntryId === undefined ? {} : { maxEntryId: query.maxEntryId }),
		};
		return this.#host.harness.readOnLine(() => this.#host.storage.scanEntries(bounded, limit, cursor, context));
	}

	fork(at: EntryId, options: ConversationCreateOptions, context: Context): Promise<Conversation> {
		return this.#host.create({ kind: "fork", parentId: this.id, at, ownership: options.ownership }, options, context);
	}

	abort(context: Context, options?: ConversationAbortOptions): Promise<void> {
		this.#host.tasks.resume();
		return this.#host.tasks.abortConversation(this.id, options?.background === true, context);
	}

	waitForIdle(context: Context): Promise<void> {
		this.#host.tasks.resume();
		return this.#host.tasks.waitForIdle(this.id, context);
	}

	viewState(context: Context): Promise<AttachedReplicatedState<ConversationView>> {
		return this.#host.views.state(this.id, context);
	}

	watch(context: Context): Promise<ConversationWatch> {
		return this.#host.views.watch(this.id, context);
	}
}

/** Session kernel extended with conversation handles and a registry. */
class HarnessImpl<Tool extends ToolRegistration> extends SessionImpl implements HarnessType {
	readonly #storage: Storage;
	readonly #options: HarnessOptions<Tool>;
	readonly #report: (error: unknown) => void;
	readonly #host: ConversationHost<Tool>;
	readonly #tasks: TaskScheduler;
	readonly #submissions: Submissions;
	readonly #taskGraph: TaskGraphView;
	#closed = false;

	constructor(storage: Storage, options: HarnessOptions<Tool>, context: Context) {
		super(storage);
		this.#storage = storage;
		this.#options = options;
		this.#report = options.onReport ?? (() => {});
		const now = options.now ?? Date.now;
		const settings = () => resolveSettings(options.settings);
		this.#tasks = new TaskScheduler({
			session: this,
			storage,
			registry: options.registry,
			models: options.models,
			agent: (id, snapshot, callContext) => this.resolveAgent(id, snapshot as RegistrySnapshot<Tool>, callContext),
			settings,
			env: (id, callContext) => this.buildEnv(id, callContext),
			now,
			report: this.#report,
			settleOutcome: settleSchedulerOutcome,
			withdrawInputs: withdrawQueuedInputs,
			conversation: async (id, binding, callContext) => {
				const record = await this.readOnLine(() => storage.conversation(id, callContext));
				return record === undefined ? undefined : boundConversation(id, binding, this.#submissions, this.#tasks);
			},
			context: withoutAbortSignal(context),
		});
		this.#submissions = new Submissions(this, storage, now, settings, () => this.#tasks.resume());
		this.#taskGraph = new TaskGraphView(this, storage);
		this.#host = {
			harness: this,
			storage,
			tasks: this.#tasks,
			submissions: this.#submissions,
			views: new ConversationViews(this, storage),
			now,
			create: (target, createOptions, context) => this.#create(target, createOptions, context),
		};
	}

	/** Resolve a conversation's committed `pi.agent` against `snapshot`, or the current one, and the current settings. */
	async resolveAgent(
		id: ConversationId,
		snapshot: RegistrySnapshot<Tool> | undefined,
		context: Context,
	): Promise<Agent<Tool>> {
		const registry = snapshot ?? this.#options.registry.snapshot();
		const state = await this.snapshot(AgentDoc, id, context);
		return resolveAgent(state, registry, resolveSettings(this.#options.settings), this.#report);
	}

	/** Build a conversation's environment from its current `cwd`; `undefined` without an `env` option. */
	async buildEnv(id: ConversationId, context: Context): Promise<ExecutionEnv | undefined> {
		const build = this.#options.env;
		if (build === undefined) return undefined;
		const cwd = (await this.snapshot(AgentDoc, id, context))?.cwd;
		return build({ conversationId: id, ...(cwd === undefined ? {} : { cwd }), read: this }, context);
	}

	/** Reconcile surviving `running` tasks to `pending`; part of open. */
	openTasks(context: Context): Promise<void> {
		return this.#tasks.open(context);
	}

	resume(): void {
		this.#assertOpen();
		this.#tasks.resume();
	}

	getTask<R>(id: TaskId<R>, context: Context): Promise<TaskRecord<JsonValue, JsonValue, R> | undefined> {
		return this.readOnLine(() => this.#storage.task(id, context)) as Promise<
			TaskRecord<JsonValue, JsonValue, R> | undefined
		>;
	}

	inspect(context: Context): Promise<HarnessInspection> {
		return this.readOnLine(async () => {
			const { scheduling, tasks } = await this.#tasks.inspect(this.#options.registry.snapshot());
			const scan = (status: "queued" | "placed") =>
				scanAll((cursor) => this.#storage.scanSubmissions({ status }, SCAN_PAGE_SIZE, cursor, context));
			const submissions = [...(await scan("queued")), ...(await scan("placed"))].sort((a, b) => a.id - b.id);
			return { scheduling, tasks, submissions };
		});
	}

	submission(id: SubmissionId, context: Context): Promise<Submission | undefined> {
		return this.#submissions.get(id, context);
	}

	abortSubmission(
		id: SubmissionId,
		context: Context,
		conversationId?: ConversationId,
	): Promise<"aborted" | "already_placed" | "settled" | "not_found"> {
		return this.#submissions.abort(id, context, conversationId);
	}

	abortTask(id: TaskId, context: Context): Promise<"marked" | "terminal"> {
		return this.#tasks.abort(id, context);
	}

	waitForTask<R>(id: TaskId<R>, context: Context): Promise<SettledTask<R>> {
		this.#tasks.resume();
		return this.#tasks.waitForTask(id, context) as Promise<SettledTask<R>>;
	}

	waitForIdle(context: Context): Promise<void> {
		this.#tasks.resume();
		return this.#tasks.waitForIdle(undefined, context);
	}

	/** Sum every conversation's committed `pi.usage`. Each document is read at its own point; totals only grow. */
	async usage(context: Context): Promise<UsageState> {
		const conversations = await this.readOnLine(() =>
			scanAll((cursor) => this.#storage.scanConversations({}, SCAN_PAGE_SIZE, cursor, context)),
		);
		const total = UsageDoc.definition.initial();
		for (const { id } of conversations) {
			const state = await this.snapshot(UsageDoc, id, context);
			if (state !== undefined) addUsageState(total, state);
		}
		return total;
	}

	taskGraph(context: Context): Promise<AttachedReplicatedState<TaskGraph>> {
		return this.#taskGraph.state(context);
	}

	watchTaskGraph(context: Context): Promise<TaskGraphWatch> {
		return this.#taskGraph.watch(context);
	}

	root(
		context: Context,
		options?: { readonly agent?: AgentChange; readonly init?: ConversationInit },
	): Promise<Conversation> {
		return this.#create({ kind: "root" }, options ?? {}, context);
	}

	async conversation(id: ConversationId, context: Context): Promise<Conversation | undefined> {
		this.#assertOpen();
		const record = await this.readOnLine(() => this.#storage.conversation(id, context));
		return record === undefined ? undefined : new ConversationImpl(record.id, this.#host);
	}

	createConversation(options: ConversationCreateOptions, context: Context): Promise<Conversation> {
		return this.#create({ kind: "independent", ownership: options.ownership }, options, context);
	}

	override close(context: Context): Promise<void> {
		this.#closed = true;
		return super.close(context);
	}

	/** Join task invocations after admission is sealed and before Storage closes; writes no task outcome. */
	protected override beforeClose(): Promise<void> {
		return this.#tasks.join();
	}

	async #create(target: CreateTarget, options: CreateOptions, context: Context): Promise<Conversation> {
		this.#assertOpen();
		const id = await this.commitWith(async (tx) => {
			if (target.kind === "root" && (await tx.conversation(ROOT_CONVERSATION_ID)) !== undefined) {
				return ROOT_CONVERSATION_ID;
			}
			const record =
				target.kind === "root"
					? await tx.createRootConversation()
					: target.kind === "fork"
						? await tx.forkConversation(target.parentId, target.at, { ownership: target.ownership })
						: await tx.createConversation({ ownership: target.ownership });
			if (options.agent !== undefined) await configure(tx, record.id, options.agent);
			if (options.init !== undefined) await options.init(tx, record.id);
			return record.id;
		}, context);
		return new ConversationImpl(id, this.#host);
	}

	/**
	 * The built-in creation hook, in every commit that creates or forks a conversation: empty `pi.live`, `pi.inbox`, and
	 * `pi.usage`, the conversation's `pi.agent` (see `createAgent()`), then `HarnessOptions.conversationCreated`.
	 */
	protected override async conversationCreated(tx: Transaction, record: ConversationRecord): Promise<void> {
		await tx.doc(LiveDoc, record.id);
		await tx.doc(InboxDoc, record.id);
		await tx.doc(UsageDoc, record.id);
		await createAgent(tx, record);
		await this.#options.conversationCreated?.(tx, record);
	}

	#assertOpen(): void {
		if (this.#closed) throw new Error("Harness is closed");
	}
}

/**
 * Invocation-bound handle for tasks and tools. Every operation, and every operation of a submission it returns, first
 * checks the invocation and runs under its signal, so it rejects once the invocation ends; admitted work stays durable.
 */
function boundConversation(
	id: ConversationId,
	binding: InvocationBinding,
	submissions: Submissions,
	tasks: TaskScheduler,
): ConversationHandle {
	const bind = (context: Context): Context => withAbortSignal(binding.signal, context);
	const bound = <T>(operation: (context: Context) => Promise<T>) => {
		return async (context: Context): Promise<T> => {
			binding.check();
			return operation(bind(context));
		};
	};
	return {
		id,
		submit: async (draft, context) => {
			binding.check();
			const submission = await submissions.submit(id, draft, bind(context));
			return {
				id: submission.id,
				status: bound((callContext) => submission.status(callContext)),
				wait: bound((callContext) => submission.wait(callContext)),
				abort: bound((callContext) => submission.abort(callContext)),
			};
		},
		abort: async (context, options) => {
			binding.check();
			return tasks.abortConversation(id, options?.background === true, bind(context));
		},
		waitForIdle: bound((callContext) => tasks.waitForIdle(id, callContext)),
	};
}

/** Durable agent harness over one Session. */
export type Harness = HarnessType;

export const Harness = {
	/** Open a Harness over storage. The registry may keep changing while the Harness runs. */
	async open<Tool extends ToolRegistration>(
		storage: Storage,
		options: HarnessOptions<Tool>,
		context: Context,
	): Promise<Harness> {
		context.abortSignal?.throwIfAborted();
		const snapshot = options.registry.snapshot();
		const missing = BUILTIN_TASKS.filter((task) => snapshot.task(task.definition.name) === undefined);
		if (missing.length > 0) {
			const names = missing.map((task) => task.definition.name).join(", ");
			throw new Error(`Registry lacks built-in tasks ${names}; create it with createRegistry()`);
		}
		const harness = new HarnessImpl(storage, options, context);
		try {
			await harness.openTasks(context);
		} catch (error) {
			// The caller's context may be what failed open: close without it, and rethrow the open error.
			await harness
				.close(withoutAbortSignal(context))
				.catch((closeError: unknown) => options.onReport?.(closeError));
			throw error;
		}
		return harness;
	},
};

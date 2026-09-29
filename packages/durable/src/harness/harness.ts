import type { AttachedReplicatedState, Context, Draft, JsonValue } from "@earendil-works/chord";
import { withoutAbortSignal } from "@earendil-works/chord/context";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import { ResetEntry } from "../entries.ts";
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
	WatchHandle,
} from "../types.ts";
import { ROOT_CONVERSATION_ID } from "../types.ts";
import { ConversationConfig, type ConversationConfigState, DEFAULT_RETRY_POLICY } from "./config.ts";
import { readContext } from "./context.ts";
import { settleSchedulerOutcome } from "./live.ts";
import { BUILTIN_SETUP_KEY, BUILTIN_TASKS } from "./registry.ts";
import { TaskScheduler } from "./scheduler.ts";
import { Submissions } from "./submissions.ts";
import type {
	ContextView,
	Conversation,
	ConversationCreateOptions,
	ConversationInit,
	ConversationRetryPolicy,
	ConversationStreamOptions,
	HarnessInspection,
	HarnessOptions,
	Harness as HarnessType,
	ModelRef,
	QueueMode,
	RegistryReader,
	RegistrySnapshot,
	SettledTask,
	Submission,
	SubmissionDraft,
	ToolExecutionMode,
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

/** Harness-private services used by Conversation handles. */
type ConversationHost<Tool extends ToolRegistration> = {
	readonly harness: HarnessImpl<Tool>;
	readonly storage: Storage;
	readonly registry: RegistryReader<Tool>;
	readonly tasks: TaskScheduler;
	readonly submissions: Submissions;
	readonly views: ConversationViews;
	readonly now: () => number;
	create(target: CreateTarget, init: ConversationInit | undefined, context: Context): Promise<Conversation>;
};

class ConversationImpl<Tool extends ToolRegistration> implements Conversation {
	readonly id: ConversationId;
	readonly #host: ConversationHost<Tool>;

	constructor(id: ConversationId, host: ConversationHost<Tool>) {
		this.id = id;
		this.#host = host;
	}

	async getModel(context: Context): Promise<ModelRef | undefined> {
		return (await this.#config(context)).model;
	}

	setModel(model: ModelRef | undefined, context: Context): Promise<void> {
		return this.#editConfig((config) => {
			if (model === undefined) delete config.model;
			else config.model = { provider: model.provider, modelId: model.modelId };
		}, context);
	}

	async getThinkingLevel(context: Context): Promise<ModelThinkingLevel> {
		return (await this.#config(context)).thinkingLevel;
	}

	setThinkingLevel(level: ModelThinkingLevel, context: Context): Promise<void> {
		return this.#editConfig((config) => {
			config.thinkingLevel = level;
		}, context);
	}

	async getActiveTools(context: Context): Promise<readonly string[]> {
		return (await this.#config(context)).activeTools;
	}

	setActiveTools(names: readonly string[], context: Context): Promise<void> {
		return this.#editConfig((config) => {
			if (new Set(names).size !== names.length) throw new Error("Active tools list a name more than once");
			requireRegistered(this.#host.registry.snapshot(), names, config.activeTools);
			config.activeTools = [...names];
		}, context);
	}

	async getStreamOptions(context: Context): Promise<ConversationStreamOptions> {
		return (await this.#config(context)).streamOptions ?? {};
	}

	setStreamOptions(options: ConversationStreamOptions, context: Context): Promise<void> {
		return this.#editConfig((config) => {
			config.streamOptions = options;
		}, context);
	}

	async getRetryPolicy(context: Context): Promise<ConversationRetryPolicy> {
		return (await this.#config(context)).retry ?? { ...DEFAULT_RETRY_POLICY };
	}

	setRetryPolicy(policy: ConversationRetryPolicy | undefined, context: Context): Promise<void> {
		return this.#editConfig((config) => {
			if (policy === undefined) delete config.retry;
			else config.retry = policy;
		}, context);
	}

	async getToolExecution(context: Context): Promise<ToolExecutionMode> {
		return (await this.#config(context)).toolExecution ?? "parallel";
	}

	setToolExecution(mode: ToolExecutionMode | undefined, context: Context): Promise<void> {
		return this.#editConfig((config) => {
			if (mode === undefined) delete config.toolExecution;
			else config.toolExecution = mode;
		}, context);
	}

	async getSteeringMode(context: Context): Promise<QueueMode> {
		return (await this.#config(context)).steeringMode ?? "one-at-a-time";
	}

	setSteeringMode(mode: QueueMode | undefined, context: Context): Promise<void> {
		return this.#editConfig((config) => {
			if (mode === undefined) delete config.steeringMode;
			else config.steeringMode = mode;
		}, context);
	}

	async getFollowUpMode(context: Context): Promise<QueueMode> {
		return (await this.#config(context)).followUpMode ?? "one-at-a-time";
	}

	setFollowUpMode(mode: QueueMode | undefined, context: Context): Promise<void> {
		return this.#editConfig((config) => {
			if (mode === undefined) delete config.followUpMode;
			else config.followUpMode = mode;
		}, context);
	}

	submit(submission: SubmissionDraft, context: Context): Promise<Submission> {
		return this.#host.submissions.submit(this.id, submission, context);
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
		return this.#host.create(
			{ kind: "fork", parentId: this.id, at, ownership: options.ownership },
			options.init,
			context,
		);
	}

	waitForIdle(context: Context): Promise<void> {
		this.#host.tasks.resume();
		return this.#host.tasks.waitForIdle(this.id, context);
	}

	viewState(context: Context): Promise<AttachedReplicatedState<ConversationView>> {
		return this.#host.views.state(this.id, context);
	}

	watch(context: Context): Promise<WatchHandle<ConversationView>> {
		return this.#host.views.watch(this.id, context);
	}

	async #config(context: Context): Promise<Readonly<ConversationConfigState>> {
		return (
			(await this.#host.harness.snapshot(ConversationConfig, this.id, context)) ??
			ConversationConfig.definition.initial()
		);
	}

	#editConfig(edit: (config: Draft<ConversationConfigState>) => void, context: Context): Promise<void> {
		return this.#host.harness.commitWith(async (tx) => {
			edit(await tx.doc(ConversationConfig, this.id));
		}, context);
	}
}

/** Session kernel extended with conversation handles and a registry. */
class HarnessImpl<Tool extends ToolRegistration> extends SessionImpl implements HarnessType {
	readonly #storage: Storage;
	readonly #registry: RegistryReader<Tool>;
	readonly #host: ConversationHost<Tool>;
	readonly #tasks: TaskScheduler;
	readonly #submissions: Submissions;
	readonly #snapshots = new WeakMap<Transaction, RegistrySnapshot<Tool>>();
	#closed = false;

	constructor(storage: Storage, options: HarnessOptions<Tool>, context: Context) {
		super(storage);
		this.#storage = storage;
		this.#registry = options.registry;
		const now = options.now ?? Date.now;
		this.#tasks = new TaskScheduler({
			session: this,
			storage,
			registry: options.registry,
			models: options.models,
			env: options.env,
			now,
			report: options.onReport ?? (() => {}),
			settleOutcome: settleSchedulerOutcome,
			context: withoutAbortSignal(context),
		});
		this.#submissions = new Submissions(this, storage, now, () => this.#tasks.resume());
		this.#host = {
			harness: this,
			storage,
			registry: options.registry,
			tasks: this.#tasks,
			submissions: this.#submissions,
			views: new ConversationViews(this, storage),
			now,
			create: (target, init, context) => this.#create(target, init, context),
		};
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
			const snapshot = this.#registry.snapshot();
			const { scheduling, tasks } = this.#tasks.inspect(snapshot);
			const scan = (status: "queued" | "placed") =>
				scanAll((cursor) => this.#storage.scanSubmissions({ status }, SCAN_PAGE_SIZE, cursor, context));
			const submissions = [...(await scan("queued")), ...(await scan("placed"))].sort((a, b) => a.id - b.id);
			return { scheduling, tasks, submissions, registry: snapshot.failures() };
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

	root(context: Context, options?: { readonly init?: ConversationInit }): Promise<Conversation> {
		return this.#create({ kind: "root" }, options?.init, context);
	}

	async conversation(id: ConversationId, context: Context): Promise<Conversation | undefined> {
		this.#assertOpen();
		const record = await this.readOnLine(() => this.#storage.conversation(id, context));
		return record === undefined ? undefined : new ConversationImpl(record.id, this.#host);
	}

	createConversation(options: ConversationCreateOptions, context: Context): Promise<Conversation> {
		return this.#create({ kind: "independent", ownership: options.ownership }, options.init, context);
	}

	override close(context: Context): Promise<void> {
		this.#closed = true;
		return super.close(context);
	}

	/** Join task invocations after admission is sealed and before Storage closes; writes no task outcome. */
	protected override beforeClose(): Promise<void> {
		return this.#tasks.join();
	}

	async #create(target: CreateTarget, init: ConversationInit | undefined, context: Context): Promise<Conversation> {
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
			if (init !== undefined) await this.#runInit(tx, record.id, init);
			return record.id;
		}, context);
		return new ConversationImpl(id, this.#host);
	}

	/** Run every registered conversation setup, built-ins first, in each commit that creates or forks a conversation. */
	protected override async conversationCreated(tx: Transaction, record: ConversationRecord): Promise<void> {
		const snapshot = this.#snapshotOf(tx);
		for (const { setup } of snapshot.conversationSetups()) await setup(tx, record, snapshot);
	}

	/** Run `init` in the creating commit; its writes are trusted, but names it newly activates must be registered. */
	async #runInit(tx: Transaction, id: ConversationId, init: ConversationInit): Promise<void> {
		const snapshot = this.#snapshotOf(tx);
		const baseline = [...(await tx.doc(ConversationConfig, id)).activeTools];
		await init(tx, id);
		requireRegistered(snapshot, (await tx.doc(ConversationConfig, id)).activeTools, baseline);
	}

	/** One registry snapshot per commit, shared by its conversation setups and `init` checks. */
	#snapshotOf(tx: Transaction): RegistrySnapshot<Tool> {
		let snapshot = this.#snapshots.get(tx);
		if (snapshot === undefined) {
			snapshot = this.#registry.snapshot();
			this.#snapshots.set(tx, snapshot);
		}
		return snapshot;
	}

	#assertOpen(): void {
		if (this.#closed) throw new Error("Harness is closed");
	}
}

/** Reject names newly added relative to `previous` that `snapshot` does not register; existing names are never rechecked. */
function requireRegistered<Tool extends ToolRegistration>(
	snapshot: RegistrySnapshot<Tool>,
	names: readonly string[],
	previous: readonly string[],
): void {
	const existing = new Set(previous);
	const registered = new Set(snapshot.toolNames());
	const missing = names.filter((name) => !existing.has(name) && !registered.has(name));
	if (missing.length > 0) throw new Error(`Tools are not registered: ${missing.join(", ")}`);
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
		const missing = BUILTIN_TASKS.filter((task) => snapshot.task(task.definition.name) === undefined).map(
			(task) => `task ${task.definition.name}`,
		);
		if (!snapshot.conversationSetups().some(({ key }) => key === BUILTIN_SETUP_KEY))
			missing.push("conversation setup pi");
		if (missing.length > 0) {
			throw new Error(`Registry lacks built-in ${missing.join(", ")}; create it with createRegistry()`);
		}
		const harness = new HarnessImpl(storage, options, context);
		try {
			await harness.openTasks(context);
		} catch (error) {
			await harness.close(context);
			throw error;
		}
		return harness;
	},
};

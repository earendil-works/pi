import {
	type Api,
	type ImageContent,
	type Model,
	type Models,
	reduceAssistantMessageFrames,
	type Usage,
} from "@earendil-works/pi-ai";
import type { AgentMessage, ThinkingLevel } from "../../types.ts";
import type {
	AbortRequestResult,
	AbortResult,
	AgentLane,
	CancelQueuedResult,
	CompactionResult,
	DriveOptions,
	DriveResult,
	HarnessEvent,
	LaneConfigEventPayload,
	LaneExecutionInfo,
	LaneSnapshot,
	ModelIdentity,
	NavigationResult,
	OperationAdmission,
	OperationAdmissionResult,
	OperationRequest,
	QueueResult,
	RecordUsageResult,
	ResumeResult,
	RunResult,
	SuspendedRun,
	WatchHandle,
} from "../agent-harness.ts";
import { type BranchPreparation, prepareBranchEntries } from "../compaction/branch-summarization.ts";
import { prepareCompaction } from "../compaction/compaction.ts";
import { awaitWithContext, type Context } from "../context.ts";
import { toolResultFromMessage } from "../execution/tools.ts";
import type { HookRegistry } from "../hooks.ts";
import { formatPromptTemplateInvocation } from "../prompt-templates.ts";
import {
	Closed,
	HarnessClosed,
	HarnessFault,
	InvalidMessage,
	InvalidNavigation,
	LaneBusy,
	NoActiveOperation,
	NothingToCompact,
	NothingToResume,
	OperationMismatch,
	Result,
	UnknownSkill,
	UnknownTarget,
	UnknownTemplate,
} from "../result.ts";
import { insertEntry, insertUsage } from "../session/commit.ts";
import { SessionInvariantError, SessionPendingAssistantMessageError } from "../session/session.ts";
import type {
	BranchScan,
	Entry,
	InboxItem,
	InboxItemKind,
	JsonValue,
	NavigationReadyToCommitOperation,
	NewEntry,
	Operation,
	OperationMeta,
	OperationResultRecord,
	OperationState,
	PendingEntry,
	RunSettings,
	Session,
	SessionReader,
	StartingOperation,
	SummaryDecidingOperation,
	Write,
} from "../session/types.ts";
import {
	branchTip,
	deleteValue,
	laneConfig,
	laneState as laneStateValue,
	operationMeta as operationMetaValue,
	operationPreparation,
	operationResult as operationResultValue,
	operationState as operationStateValue,
	operationToolArgs,
	pendingEntry,
	pendingToolOutput,
	setValue,
} from "../session/values.ts";
import { formatSkillInvocation } from "../skills.ts";
import { durableBranchPreparation, durableCompactionPreparation } from "./drive/structural.ts";
import { driveOperation } from "./drive.ts";
import { readAssistantFrames } from "./progress.ts";
import { chainEntries, committedEntryEvents, readLaneQueues } from "./transcript.ts";
import {
	type Config,
	type ContinueOperationResult,
	Drive,
	type LaneCommand,
	type LaneState,
	type OperationCommand,
} from "./types.ts";

type EmitBatch = (events: readonly HarnessEvent[], context: Context) => Promise<void>;
type WatchHandler = <T>(
	snapshot: T,
	filter: (event: HarnessEvent) => boolean,
	context: Context,
	resnapshot: (context: Context, markBoundary: () => void) => Promise<T>,
) => WatchHandle<T>;
type FaultHandler = (cause: unknown, context: Context) => Error;

type LaneCommandOutcome<TResult> =
	| { kind: "return"; result: TResult; delivery?: Promise<void> }
	| { kind: "reject"; error: Error }
	| { kind: "idle_blocked"; owner: Promise<void>; change: Promise<void> };

type IdleObservation = { kind: "idle" } | { kind: "wait"; drive: Drive | undefined; change: Promise<void> };
type IdleClaimObservation = { kind: "claimed" } | { kind: "wait"; drive: Drive | undefined; change: Promise<void> };

type DriveClaim =
	| { kind: "observe"; drive: Drive; installed: boolean }
	| { kind: "occupied"; drive: Drive }
	| { kind: "settled"; outcome: OperationResultRecord }
	| { kind: "mismatch"; error: OperationMismatch };

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
	if (value === null || (typeof value !== "object" && typeof value !== "function")) return false;
	return "then" in value && typeof value.then === "function";
}

function inboxItems(inbox: readonly InboxItem[], kind: InboxItemKind): InboxItem[] {
	return inbox.filter((item) => item.kind === kind);
}

function withoutInboxItems(inbox: readonly InboxItem[], removed: readonly InboxItem[]): InboxItem[] {
	const removedIds = new Set(removed.map((item) => item.entryId));
	return inbox.filter((item) => !removedIds.has(item.entryId));
}

function selectAcceptedInbox(
	inbox: readonly InboxItem[],
	steeringMode: "all" | "one-at-a-time",
	followUpMode: "all" | "one-at-a-time",
): { selected: InboxItem[]; remainder: InboxItem[] } {
	let steerTaken = false;
	let followUpTaken = false;
	const selected: InboxItem[] = [];
	const remainder: InboxItem[] = [];
	for (const item of inbox) {
		const eligible =
			item.kind === "write" ||
			item.kind === "nextRun" ||
			(item.kind === "steer" && (steeringMode === "all" || !steerTaken)) ||
			(item.kind === "followUp" && (followUpMode === "all" || !followUpTaken));
		if (eligible) {
			selected.push(item);
			if (item.kind === "steer") steerTaken = true;
			if (item.kind === "followUp") followUpTaken = true;
		} else {
			remainder.push(item);
		}
	}
	return { selected, remainder };
}

function capturedSettings<TContext extends object | undefined>(config: Config<TContext>): RunSettings {
	return {
		compaction: config.compaction,
		steeringMode: config.steeringMode,
		followUpMode: config.followUpMode,
		toolExecution: config.toolExecution,
	};
}

function durableLaneState(
	state: LaneState,
	currentOperationId: string | null,
	inbox: InboxItem[] = state.inbox,
	lastOperationId: string | null = state.lastOperationId,
) {
	return { currentOperationId, lastOperationId, inbox };
}

function pendingEntryWrite(entryId: string, pending: PendingEntry): NewEntry {
	return pending.type === "message"
		? { id: entryId, parentId: null, type: "message", message: pending.payload }
		: {
				id: entryId,
				parentId: null,
				type: "custom",
				customType: pending.customType,
				...(pending.payload === undefined ? {} : { data: pending.payload }),
			};
}

function capturedModel(operation: Operation): ModelIdentity | undefined {
	const { state } = operation;
	switch (state.at) {
		case "assistant.ready":
		case "assistant.effect_pending":
		case "assistant.retry_wait":
			return state.generationContext.configuration.model;
		case "tools":
			return state.batch.configuration.model;
		case "deferred.suspended":
		case "deferred.effect_pending":
			return state.configuration.model;
		case "summary.ready":
		case "summary.effect_pending":
		case "summary.retry_wait":
			return state.summaryContext.configuration.model;
		default:
			return undefined;
	}
}

/** Runtime implementation of one configured lane. */
export class Lane<TContext extends object | undefined> implements AgentLane {
	readonly name: string;
	readonly session: Session;
	readonly models: Models;
	readonly hooks: HookRegistry;
	readonly emitBatch: EmitBatch;
	private readonly onFault: FaultHandler;
	private readonly installWatch: WatchHandler;
	private readonly config: () => Config<TContext>;
	private stateChange: Promise<void>;
	private resolveStateChange: () => void;
	private idleOwner: Promise<void> | undefined;
	/** Package-internal drive owner. Public only because deterministic procedure tests install exact owners directly. */
	activeDrive: Drive | undefined;
	/** Authoritative live control projection while this harness owns the Session. */
	state: LaneState;
	closedError: Error | undefined;

	constructor(
		name: string,
		session: Session,
		models: Models,
		hooks: HookRegistry,
		state: LaneState,
		onFault: FaultHandler,
		emitBatch: EmitBatch,
		installWatch: WatchHandler,
		readConfig: () => Config<TContext>,
	) {
		this.session = session;
		this.models = models;
		this.hooks = hooks;
		this.name = name;
		this.state = state;
		this.onFault = onFault;
		this.emitBatch = emitBatch;
		this.installWatch = installWatch;
		this.config = readConfig;
		let resolveStateChange!: () => void;
		this.stateChange = new Promise<void>((resolve) => {
			resolveStateChange = resolve;
		});
		this.resolveStateChange = resolveStateChange;
	}

	async getTipId(_context: Context): Promise<string | null> {
		this.assertOpen();
		return this.state.tipId;
	}

	async getResult(operationId: string, context: Context): Promise<OperationResultRecord | undefined> {
		this.assertOpen();
		return (await this.session.getValue(operationResultValue(operationId), context))?.value;
	}

	readConfig(): Config<TContext> {
		return this.config();
	}

	mismatch(expected: string, currentOperationId: string | null, lastOperationId: string | null): OperationMismatch {
		return new OperationMismatch({
			lane: this.name,
			expectedOperationId: expected,
			...(currentOperationId === null ? {} : { currentOperationId }),
			...(lastOperationId === null ? {} : { lastOperationId }),
			message: `Operation ${expected} does not own lane ${JSON.stringify(this.name)}`,
		});
	}

	/**
	 * Run one effect-free command on this lane's serialized mutation line. Owned `state` is authoritative; the
	 * planner receives that state plus a read-only reader for bounded payload lookups. Committed values and owned
	 * state are immutable snapshots: update them by replacement, never in place. State-independent input validation
	 * belongs before `command()`, while every state-dependent decision belongs inside its planner.
	 *
	 * A planner may choose exactly one outcome:
	 * - `commit` commits once, publishes `next`, then synchronously materializes the caller result from
	 *   storage-assigned `CommitResult` metadata;
	 * - `return` returns without a commit, boxed so a promise value is not awaited while holding the Session line;
	 * - `reject` rejects outside the mutation/fault boundary as an expected caller error without a commit.
	 *
	 * Planner, commit, and materialization errors fault the harness before releasing the Session line. Close/fault gates
	 * are checked both before queueing and when the callback starts: close-first rejects, while a callback admitted
	 * before close may finish its commit, publish memory, and resolve without another open check. Never invoke providers,
	 * tools, hooks, timers, event handlers, or wait for task completion here; perform those after `command()` returns.
	 */
	private async readLane<TResult>(
		read: (state: LaneState, reader: SessionReader) => TResult | Promise<TResult>,
		context: Context,
	): Promise<TResult> {
		this.assertOpen();
		try {
			return await this.session.mutate(async (reader) => {
				this.assertOpen();
				try {
					return await read(this.state, reader);
				} catch (error) {
					if (this.closedError !== undefined) throw this.closedError;
					throw this.onFault(error, context);
				}
			}, context);
		} catch (error) {
			if (this.closedError !== undefined) throw this.closedError;
			throw error;
		}
	}

	async command<TResult>(
		plan: (state: LaneState, reader: SessionReader) => LaneCommand<TResult> | Promise<LaneCommand<TResult>>,
		context: Context,
	): Promise<TResult> {
		this.assertOpen();
		while (this.idleOwner !== undefined) {
			await awaitWithContext(Promise.race([this.idleOwner, this.stateChange]), context);
			this.assertOpen();
		}
		let outcome: LaneCommandOutcome<TResult>;
		try {
			outcome = await this.session.mutate(async (mutator) => {
				this.assertOpen();
				if (this.idleOwner !== undefined) {
					return { kind: "idle_blocked", owner: this.idleOwner, change: this.stateChange };
				}
				try {
					const decision = await plan(this.state, mutator);
					switch (decision.kind) {
						case "return":
							return { kind: "return", result: decision.result };
						case "reject":
							return { kind: "reject", error: decision.error };
						case "commit": {
							const commit = await mutator.commit(decision.writes, context);
							this.state = decision.next;
							this.signalStateChange();
							const result = decision.materialize(commit);
							if (isPromiseLike(result)) {
								throw new TypeError("Lane command materialize() must be synchronous");
							}
							const events = decision.events?.(commit) ?? [];
							const delivery = events.length === 0 ? undefined : this.emitBatch(events, context);
							return { kind: "return", result, ...(delivery === undefined ? {} : { delivery }) };
						}
					}
				} catch (error) {
					if (this.closedError !== undefined) throw this.closedError;
					throw this.onFault(error, context);
				}
			}, context);
		} catch (error) {
			if (this.closedError !== undefined) throw this.closedError;
			throw error;
		}
		if (outcome.kind === "idle_blocked") {
			await awaitWithContext(Promise.race([outcome.owner, outcome.change]), context);
			this.assertOpen();
			return this.command(plan, context);
		}
		if (outcome.kind === "reject") throw outcome.error;
		await outcome.delivery;
		return outcome.result;
	}

	/**
	 * Run a command against the current operation even after cancellation is requested. Use this to settle admitted
	 * effects, finish the operation, or update concurrent child state. The capability narrows the planner's state type;
	 * the Drive continuation remains the sole top-level state writer.
	 */
	settleOperation<TState extends OperationState, TResult>(
		_capability: TState,
		plan: (
			state: LaneState,
			current: TState,
			meta: OperationMeta,
			reader: SessionReader,
		) => OperationCommand<TResult> | Promise<OperationCommand<TResult>>,
		context: Context,
	): Promise<TResult> {
		return this.command(async (state, reader) => {
			const operation = state.operation!;
			const decision = await plan(state, operation.state as TState, operation.meta, reader);
			if (decision.kind === "commit") {
				return {
					kind: "commit",
					writes: [
						...decision.writes,
						setValue(operationStateValue(operation.meta.operationId), decision.operationState),
						...(decision.lane?.inbox === undefined
							? []
							: [
									setValue(
										laneStateValue(this.name),
										durableLaneState(state, operation.meta.operationId, decision.lane.inbox),
									),
								]),
					],
					next: {
						...state,
						...decision.lane,
						operation: { meta: operation.meta, state: decision.operationState },
					},
					materialize: decision.materialize,
					...(decision.events === undefined ? {} : { events: decision.events }),
				};
			}
			if (decision.kind !== "finish") return decision;
			const inbox = decision.lane?.inbox ?? state.inbox;
			return {
				kind: "commit",
				writes: [
					...decision.writes,
					setValue(operationResultValue(operation.meta.operationId), decision.record),
					setValue(laneStateValue(this.name), durableLaneState(state, null, inbox, operation.meta.operationId)),
				],
				next: {
					...state,
					...decision.lane,
					inbox,
					lastOperationId: operation.meta.operationId,
					operation: null,
				},
				materialize: decision.materialize,
				...(decision.events === undefined ? {} : { events: decision.events }),
			};
		}, context);
	}

	/**
	 * Run an ordinary operation command only while durable control is running. Use this before starting new hooks,
	 * effects, or forward progress. Returns `cancel_requested` without invoking the planner once cancellation is requested.
	 */
	continueOperation<TState extends OperationState, TResult>(
		capability: TState,
		plan: (
			state: LaneState,
			current: TState,
			meta: OperationMeta,
			reader: SessionReader,
		) => OperationCommand<TResult> | Promise<OperationCommand<TResult>>,
		context: Context,
	): Promise<ContinueOperationResult<TResult>> {
		return this.settleOperation<TState, ContinueOperationResult<TResult>>(
			capability,
			async (state, latest, meta, reader) => {
				if (latest.control.status === "cancel_requested") {
					return { kind: "return", result: { kind: "cancel_requested" } };
				}
				const decision = await plan(state, latest, meta, reader);
				if (decision.kind === "return") {
					return { kind: "return", result: { kind: "result", value: decision.result } };
				}
				return {
					...decision,
					materialize: (commit) => ({ kind: "result", value: decision.materialize(commit) }),
				};
			},
			context,
		);
	}

	async accept(request: OperationRequest, context: Context): Promise<OperationAdmissionResult> {
		if (this.closedError instanceof HarnessClosed) {
			return Result.err(new Closed({ message: this.closedError.message }));
		}
		this.assertOpen();
		const startedAt = Date.now();
		const operationId = request.operationId ?? this.session.idGenerator.next(startedAt);
		const acceptanceConfig = this.readConfig();
		if (request.kind === "compaction") {
			return this.acceptCompaction(request, operationId, startedAt, acceptanceConfig, context);
		}
		if (request.kind === "navigation") {
			return this.acceptNavigation(request, operationId, startedAt, acceptanceConfig, context);
		}

		return this.acceptRun(request, operationId, startedAt, acceptanceConfig, context);
	}

	private async acceptRun(
		request: Extract<OperationRequest, { kind: "prompt" | "skill" | "prompt_template" }>,
		operationId: string,
		startedAt: number,
		acceptanceConfig: Config<TContext>,
		context: Context,
	): Promise<OperationAdmissionResult> {
		let messages: AgentMessage[];
		switch (request.kind) {
			case "prompt":
				if (typeof request.prompt !== "string") {
					messages = Array.isArray(request.prompt) ? request.prompt : [request.prompt];
				} else {
					const images = request.images ?? [];
					messages =
						request.prompt.length === 0 && images.length === 0
							? []
							: [
									{
										role: "user",
										content: [
											...(request.prompt.length === 0
												? []
												: [{ type: "text" as const, text: request.prompt }]),
											...images,
										],
										timestamp: startedAt,
									},
								];
				}
				break;
			case "skill": {
				const skill = acceptanceConfig.resources.skills?.find((candidate) => candidate.name === request.name);
				if (skill === undefined) {
					return Result.err(new UnknownSkill({ name: request.name, message: `Unknown skill: ${request.name}` }));
				}
				messages = [
					{
						role: "user",
						content: [{ type: "text", text: formatSkillInvocation(skill, request.additionalInstructions) }],
						timestamp: startedAt,
					},
				];
				break;
			}
			case "prompt_template": {
				const template = acceptanceConfig.resources.promptTemplates?.find(
					(candidate) => candidate.name === request.name,
				);
				if (template === undefined) {
					return Result.err(
						new UnknownTemplate({ name: request.name, message: `Unknown prompt template: ${request.name}` }),
					);
				}
				const content = formatPromptTemplateInvocation(template, request.args);
				messages =
					content.length === 0
						? []
						: [{ role: "user", content: [{ type: "text", text: content }], timestamp: startedAt }];
				break;
			}
		}

		for (const message of messages) {
			if (message.role === "assistant" && message.stopReason === "pending") {
				return Result.err(
					new InvalidMessage({
						lane: this.name,
						reason: "pending_assistant",
						message: "Cannot accept a pending assistant message",
					}),
				);
			}
		}
		const prompt = messages.map((message) => ({ id: this.session.idGenerator.next(startedAt), message }));

		return this.command<OperationAdmissionResult>(async (state, reader) => {
			if (state.operation !== null) {
				return {
					kind: "return",
					result: Result.err(
						new LaneBusy({
							lane: this.name,
							operationId: state.operation.meta.operationId,
							operationKind: state.operation.meta.intent.kind,
							message: `Lane ${JSON.stringify(this.name)} already has an active operation`,
						}),
					),
				};
			}
			const { selected: selectedItems, remainder: inbox } = selectAcceptedInbox(
				state.inbox,
				acceptanceConfig.steeringMode,
				acceptanceConfig.followUpMode,
			);
			const captured = await Promise.all(
				selectedItems.map(async (item) => {
					const stored = await reader.getValue(pendingEntry(item.entryId), context);
					if (stored === undefined) {
						throw new SessionInvariantError(`Pending ${item.kind} entry ${item.entryId} is missing its payload`);
					}
					if (item.kind !== "write" && stored.value.type !== "message") {
						throw new SessionInvariantError(`Pending ${item.kind} entry ${item.entryId} is not a message`);
					}
					if (
						stored.value.type === "message" &&
						stored.value.payload.role === "assistant" &&
						stored.value.payload.stopReason === "pending"
					) {
						throw new SessionInvariantError(
							`Pending ${item.kind} entry ${item.entryId} contains a pending assistant`,
						);
					}
					return { item, pending: stored.value };
				}),
			);
			const hasCapturedConversation = selectedItems.some((item) => item.kind !== "write");
			if (prompt.length === 0 && !hasCapturedConversation) {
				return {
					kind: "return",
					result: Result.err(
						new InvalidMessage({
							lane: this.name,
							reason: "empty",
							message: "Acceptance must append at least one message",
						}),
					),
				};
			}

			const entries = chainEntries(state.tipId, [
				...captured.map(({ item, pending }) => pendingEntryWrite(item.entryId, pending)),
				...prompt.map(({ id, message }) => ({ id, parentId: null, type: "message" as const, message })),
			]);
			const parentId = entries[entries.length - 1]!.id;
			const meta = {
				operationId,
				lane: this.name,
				sourceTipId: state.tipId,
				startedAt,
				intent: { kind: "run" as const, promptEntryIds: prompt.map(({ id }) => id) },
			};
			const operationState: StartingOperation = {
				at: "starting",
				control: { status: "running" },
				settings: capturedSettings(acceptanceConfig),
				latestAssistantEntryId: null,
			};
			const remainingQueues = await readLaneQueues(reader, inbox, context);
			const next: LaneState = {
				...state,
				tipId: parentId,
				inbox,
				operation: { meta, state: operationState },
			};
			return {
				kind: "commit",
				writes: [
					...entries.map((entry) => insertEntry(entry)),
					...selectedItems.map((item) => deleteValue(pendingEntry(item.entryId))),
					setValue(branchTip(this.name), parentId),
					setValue(operationMetaValue(operationId), meta),
					setValue(operationStateValue(operationId), operationState),
					setValue(laneStateValue(this.name), durableLaneState(state, operationId, inbox)),
				],
				next,
				materialize: () => Result.ok({ operationId, kind: "run", startedAt }),
				events: (commit) => {
					const events: HarnessEvent[] = [
						{ type: "run_start", runId: operationId, startedAt, lane: this.name },
						...committedEntryEvents(entries, commit, this.name, operationId),
					];
					if (selectedItems.length > 0) {
						events.push({ type: "queue_update", queues: remainingQueues, lane: this.name });
					}
					return events;
				},
			};
		}, context);
	}

	private acceptCompaction(
		request: Extract<OperationRequest, { kind: "compaction" }>,
		operationId: string,
		startedAt: number,
		acceptanceConfig: Config<TContext>,
		context: Context,
	): Promise<OperationAdmissionResult> {
		const taskId = this.session.idGenerator.next(startedAt);
		return this.command<OperationAdmissionResult>(async (state, reader) => {
			if (state.operation !== null) {
				return {
					kind: "return",
					result: Result.err(
						new LaneBusy({
							lane: this.name,
							operationId: state.operation.meta.operationId,
							operationKind: state.operation.meta.intent.kind,
							message: `Lane ${JSON.stringify(this.name)} already has an active operation`,
						}),
					),
				};
			}
			const path =
				state.tipId === null
					? []
					: (
							await reader.scanBranch(
								{ start: state.tipId, stopAtType: "compaction", order: "newestFirst" },
								context,
							)
						).reverse();
			const prepared = prepareCompaction(path, acceptanceConfig.compaction);
			if (!prepared.ok) throw prepared.error;
			if (prepared.value === undefined) {
				return {
					kind: "return",
					result: Result.err(
						new NothingToCompact({
							lane: this.name,
							message: `Lane ${JSON.stringify(this.name)} has nothing to compact`,
						}),
					),
				};
			}
			const meta: OperationMeta = {
				operationId,
				lane: this.name,
				sourceTipId: state.tipId,
				startedAt,
				intent: {
					kind: "compaction",
					...(request.customInstructions === undefined ? {} : { customInstructions: request.customInstructions }),
				},
			};
			const operationState: SummaryDecidingOperation = {
				at: "summary.deciding",
				control: { status: "running" },
				settings: capturedSettings(acceptanceConfig),
				latestAssistantEntryId: null,
				task: {
					taskId,
					reason: "manual",
					...(request.customInstructions === undefined ? {} : { customInstructions: request.customInstructions }),
					boundary: { kind: "finish" },
				},
			};
			return {
				kind: "commit",
				writes: [
					setValue(operationPreparation(operationId, taskId), durableCompactionPreparation(prepared.value)),
					setValue(operationMetaValue(operationId), meta),
					setValue(operationStateValue(operationId), operationState),
					setValue(laneStateValue(this.name), durableLaneState(state, operationId)),
				],
				next: { ...state, operation: { meta, state: operationState } },
				materialize: () => Result.ok({ operationId, kind: "compaction", startedAt }),
				events: () => [
					{ type: "compaction_start", lane: this.name, runId: operationId, reason: "manual", startedAt },
				],
			};
		}, context);
	}

	private async acceptNavigation(
		request: Extract<OperationRequest, { kind: "navigation" }>,
		operationId: string,
		startedAt: number,
		acceptanceConfig: Config<TContext>,
		context: Context,
	): Promise<OperationAdmissionResult> {
		const taskId = this.session.idGenerator.next(startedAt);
		const targetId = request.targetId;
		const options = request.options ?? {};
		const summarize = options.summarize ?? false;
		for (;;) {
			const observedTipId = this.state.tipId;
			let preparation: BranchPreparation | undefined;
			if (summarize && observedTipId !== null && targetId !== null) {
				const target = await this.session.getEntries([targetId], context);
				if (target.has(targetId)) {
					const [oldPath, targetPath] = await Promise.all([
						this.session.scanBranch({ start: observedTipId, order: "newestFirst" }, context),
						this.session.scanBranch({ start: targetId, order: "newestFirst" }, context),
					]);
					const oldIds = new Set(oldPath.map((entry) => entry.id));
					const commonAncestorId = targetPath.find((entry) => oldIds.has(entry.id))?.id ?? null;
					preparation = prepareBranchEntries(
						oldPath
							.slice(
								0,
								commonAncestorId === null
									? oldPath.length
									: oldPath.findIndex((entry) => entry.id === commonAncestorId),
							)
							.reverse(),
					);
				}
			}
			const accepted = await this.command<OperationAdmissionResult | undefined>(async (state, reader) => {
				if (state.operation !== null) {
					return {
						kind: "return",
						result: Result.err(
							new LaneBusy({
								lane: this.name,
								operationId: state.operation.meta.operationId,
								operationKind: state.operation.meta.intent.kind,
								message: `Lane ${JSON.stringify(this.name)} already has an active operation`,
							}),
						),
					};
				}
				if (state.tipId !== observedTipId) return { kind: "return", result: undefined };
				if (targetId === state.tipId) {
					return {
						kind: "return",
						result: Result.err(
							new InvalidNavigation({
								lane: this.name,
								reason: "current_tip",
								message: "Navigation target must differ from the current tip",
							}),
						),
					};
				}
				if (targetId === null && options.label !== undefined) {
					return {
						kind: "return",
						result: Result.err(
							new InvalidNavigation({
								lane: this.name,
								reason: "root_label",
								message: "Root navigation cannot set a label",
							}),
						),
					};
				}
				if (summarize && (state.tipId === null || targetId === null)) {
					return {
						kind: "return",
						result: Result.err(
							new InvalidNavigation({
								lane: this.name,
								reason: state.tipId === null ? "source_root" : "target_root",
								message: "Summarized navigation requires non-root source and target entries",
							}),
						),
					};
				}
				if (targetId !== null && !(await reader.getEntries([targetId], context)).has(targetId)) {
					return {
						kind: "return",
						result: Result.err(new UnknownTarget({ targetId, message: `Unknown target: ${targetId}` })),
					};
				}

				const intent: OperationMeta["intent"] = {
					kind: "navigation",
					targetId,
					summarize,
					...(options.label === undefined ? {} : { label: options.label }),
					...(options.customInstructions === undefined ? {} : { customInstructions: options.customInstructions }),
				};
				const meta: OperationMeta = {
					operationId,
					lane: this.name,
					sourceTipId: state.tipId,
					startedAt,
					intent,
				};
				const operationScope = {
					control: { status: "running" as const },
					settings: capturedSettings(acceptanceConfig),
					latestAssistantEntryId: null,
				};
				let operationState: SummaryDecidingOperation | NavigationReadyToCommitOperation;
				const writes: Write[] = [];
				if (summarize) {
					if (state.tipId === null || targetId === null || preparation === undefined) {
						throw new SessionInvariantError("Validated summarized navigation is missing its preparation");
					}
					writes.push(setValue(operationPreparation(operationId, taskId), durableBranchPreparation(preparation)));
					operationState = {
						...operationScope,
						at: "summary.deciding",
						task: {
							taskId,
							...(options.customInstructions === undefined
								? {}
								: { customInstructions: options.customInstructions }),
							boundary: {
								kind: "commit_navigation",
								targetId,
								...(options.label === undefined ? {} : { label: options.label }),
							},
						},
					};
				} else {
					operationState = {
						...operationScope,
						at: "navigation.ready_to_commit",
						targetId,
						...(options.label === undefined ? {} : { label: options.label }),
					};
				}
				writes.push(
					setValue(operationMetaValue(operationId), meta),
					setValue(operationStateValue(operationId), operationState),
					setValue(laneStateValue(this.name), durableLaneState(state, operationId)),
				);
				return {
					kind: "commit",
					writes,
					next: { ...state, operation: { meta, state: operationState } },
					materialize: () => Result.ok({ operationId, kind: "navigation", startedAt }),
					events: () => [{ type: "navigation_start", lane: this.name, runId: operationId, targetId, startedAt }],
				};
			}, context);
			if (accepted !== undefined) return accepted;
		}
	}

	async drive(options: DriveOptions, context: Context): Promise<DriveResult> {
		if (this.closedError instanceof HarnessClosed) {
			return Result.err(new Closed({ message: this.closedError.message }));
		}
		this.assertOpen();

		for (;;) {
			const claim = await this.command<DriveClaim>(async (state, reader) => {
				const signal = context.abortSignal;
				if (signal?.aborted) {
					const reason: unknown = signal.reason;
					return {
						kind: "reject",
						error: reason instanceof Error ? reason : new DOMException("The operation was aborted", "AbortError"),
					};
				}
				if (state.operation?.meta.operationId === options.operationId) {
					if (this.activeDrive === undefined) {
						const drive = new Drive(options, context);
						this.activeDrive = drive;
						this.signalStateChange();
						return { kind: "return", result: { kind: "observe", drive, installed: true } };
					}
					return {
						kind: "return",
						result:
							this.activeDrive.operationId === options.operationId
								? { kind: "observe", drive: this.activeDrive, installed: false }
								: { kind: "occupied", drive: this.activeDrive },
					};
				}

				const stored = await reader.getValue(operationResultValue(options.operationId), context);
				return stored === undefined
					? {
							kind: "return",
							result: {
								kind: "mismatch",
								error: this.mismatch(
									options.operationId,
									state.operation?.meta.operationId ?? null,
									state.lastOperationId,
								),
							},
						}
					: { kind: "return", result: { kind: "settled", outcome: stored.value } };
			}, context);

			if (claim.kind === "settled") return Result.ok({ kind: "settled", outcome: claim.outcome });
			if (claim.kind === "mismatch") return Result.err(claim.error);
			if (claim.kind === "occupied") {
				await awaitWithContext(claim.drive.completion, context);
				continue;
			}
			if (claim.installed) {
				void driveOperation(this, claim.drive).then(
					(outcome) => {
						if (this.activeDrive === claim.drive) {
							this.activeDrive = undefined;
							this.signalStateChange();
						}
						claim.drive.settle(outcome);
					},
					(error: unknown) => {
						let failure: unknown = this.closedError;
						if (failure === undefined) {
							try {
								failure = this.onFault(error, claim.drive.context);
							} catch (faultError) {
								failure = faultError;
							}
						}
						if (this.activeDrive === claim.drive) {
							this.activeDrive = undefined;
							this.signalStateChange();
						}
						claim.drive.fail(failure);
					},
				);
			}
			return Result.ok(await awaitWithContext(claim.drive.completion, context));
		}
	}

	/** Package-private durable cancellation primitive. Public exposure remains guarded until M8. */
	async requestOperationAbort(operationId: string, context: Context): Promise<AbortRequestResult> {
		if (this.closedError instanceof HarnessClosed) {
			return Result.err(new Closed({ message: this.closedError.message }));
		}
		this.assertOpen();

		const drive = this.activeDrive?.operationId === operationId ? this.activeDrive : undefined;
		let resolveCancellation!: () => void;
		let rejectCancellation!: (error: unknown) => void;
		const cancellation = new Promise<void>((resolve, reject) => {
			resolveCancellation = resolve;
			rejectCancellation = reject;
		});
		void cancellation.catch(() => {});
		drive?.beginAbort(cancellation);
		let gateSettled = false;
		const settleGate = (signal: boolean): void => {
			if (gateSettled) return;
			gateSettled = true;
			resolveCancellation();
			if (signal) drive?.signalAbort();
		};

		try {
			const result = await this.command<AbortRequestResult>(async (state, reader) => {
				const operation = state.operation;
				if (operation?.meta.operationId !== operationId) {
					return {
						kind: "return",
						result: Result.err(
							this.mismatch(operationId, operation?.meta.operationId ?? null, state.lastOperationId),
						),
					};
				}
				if (operation.state.control.status === "cancel_requested") {
					return {
						kind: "return",
						result: Result.ok({ operationId, newlyRequested: false, steer: [], followUp: [] }),
					};
				}

				const removed = state.inbox.filter((item) => item.kind === "steer" || item.kind === "followUp");
				const payloads = await Promise.all(
					removed.map(async (item) => {
						const stored = await reader.getValue(pendingEntry(item.entryId), context);
						if (stored?.value.type !== "message") {
							throw new SessionInvariantError(
								`Pending ${item.kind} entry ${item.entryId} is missing its message`,
							);
						}
						return { item, message: stored.value.payload };
					}),
				);
				const steer = payloads.filter(({ item }) => item.kind === "steer").map(({ message }) => message);
				const followUp = payloads.filter(({ item }) => item.kind === "followUp").map(({ message }) => message);
				const removedIds = new Set(removed.map((item) => item.entryId));
				const inbox = state.inbox.filter((item) => !removedIds.has(item.entryId));
				const queues = await readLaneQueues(reader, inbox, context);
				const operationState: OperationState = {
					...operation.state,
					control: { status: "cancel_requested", requestedAt: Date.now() },
				};
				return {
					kind: "commit",
					writes: [
						...removed.map((item) => deleteValue(pendingEntry(item.entryId))),
						setValue(operationStateValue(operationId), operationState),
						setValue(laneStateValue(this.name), durableLaneState(state, operationId, inbox)),
					],
					next: { ...state, inbox, operation: { meta: operation.meta, state: operationState } },
					materialize: () => {
						settleGate(true);
						return Result.ok({ operationId, newlyRequested: true, steer, followUp });
					},
					events: () => [
						{
							type: "operation_abort",
							operationId,
							steer,
							followUp,
							lane: this.name,
						},
						...(removed.length === 0 ? [] : [{ type: "queue_update" as const, queues, lane: this.name }]),
					],
				};
			}, context);
			// A fresh Drive may observe an already-durable marker; pull its gate on the repeat path too. A mismatch
			// can leave only the stale Drive's admission gate in aborting state; its cancellation wait is still released.
			settleGate(result.ok && result.value.newlyRequested === false);
			return result;
		} catch (error) {
			if (!gateSettled) rejectCancellation(error);
			throw error;
		}
	}

	requestAbort(operationId: string, context: Context): Promise<AbortRequestResult> {
		return this.requestOperationAbort(operationId, context);
	}

	inspectExecution(context: Context): Promise<LaneExecutionInfo> {
		return this.readLane((state) => {
			const operation = state.operation;
			const captured = operation === null ? undefined : capturedModel(operation);
			const current =
				operation === null
					? null
					: {
							id: operation.meta.operationId,
							kind: operation.meta.intent.kind,
							status:
								operation.state.control.status === "cancel_requested"
									? ("aborting" as const)
									: ("open" as const),
							startedAt: operation.meta.startedAt,
							...(captured === undefined ? {} : { capturedModel: captured }),
						};
			return {
				lane: this.name,
				tipId: state.tipId,
				configuredModel: state.configuration.model,
				current,
				lastOperationId: state.lastOperationId,
			};
		}, context);
	}

	async prompt(
		...args:
			| [text: string, images: ImageContent[] | undefined, context: Context]
			| [message: AgentMessage | AgentMessage[], context: Context]
	): Promise<RunResult> {
		if (args.length === 3) {
			return this.driveRunRequest(
				{ kind: "prompt", prompt: args[0], ...(args[1] === undefined ? {} : { images: args[1] }) },
				args[2],
			);
		}
		return this.driveRunRequest({ kind: "prompt", prompt: args[0] }, args[1]);
	}

	skill(name: string, additionalInstructions: string | undefined, context: Context): Promise<RunResult> {
		return this.driveRunRequest(
			{ kind: "skill", name, ...(additionalInstructions === undefined ? {} : { additionalInstructions }) },
			context,
		);
	}

	promptFromTemplate(name: string, args: string[] | undefined, context: Context): Promise<RunResult> {
		return this.driveRunRequest({ kind: "prompt_template", name, ...(args === undefined ? {} : { args }) }, context);
	}

	private async driveRunRequest(
		request: Extract<OperationRequest, { kind: "prompt" | "skill" | "prompt_template" }>,
		context: Context,
	): Promise<RunResult> {
		const admission = await this.accept(request, context);
		if (!admission.ok) {
			switch (admission.error._tag) {
				case "LaneBusy":
				case "InvalidMessage":
				case "UnknownSkill":
				case "UnknownTemplate":
				case "Closed":
					return Result.err(admission.error);
				default:
					throw this.onFault(
						new SessionInvariantError(`Run acceptance returned ${admission.error._tag}`),
						context,
					);
			}
		}
		const driven = await this.drive({ operationId: admission.value.operationId, waitForRetry: true }, context);
		if (!driven.ok) {
			if (driven.error._tag === "Closed") return Result.err(driven.error);
			throw this.onFault(
				new SessionInvariantError(`Accepted run ${admission.value.operationId} no longer matches its lane`),
				context,
			);
		}
		if (driven.value.kind === "settled") return Result.ok(driven.value.outcome);
		if (driven.value.reason === "deferred") {
			return Result.ok({
				operationId: admission.value.operationId,
				status: "suspended",
				deferred: driven.value.deferred,
			});
		}
		throw this.onFault(
			new SessionInvariantError(`Run ${admission.value.operationId} returned an unwaited retry`),
			context,
		);
	}

	async compact(options: { customInstructions?: string } | undefined, context: Context): Promise<CompactionResult> {
		const admission = await this.accept(
			{
				kind: "compaction",
				...(options?.customInstructions === undefined ? {} : { customInstructions: options.customInstructions }),
			},
			context,
		);
		if (!admission.ok) {
			switch (admission.error._tag) {
				case "LaneBusy":
				case "NothingToCompact":
				case "Closed":
					return Result.err(admission.error);
				default:
					throw this.onFault(
						new SessionInvariantError(`Compaction acceptance returned ${admission.error._tag}`),
						context,
					);
			}
		}
		const compacted = await this.driveStructuralAdmission(admission.value, context);
		if (!compacted.ok) return compacted;
		const continuation = await this.continueAfterStructural(compacted.value, context);
		return continuation.ok
			? Result.ok({
					compaction: compacted.value,
					...(continuation.value === undefined ? {} : { run: continuation.value }),
				})
			: continuation;
	}

	async navigateTree(
		targetId: string | null,
		options: Extract<OperationRequest, { kind: "navigation" }>["options"],
		context: Context,
	): Promise<NavigationResult> {
		const admission = await this.accept(
			{ kind: "navigation", targetId, ...(options === undefined ? {} : { options }) },
			context,
		);
		if (!admission.ok) {
			switch (admission.error._tag) {
				case "LaneBusy":
				case "InvalidNavigation":
				case "UnknownTarget":
				case "Closed":
					return Result.err(admission.error);
				default:
					throw this.onFault(
						new SessionInvariantError(`Navigation acceptance returned ${admission.error._tag}`),
						context,
					);
			}
		}
		const navigated = await this.driveStructuralAdmission(admission.value, context);
		if (!navigated.ok) return navigated;
		const continuation = await this.continueAfterStructural(navigated.value, context);
		return continuation.ok
			? Result.ok({
					navigation: navigated.value,
					...(continuation.value === undefined ? {} : { run: continuation.value }),
				})
			: continuation;
	}

	private async driveStructuralAdmission(
		admission: OperationAdmission,
		context: Context,
	): Promise<Result<OperationResultRecord, Closed>> {
		const driven = await this.drive({ operationId: admission.operationId, waitForRetry: true }, context);
		if (!driven.ok) {
			if (driven.error._tag === "Closed") return Result.err(driven.error);
			throw this.onFault(
				new SessionInvariantError(`Accepted ${admission.kind} ${admission.operationId} no longer matches its lane`),
				context,
			);
		}
		if (driven.value.kind === "settled") return Result.ok(driven.value.outcome);
		throw this.onFault(
			new SessionInvariantError(`${admission.kind} ${admission.operationId} returned ${driven.value.reason}`),
			context,
		);
	}

	private async continueAfterStructural(
		record: OperationResultRecord,
		context: Context,
	): Promise<Result<OperationResultRecord | SuspendedRun | undefined, Closed>> {
		if (record.status === "aborted") return Result.ok(undefined);
		const admission = await this.accept({ kind: "prompt", prompt: "" }, context);
		if (!admission.ok) {
			switch (admission.error._tag) {
				case "InvalidMessage":
				case "LaneBusy":
					return Result.ok(undefined);
				case "Closed":
					return Result.err(admission.error);
				default:
					throw this.onFault(
						new SessionInvariantError(`Structural continuation acceptance returned ${admission.error._tag}`),
						context,
					);
			}
		}
		const driven = await this.drive({ operationId: admission.value.operationId, waitForRetry: true }, context);
		if (!driven.ok) {
			if (driven.error._tag === "Closed") return Result.err(driven.error);
			throw this.onFault(
				new SessionInvariantError(`Continuation run ${admission.value.operationId} no longer matches its lane`),
				context,
			);
		}
		if (driven.value.kind === "settled") return Result.ok(driven.value.outcome);
		if (driven.value.reason === "deferred") {
			return Result.ok({
				operationId: admission.value.operationId,
				status: "suspended",
				deferred: driven.value.deferred,
			});
		}
		throw this.onFault(
			new SessionInvariantError(`Continuation run ${admission.value.operationId} returned an unwaited retry`),
			context,
		);
	}

	async resume(context: Context): Promise<ResumeResult> {
		if (this.closedError instanceof HarnessClosed) {
			return Result.err(new Closed({ message: this.closedError.message }));
		}
		this.assertOpen();
		const inspected = await this.command<Result<{ operationId: string }, NothingToResume>>((state) => {
			const operation = state.operation;
			return operation === null
				? {
						kind: "return",
						result: Result.err(
							new NothingToResume({
								lane: this.name,
								message: `Lane ${JSON.stringify(this.name)} has no active operation to resume`,
							}),
						),
					}
				: { kind: "return", result: Result.ok({ operationId: operation.meta.operationId }) };
		}, context);
		if (!inspected.ok) return inspected;

		const driven = await this.drive(
			{ operationId: inspected.value.operationId, pollDeferred: true, waitForRetry: true },
			context,
		);
		if (!driven.ok) {
			if (driven.error._tag === "Closed") return Result.err(driven.error);
			throw this.onFault(
				new SessionInvariantError(`Operation ${inspected.value.operationId} no longer matches its lane`),
				context,
			);
		}
		if (driven.value.kind === "settled") return Result.ok(driven.value.outcome);
		if (driven.value.reason === "deferred") {
			return Result.ok({
				operationId: inspected.value.operationId,
				status: "suspended",
				deferred: driven.value.deferred,
			});
		}
		throw this.onFault(
			new SessionInvariantError(`Operation ${inspected.value.operationId} returned an unwaited retry`),
			context,
		);
	}

	async abort(context: Context): Promise<AbortResult> {
		if (this.closedError instanceof HarnessClosed) {
			return Result.err(new Closed({ message: this.closedError.message }));
		}
		this.assertOpen();
		const operationId = await this.command(
			(state) => ({
				kind: "return",
				result: state.operation?.meta.operationId,
			}),
			context,
		);
		if (operationId === undefined) {
			return Result.err(
				new NoActiveOperation({
					lane: this.name,
					message: `Lane ${JSON.stringify(this.name)} has no active operation`,
				}),
			);
		}
		const requested = await this.requestAbort(operationId, context);
		if (!requested.ok) {
			if (requested.error._tag === "Closed") return Result.err(requested.error);
			return Result.err(
				new NoActiveOperation({
					lane: this.name,
					message: `Lane ${JSON.stringify(this.name)} no longer has the inspected operation`,
				}),
			);
		}
		const driven = await this.drive({ operationId }, context);
		if (!driven.ok && driven.error._tag === "Closed") return Result.err(driven.error);
		if (!driven.ok) {
			throw this.onFault(
				new SessionInvariantError(`Cancelled operation ${operationId} no longer matches its lane`),
				context,
			);
		}
		return Result.ok({
			operationId,
			steer: requested.value.steer,
			followUp: requested.value.followUp,
		});
	}

	steer(message: string | AgentMessage, images: ImageContent[] | undefined, context: Context): Promise<QueueResult> {
		return this.enqueue("steer", message, images, context);
	}

	followUp(
		message: string | AgentMessage,
		images: ImageContent[] | undefined,
		context: Context,
	): Promise<QueueResult> {
		return this.enqueue("followUp", message, images, context);
	}

	nextRun(message: string | AgentMessage, images: ImageContent[] | undefined, context: Context): Promise<QueueResult> {
		return this.enqueue("nextRun", message, images, context);
	}

	private async enqueue(
		kind: "steer" | "followUp" | "nextRun",
		input: string | AgentMessage,
		images: ImageContent[] | undefined,
		context: Context,
	): Promise<QueueResult> {
		if (this.closedError instanceof HarnessClosed) {
			return Result.err(new Closed({ message: this.closedError.message }));
		}
		this.assertOpen();
		const at = Date.now();
		let message: AgentMessage;
		if (typeof input === "string") {
			if (input.length === 0 && (images === undefined || images.length === 0)) {
				return Result.err(
					new InvalidMessage({
						lane: this.name,
						reason: "empty",
						message: "Queued input must contain text or an image",
					}),
				);
			}
			message = {
				role: "user",
				content: [...(input.length === 0 ? [] : [{ type: "text" as const, text: input }]), ...(images ?? [])],
				timestamp: at,
			};
		} else {
			if (input.role === "assistant" && input.stopReason === "pending") {
				return Result.err(
					new InvalidMessage({
						lane: this.name,
						reason: "pending_assistant",
						message: "Cannot queue a pending assistant message",
					}),
				);
			}
			if (images !== undefined && images.length > 0 && input.role !== "user") {
				return Result.err(
					new InvalidMessage({
						lane: this.name,
						reason: "images_with_non_user",
						message: "Images can be added only to queued user messages",
					}),
				);
			}
			message =
				images === undefined || images.length === 0 || input.role !== "user"
					? structuredClone(input)
					: {
							...structuredClone(input),
							content: [
								...(typeof input.content === "string"
									? input.content.length === 0
										? []
										: [{ type: "text" as const, text: input.content }]
									: input.content),
								...images,
							],
						};
		}
		const entryId = this.session.idGenerator.next(at);
		return this.command<QueueResult>(async (state, reader) => {
			const inbox = [...state.inbox, { entryId, kind }];
			const queues = [
				...(await readLaneQueues(reader, state.inbox, context)),
				{ entryId, kind, type: "message" as const, message },
			];
			return {
				kind: "commit",
				writes: [
					setValue(pendingEntry(entryId), { type: "message", payload: message }),
					setValue(
						laneStateValue(this.name),
						durableLaneState(state, state.operation?.meta.operationId ?? null, inbox),
					),
				],
				next: { ...state, inbox },
				materialize: () => Result.ok({ entryId }),
				events: () => [{ type: "queue_update", queues, lane: this.name }],
			};
		}, context);
	}

	async cancelQueued(entryId: string, context: Context): Promise<CancelQueuedResult> {
		if (this.closedError instanceof HarnessClosed) {
			return Result.err(new Closed({ message: this.closedError.message }));
		}
		this.assertOpen();
		return this.command<CancelQueuedResult>(async (state, reader) => {
			const queued = state.inbox.find((item) => item.entryId === entryId);
			if (queued === undefined) {
				const consumed = (await reader.getEntries([entryId], context)).has(entryId);
				return {
					kind: "return",
					result: Result.ok({ kind: consumed ? "already_consumed" : "not_found" }),
				};
			}
			if ((await reader.getValue(pendingEntry(entryId), context)) === undefined) {
				throw new SessionInvariantError(`Queued ${queued.kind} entry ${entryId} is missing its payload`);
			}
			const inbox = state.inbox.filter((item) => item.entryId !== entryId);
			const queues = await readLaneQueues(reader, inbox, context);
			return {
				kind: "commit",
				writes: [
					deleteValue(pendingEntry(entryId)),
					setValue(
						laneStateValue(this.name),
						durableLaneState(state, state.operation?.meta.operationId ?? null, inbox),
					),
				],
				next: { ...state, inbox },
				materialize: () => Result.ok({ kind: "cancelled" }),
				events: () => [{ type: "queue_update", queues, lane: this.name }],
			};
		}, context);
	}

	async recordUsage(
		usage: Usage,
		options: { entryId?: string; details?: JsonValue } | undefined,
		context: Context,
	): Promise<RecordUsageResult> {
		if (this.closedError instanceof HarnessClosed) {
			return Result.err(new Closed({ message: this.closedError.message }));
		}
		this.assertOpen();
		return this.command<RecordUsageResult>((state) => {
			const usageId = this.session.idGenerator.next();
			const row = {
				id: usageId,
				usage,
				adjustment: true,
				...(options?.entryId === undefined ? {} : { entryId: options.entryId }),
				...(options?.details === undefined ? {} : { details: options.details }),
			};
			return {
				kind: "commit",
				writes: [insertUsage(row)],
				next: state,
				materialize: () => Result.ok({ usageId }),
				events: (commit) => [
					{
						type: "usage",
						lane: this.name,
						row: { ...row, seq: commit.seqs[0]! },
						totals: commit.stats.usage,
					},
				],
			};
		}, context);
	}

	async waitForIdle(context: Context): Promise<void> {
		for (;;) {
			const observation = await this.command<IdleObservation>(
				(state) => ({
					kind: "return",
					result:
						state.operation === null && this.activeDrive === undefined
							? { kind: "idle" }
							: { kind: "wait", drive: this.activeDrive, change: this.stateChange },
				}),
				context,
			);
			if (observation.kind === "idle") return;
			await awaitWithContext(
				observation.drive === undefined ? observation.change : observation.drive.completion.then(() => undefined),
				context,
			);
		}
	}

	async runWhenIdle(callback: (context: Context) => void | Promise<void>, context: Context): Promise<void> {
		let owner: Promise<void> | undefined;
		let releaseOwner: (() => void) | undefined;
		for (;;) {
			const observation = await this.command<IdleClaimObservation>((state) => {
				if (state.operation !== null || this.activeDrive !== undefined) {
					return {
						kind: "return",
						result: { kind: "wait", drive: this.activeDrive, change: this.stateChange },
					};
				}
				let release!: () => void;
				const claimed = new Promise<void>((resolve) => {
					release = resolve;
				});
				owner = claimed;
				releaseOwner = release;
				this.idleOwner = claimed;
				this.signalStateChange();
				return { kind: "return", result: { kind: "claimed" } };
			}, context);
			if (observation.kind === "claimed") break;
			await awaitWithContext(
				observation.drive === undefined ? observation.change : observation.drive.completion.then(() => undefined),
				context,
			);
		}
		if (owner === undefined || releaseOwner === undefined) {
			throw this.onFault(new SessionInvariantError("Idle callback claim was not published"), context);
		}
		try {
			this.assertOpen();
			await callback(context);
		} finally {
			if (this.idleOwner === owner) this.idleOwner = undefined;
			releaseOwner();
			this.signalStateChange();
		}
	}

	async getModel(_context: Context): Promise<Model<Api> | undefined> {
		this.assertOpen();
		return this.models.getModel(this.state.configuration.model.provider, this.state.configuration.model.modelId);
	}

	setModel(model: ModelIdentity, context: Context): Promise<void> {
		return this.setConfiguration(
			(configuration) => ({
				...configuration,
				model: { ...model },
			}),
			(previous, value) => ({
				type: "config_update",
				property: "model",
				previous: previous.model,
				value: value.model,
			}),
			context,
		);
	}

	async getThinkingLevel(_context: Context): Promise<ThinkingLevel> {
		this.assertOpen();
		return this.state.configuration.thinkingLevel;
	}

	setThinkingLevel(thinkingLevel: ThinkingLevel, context: Context): Promise<void> {
		return this.setConfiguration(
			(configuration) => ({ ...configuration, thinkingLevel }),
			(previous, value) => ({
				type: "config_update",
				property: "thinkingLevel",
				previous: previous.thinkingLevel,
				value: value.thinkingLevel,
			}),
			context,
		);
	}

	async getActiveTools(_context: Context): Promise<string[]> {
		this.assertOpen();
		return this.state.configuration.activeToolNames;
	}

	setActiveTools(activeToolNames: string[], context: Context): Promise<void> {
		return this.setConfiguration(
			(configuration) => ({ ...configuration, activeToolNames }),
			(previous, value) => ({
				type: "config_update",
				property: "activeTools",
				previous: previous.activeToolNames,
				value: value.activeToolNames,
			}),
			context,
		);
	}

	watch(context: Context): Promise<WatchHandle<LaneSnapshot>> {
		return this.readLane(async (state, reader) => {
			const watcher = this.installWatch<LaneSnapshot>(
				{} as LaneSnapshot,
				(event) => event.type === "usage" || !("lane" in event) || event.lane === this.name,
				context,
				(resnapshotContext, markBoundary) =>
					this.readLane(async (latest, latestReader) => {
						const snapshot = await this.captureLaneSnapshot(latest, latestReader, resnapshotContext);
						markBoundary();
						return snapshot;
					}, resnapshotContext),
			);
			try {
				watcher.snapshot = await this.captureLaneSnapshot(state, reader, context);
				return watcher;
			} catch (error) {
				watcher.unsubscribe();
				throw error;
			}
		}, context);
	}

	private async captureLaneSnapshot(state: LaneState, reader: SessionReader, context: Context): Promise<LaneSnapshot> {
		const captured = structuredClone(state);
		const transcript =
			captured.tipId === null
				? []
				: (
						await reader.scanBranch(
							{ start: captured.tipId, stopAtType: "compaction", order: "newestFirst" },
							context,
						)
					).reverse();
		const queues = await readLaneQueues(reader, captured.inbox, context);
		let lastResult: OperationResultRecord | undefined;
		if (captured.lastOperationId !== null) {
			const stored = await reader.getValue(operationResultValue(captured.lastOperationId), context);
			if (stored === undefined) {
				throw new SessionInvariantError(
					`Lane ${JSON.stringify(this.name)} is missing result ${captured.lastOperationId}`,
				);
			}
			lastResult = stored.value;
		}
		const stats = await reader.getStats(context);
		const operation = captured.operation;

		let operationSnapshot: NonNullable<LaneSnapshot["operation"]> | null = null;
		if (operation !== null) {
			const runningTools: NonNullable<LaneSnapshot["operation"]>["runningTools"] = [];
			let streamingMessage: NonNullable<LaneSnapshot["operation"]>["streamingMessage"];
			let retry: NonNullable<LaneSnapshot["operation"]>["retry"];
			let deferred: NonNullable<LaneSnapshot["operation"]>["deferred"];
			const readStreamingMessage = async (responseEntryId: string) =>
				reduceAssistantMessageFrames(
					await readAssistantFrames(reader, operation.meta.operationId, responseEntryId, context),
				);
			const state = operation.state;
			switch (state.at) {
				case "assistant.retry_wait":
					retry = {
						attempt: state.nextAttempt,
						maxAttempts: state.generationContext.retryPolicy.maxAttempts,
						nextAttemptAt: state.notBefore,
					};
					break;
				case "assistant.effect_pending":
					streamingMessage = await readStreamingMessage(state.responseEntryId);
					break;
				case "deferred.suspended":
				case "deferred.effect_pending": {
					const source = (await reader.getEntries([state.sourceEntryId], context)).get(state.sourceEntryId);
					if (
						source?.type !== "message" ||
						source.message.role !== "assistant" ||
						source.message.deferred === undefined
					) {
						throw new SessionInvariantError("Deferred source is missing its assistant handle");
					}
					deferred = { handle: source.message.deferred, poll: state.poll };
					if (state.at === "deferred.effect_pending") {
						streamingMessage = await readStreamingMessage(state.responseEntryId);
					}
					break;
				}
				case "tools": {
					const { batch } = state;
					const assistant = (await reader.getEntries([batch.assistantEntryId], context)).get(
						batch.assistantEntryId,
					);
					if (assistant?.type !== "message" || assistant.message.role !== "assistant") {
						throw new SessionInvariantError("Tool batch assistant entry is invalid");
					}
					for (const call of batch.calls) {
						if (call.status === "planned" || call.status === "completed") continue;
						const block = assistant.message.content[call.sourceIndex];
						if (block?.type !== "toolCall") {
							throw new SessionInvariantError(
								`Tool call source index ${call.sourceIndex} does not name a tool-call block`,
							);
						}
						const args = await reader.getValue(
							operationToolArgs(operation.meta.operationId, batch.turnId, call.sourceIndex),
							context,
						);
						if (call.status === "effect_pending") {
							if (args === undefined) {
								throw new SessionInvariantError(`Tool call ${block.id} is missing persisted arguments`);
							}
							const checkpoint = await reader.getValue(
								pendingToolOutput(operation.meta.operationId, call.resultEntryId),
								context,
							);
							runningTools.push({
								status: "running",
								toolCallId: block.id,
								toolName: block.name,
								args: args.value,
								...(checkpoint === undefined ? {} : { result: checkpoint.value }),
							});
							continue;
						}
						const staged = await reader.getValue(pendingEntry(call.resultEntryId), context);
						if (staged?.value.type !== "message" || staged.value.payload.role !== "toolResult") {
							throw new SessionInvariantError(`Tool call ${call.resultEntryId} is missing its staged result`);
						}
						if (staged.value.payload.toolCallId !== block.id || staged.value.payload.toolName !== block.name) {
							throw new SessionInvariantError(`Tool call ${call.resultEntryId} has a mismatched staged result`);
						}
						runningTools.push({
							status: "settled",
							toolCallId: block.id,
							toolName: block.name,
							args: args?.value ?? block.arguments,
							result: toolResultFromMessage(staged.value.payload, call.terminate),
							isError: staged.value.payload.isError,
						});
					}
					break;
				}
				case "summary.retry_wait":
					retry = {
						attempt: state.nextAttempt,
						maxAttempts: state.summaryContext.retryPolicy.maxAttempts,
						nextAttemptAt: state.notBefore,
					};
					break;
				default:
					break;
			}

			operationSnapshot = {
				id: operation.meta.operationId,
				kind: operation.meta.intent.kind,
				startedAt: operation.meta.startedAt,
				fromTipId: operation.meta.sourceTipId,
				status: operation.state.control.status === "cancel_requested" ? "aborting" : "open",
				...(retry === undefined ? {} : { retry }),
				...(deferred === undefined ? {} : { deferred }),
				...(streamingMessage === undefined ? {} : { streamingMessage }),
				runningTools,
			};
		}

		return structuredClone({
			lane: this.name,
			transcript,
			tipId: captured.tipId,
			...(lastResult === undefined ? {} : { lastResult }),
			configuration: captured.configuration,
			stats,
			operation: operationSnapshot,
			queues,
			faulted: this.closedError instanceof HarnessFault,
		});
	}

	private async setConfiguration(
		update: (configuration: LaneState["configuration"]) => LaneState["configuration"],
		event: (previous: LaneState["configuration"], value: LaneState["configuration"]) => LaneConfigEventPayload,
		context: Context,
	): Promise<void> {
		await this.command((state) => {
			const configuration = update(state.configuration);
			return {
				kind: "commit",
				writes: [setValue(laneConfig(this.name), configuration)],
				next: { ...state, configuration },
				materialize: () => undefined,
				events: () => [{ ...event(state.configuration, configuration), lane: this.name }],
			};
		}, context);
	}

	async findEntries(query: BranchScan | undefined, context: Context): Promise<Entry[]> {
		query ??= {};
		this.assertOpen();
		const start = query.start ?? this.state.tipId;
		return start === null
			? []
			: this.session.scanBranch({ ...query, start, order: query.order ?? "newestFirst" }, context);
	}

	async findEntry(query: BranchScan | undefined, context: Context): Promise<Entry | undefined> {
		query ??= {};
		return (
			await this.findEntries({ ...query, limit: query.limit === undefined ? 1 : Math.min(query.limit, 1) }, context)
		)[0];
	}

	appendMessage(message: AgentMessage, context: Context): Promise<string> {
		return this.append({ type: "message", payload: message }, context);
	}

	appendCustomEntry(customType: string, data: JsonValue | undefined, context: Context): Promise<string> {
		return this.append({ type: "custom", customType, ...(data === undefined ? {} : { payload: data }) }, context);
	}

	private append(pending: PendingEntry, context: Context): Promise<string> {
		this.assertOpen();
		if (
			pending.type === "message" &&
			pending.payload.role === "assistant" &&
			pending.payload.stopReason === "pending"
		) {
			return Promise.reject(new SessionPendingAssistantMessageError());
		}
		const id = this.session.idGenerator.next();
		return this.command(async (state, reader) => {
			if (state.operation === null) {
				const queued = inboxItems(state.inbox, "write");
				const captured = await Promise.all(
					queued.map(async (item) => {
						const stored = await reader.getValue(pendingEntry(item.entryId), context);
						if (stored === undefined) {
							throw new SessionInvariantError(`Pending write ${item.entryId} is missing its payload`);
						}
						return pendingEntryWrite(item.entryId, stored.value);
					}),
				);
				const inbox = withoutInboxItems(state.inbox, queued);
				const queues = queued.length === 0 ? undefined : await readLaneQueues(reader, inbox, context);
				const entries = chainEntries(state.tipId, [...captured, pendingEntryWrite(id, pending)]);
				return {
					kind: "commit",
					writes: [
						...entries.map((entry) => insertEntry(entry)),
						...queued.map((item) => deleteValue(pendingEntry(item.entryId))),
						setValue(branchTip(this.name), id),
						setValue(laneStateValue(this.name), durableLaneState(state, null, inbox)),
					],
					next: { ...state, tipId: id, inbox },
					materialize: () => id,
					events: (commit) => [
						...committedEntryEvents(entries, commit, this.name),
						...(queues === undefined ? [] : [{ type: "queue_update" as const, queues, lane: this.name }]),
					],
				};
			}

			const operation = state.operation;
			const inbox = [...state.inbox, { entryId: id, kind: "write" as const }];
			const queues = [
				...(await readLaneQueues(reader, state.inbox, context)),
				pending.type === "message"
					? { entryId: id, kind: "write" as const, type: "message" as const, message: pending.payload }
					: {
							entryId: id,
							kind: "write" as const,
							type: "custom" as const,
							customType: pending.customType,
							...(pending.payload === undefined ? {} : { data: pending.payload }),
						},
			];
			return {
				kind: "commit",
				writes: [
					setValue(pendingEntry(id), pending),
					setValue(laneStateValue(this.name), durableLaneState(state, operation.meta.operationId, inbox)),
				],
				next: { ...state, inbox },
				materialize: () => id,
				events: () => [{ type: "queue_update", queues, lane: this.name }],
			};
		}, context);
	}

	seal(error: Error): Promise<void> {
		this.closedError ??= error;
		this.activeDrive?.closeGate(error);
		this.signalStateChange();
		return this.idleOwner ?? Promise.resolve();
	}

	private signalStateChange(): void {
		this.resolveStateChange();
		let resolveStateChange!: () => void;
		this.stateChange = new Promise<void>((resolve) => {
			resolveStateChange = resolve;
		});
		this.resolveStateChange = resolveStateChange;
	}

	assertOpen(): void {
		if (this.closedError !== undefined) throw this.closedError;
	}
}

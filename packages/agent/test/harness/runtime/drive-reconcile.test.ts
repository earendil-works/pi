import {
	createModels,
	type DeferredHandle,
	fauxAssistantMessage,
	fauxProvider,
	fauxToolCall,
	type MutableModels,
	type Provider,
} from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HarnessEvent, WatchHandle } from "../../../src/harness/agent-harness.ts";
import { DEFAULT_COMPACTION_SETTINGS } from "../../../src/harness/compaction/compaction.ts";
import { BACKGROUND_CONTEXT } from "../../../src/harness/context.ts";
import { HookRegistry } from "../../../src/harness/hooks.ts";
import { reconcileOperation } from "../../../src/harness/runtime/drive/reconcile.ts";
import { runStructuralDecision } from "../../../src/harness/runtime/drive/structural.ts";
import { driveOperation } from "../../../src/harness/runtime/drive.ts";
import { Lane } from "../../../src/harness/runtime/lane.ts";
import { restoreLane } from "../../../src/harness/runtime/restore.ts";
import { type Config, Drive } from "../../../src/harness/runtime/types.ts";
import { insertEntry } from "../../../src/harness/session/commit.ts";
import { MemoryStorage } from "../../../src/harness/session/memory.ts";
import { StorageBackedSession } from "../../../src/harness/session/session.ts";
import { InstrumentedStorage } from "../../../src/harness/session/testing/instrumented-storage.ts";
import type {
	Control,
	DeferredEffectPendingOperation,
	DeferredSuspendedOperation,
	LaneConfiguration,
	NewEntry,
	OperationMeta,
	OperationScope,
	OperationState,
	Session,
	SummaryContext,
	SummaryTask,
	Write,
} from "../../../src/harness/session/types.ts";
import * as storedValues from "../../../src/harness/session/values.ts";
import type { AgentMessage } from "../../../src/types.ts";

const sessions: Session[] = [];
const operationId = "01950000-0000-7000-8000-000000000001";

interface Fixture {
	lane: Lane<undefined>;
	drive: Drive;
	session: Session;
	storage: InstrumentedStorage;
	models: MutableModels;
	faux: ReturnType<typeof fauxProvider>;
	configuration: LaneConfiguration;
	events: HarnessEvent[];
	hooks: HookRegistry;
}

interface InstalledOperation {
	state: OperationState;
	intent: OperationMeta["intent"];
	entries?: NewEntry[];
	writes?: Write[];
	terminalEvents: HarnessEvent["type"][];
}

function unusedWatch<T>(): WatchHandle<T> {
	throw new Error("watch is not used by reconciliation tests");
}

function cancelledControl(): Control {
	return { status: "cancel_requested", requestedAt: 10 };
}

function scope(control: Control = cancelledControl()): OperationScope {
	return {
		control,
		settings: {
			compaction: DEFAULT_COMPACTION_SETTINGS,
			steeringMode: "all",
			followUpMode: "all",
			toolExecution: "parallel",
		},
		latestAssistantEntryId: null,
	};
}

function user(content: string): AgentMessage {
	return { role: "user", content, timestamp: 1 };
}

function summaryContext(configuration: LaneConfiguration): SummaryContext {
	return {
		resultEntryId: "summary-entry",
		configuration,
		streamOptions: {},
		retryPolicy: { maxAttempts: 2, baseDelayMs: 10 },
	};
}

async function createFixture(): Promise<Fixture> {
	const storage = new InstrumentedStorage(new MemoryStorage({ now: () => 100 }));
	const session = new StorageBackedSession(
		{ id: `reconcile-${sessions.length}`, createdAt: 1, storageVersion: 1 },
		storage,
	);
	sessions.push(session);
	const faux = fauxProvider({ api: "faux", deferred: { pendingFetches: 0 } });
	const model = faux.getModel();
	const models = createModels();
	models.setProvider(faux.provider);
	const configuration: LaneConfiguration = {
		model: { provider: model.provider, modelId: model.id },
		thinkingLevel: "off",
		activeToolNames: [],
	};
	await session.mutate(
		(mutator) =>
			mutator.commit(
				[
					storedValues.setValue(storedValues.branchTip("main"), null),
					storedValues.setValue(storedValues.laneConfig("main"), configuration),
					storedValues.setValue(storedValues.laneState("main"), {
						currentOperationId: null,
						lastOperationId: null,
						inbox: [],
					}),
				],
				BACKGROUND_CONTEXT,
			),
		BACKGROUND_CONTEXT,
	);
	const hooks = new HookRegistry(() => {});
	const events: HarnessEvent[] = [];
	const config: Config<undefined> = {
		tools: [],
		resources: {},
		streamOptions: {},
		retryPolicy: { enabled: true, maxRetries: 1, baseDelayMs: 10 },
		compaction: DEFAULT_COMPACTION_SETTINGS,
		steeringMode: "all",
		followUpMode: "all",
		toolExecution: "parallel",
		toolContext: undefined,
		systemPrompt: undefined,
		toProviderMessages: (messages) =>
			messages.filter(
				(message) => message.role === "user" || message.role === "assistant" || message.role === "toolResult",
			),
		entryProjectors: {},
	};
	const lane = new Lane<undefined>(
		"main",
		session,
		models,
		hooks,
		await restoreLane(session, "main", BACKGROUND_CONTEXT),
		(cause) => (cause instanceof Error ? cause : new Error(String(cause))),
		(batch) => {
			events.push(...structuredClone(batch));
			return Promise.resolve();
		},
		unusedWatch,
		() => config,
	);
	const drive = new Drive({ operationId }, BACKGROUND_CONTEXT);
	lane.activeDrive = drive;
	storage.clearCommitAttempts();
	return { lane, drive, session, storage, models, faux, configuration, events, hooks };
}

async function installOperation(fixture: Fixture, installed: InstalledOperation): Promise<void> {
	const entries = installed.entries ?? [
		{ id: "tip", parentId: null, type: "message" as const, message: user("history") },
	];
	const tipId = entries.at(-1)?.id ?? null;
	const meta: OperationMeta = {
		operationId,
		lane: "main",
		sourceTipId: tipId,
		startedAt: 1,
		intent: installed.intent,
	};
	await fixture.lane.command(
		(projection) => ({
			kind: "commit",
			writes: [
				...entries.map((entry) => insertEntry(entry)),
				storedValues.setValue(storedValues.branchTip("main"), tipId),
				...(installed.writes ?? []),
				storedValues.setValue(storedValues.operationMeta(operationId), meta),
				storedValues.setValue(storedValues.operationState(operationId), installed.state),
				storedValues.setValue(storedValues.laneState("main"), {
					currentOperationId: operationId,
					lastOperationId: projection.lastOperationId,
					inbox: projection.inbox,
				}),
			],
			next: { ...projection, tipId, operation: { meta, state: installed.state } },
			materialize: () => undefined,
		}),
		BACKGROUND_CONTEXT,
	);
	fixture.storage.clearCommitAttempts();
}

function deferredOperation(
	fixture: Fixture,
	effectPending: boolean,
): { state: DeferredSuspendedOperation | DeferredEffectPendingOperation; entry: NewEntry; handle: DeferredHandle } {
	const model = fixture.faux.getModel();
	const handle = { provider: model.provider, modelId: model.id, api: model.api, id: "deferred-job" };
	const entry: NewEntry = {
		id: "deferred-source",
		parentId: null,
		type: "message",
		message: fauxAssistantMessage([], { stopReason: "deferred", deferred: handle }),
	};
	const base = {
		...scope(),
		stepId: "step",
		sourceEntryId: entry.id,
		poll: effectPending ? 1 : 0,
		configuration: fixture.configuration,
		streamOptions: {},
	};
	return {
		state: effectPending
			? {
					...base,
					at: "deferred.effect_pending",
					responseEntryId: "deferred-response",
					usageId: "deferred-usage",
				}
			: { ...base, at: "deferred.suspended" },
		entry,
		handle,
	};
}

function cases(fixture: Fixture): InstalledOperation[] {
	const generation = {
		stepId: "step",
		triggerEntryId: "tip",
		configuration: fixture.configuration,
		streamOptions: {},
		retryPolicy: { maxAttempts: 2, baseDelayMs: 10 },
		overflowRecoveryUsed: false,
	};
	const runTask: SummaryTask = {
		taskId: "run-summary",
		reason: "threshold",
		boundary: {
			kind: "resume_checkpoint",
			resumeAfter: {
				continuation: { kind: "need_assistant", overflowRecoveryUsed: false },
				triggerEntryId: "tip",
			},
		},
	};
	const compactionTask: SummaryTask = { taskId: "compaction", reason: "manual", boundary: { kind: "finish" } };
	const navigationTask: SummaryTask = {
		taskId: "navigation",
		boundary: { kind: "commit_navigation", targetId: "target" },
	};
	const suspended = deferredOperation(fixture, false);
	const deferredEffect = deferredOperation(fixture, true);
	return [
		{
			state: { ...scope(), at: "starting" },
			intent: { kind: "run", promptEntryIds: ["tip"] },
			terminalEvents: ["run_end"],
		},
		{
			state: {
				...scope(),
				at: "checkpoint",
				continuation: { kind: "need_assistant", overflowRecoveryUsed: false },
				triggerEntryId: "tip",
			},
			intent: { kind: "run", promptEntryIds: ["tip"] },
			terminalEvents: ["run_end"],
		},
		{
			state: { ...scope(), at: "assistant.ready", generationContext: generation, nextAttempt: 1 },
			intent: { kind: "run", promptEntryIds: ["tip"] },
			terminalEvents: ["run_end"],
		},
		{
			state: {
				...scope(),
				at: "assistant.effect_pending",
				generationContext: generation,
				attempt: 1,
				responseEntryId: "assistant-response",
				usageId: "assistant-usage",
				intendedOutputLimit: 100,
				contextWindow: 1_000,
			},
			intent: { kind: "run", promptEntryIds: ["tip"] },
			writes: [
				storedValues.appendList(storedValues.pendingAssistantFrames(operationId, "assistant-response"), {
					type: "text_delta",
					contentIndex: 0,
					delta: "partial",
				}),
			],
			terminalEvents: ["run_end"],
		},
		{
			state: {
				...scope(),
				at: "assistant.retry_wait",
				generationContext: generation,
				nextAttempt: 2,
				notBefore: Date.now() + 100_000,
				errorMessage: "retry",
			},
			intent: { kind: "run", promptEntryIds: ["tip"] },
			terminalEvents: ["run_end"],
		},
		{
			state: {
				...scope(),
				at: "tools",
				batch: {
					assistantEntryId: "assistant",
					configuration: fixture.configuration,
					turnId: "turn",
					calls: [{ status: "planned", sourceIndex: 0, resultEntryId: "tool-result" }],
				},
			},
			intent: { kind: "run", promptEntryIds: [] },
			entries: [
				{
					id: "assistant",
					parentId: null,
					type: "message",
					message: fauxAssistantMessage(fauxToolCall("tool", {}), { stopReason: "toolUse" }),
				},
			],
			terminalEvents: ["run_end"],
		},
		{
			state: suspended.state,
			intent: { kind: "run", promptEntryIds: [] },
			entries: [suspended.entry],
			terminalEvents: ["run_end"],
		},
		{
			state: deferredEffect.state,
			intent: { kind: "run", promptEntryIds: [] },
			entries: [deferredEffect.entry],
			terminalEvents: ["run_end"],
		},
		{
			state: { ...scope(), at: "summary.deciding", task: runTask },
			intent: { kind: "run", promptEntryIds: ["tip"] },
			terminalEvents: ["compaction_end", "run_end"],
		},
		{
			state: {
				...scope(),
				at: "summary.ready",
				task: compactionTask,
				summaryContext: summaryContext(fixture.configuration),
				nextAttempt: 1,
			},
			intent: { kind: "compaction" },
			terminalEvents: ["compaction_end"],
		},
		{
			state: {
				...scope(),
				at: "summary.effect_pending",
				task: navigationTask,
				summaryContext: summaryContext(fixture.configuration),
				attempt: 1,
				request: { index: 0, usageId: "usage" },
				usageIds: [],
			},
			intent: { kind: "navigation", targetId: "target", summarize: true },
			terminalEvents: ["navigation_end"],
		},
		{
			state: {
				...scope(),
				at: "summary.retry_wait",
				task: runTask,
				summaryContext: summaryContext(fixture.configuration),
				nextAttempt: 2,
				notBefore: Date.now() + 100_000,
				errorMessage: "retry",
			},
			intent: { kind: "run", promptEntryIds: ["tip"] },
			terminalEvents: ["compaction_end", "run_end"],
		},
		{
			state: { ...scope(), at: "navigation.ready_to_commit", targetId: "target" },
			intent: { kind: "navigation", targetId: "target", summarize: false },
			terminalEvents: ["navigation_end"],
		},
	];
}

afterEach(async () => {
	vi.useRealTimers();
	vi.restoreAllMocks();
	for (const session of sessions.splice(0)) await session.close(BACKGROUND_CONTEXT);
});

describe("runtime total drive", () => {
	it("drives an ordinary run through all direct procedures with one before_drive hook", async () => {
		const fixture = await createFixture();
		await installOperation(fixture, {
			state: { ...scope({ status: "running" }), at: "starting" },
			intent: { kind: "run", promptEntryIds: ["tip"] },
			terminalEvents: ["run_end"],
		});
		const beforeDrive = vi.fn();
		fixture.hooks.on("before_drive", beforeDrive);
		fixture.faux.setResponses([fauxAssistantMessage("answer")]);

		expect(await driveOperation(fixture.lane, fixture.drive)).toMatchObject({
			kind: "settled",
			outcome: { operationId, kind: "run", status: "completed" },
		});
		expect(beforeDrive).toHaveBeenCalledTimes(1);
		expect(fixture.faux.state.callCount).toBe(1);
		expect(fixture.lane.state.operation).toBeNull();
	});

	it("leaves durable state unchanged when before_drive fails closed", async () => {
		const fixture = await createFixture();
		const starting = { ...scope({ status: "running" }), at: "starting" } as const;
		await installOperation(fixture, {
			state: starting,
			intent: { kind: "run", promptEntryIds: ["tip"] },
			terminalEvents: ["run_end"],
		});
		fixture.hooks.on("before_drive", () => {
			throw new Error("blocked drive");
		});

		await expect(driveOperation(fixture.lane, fixture.drive)).rejects.toThrow("blocked drive");
		expect(fixture.lane.state.operation?.state).toEqual(starting);
		expect(fixture.storage.getCommitAttempts()).toEqual([]);
	});
});

describe("runtime cancellation reconciliation", () => {
	it("reconciles every durable leaf without ordinary hook admission", async () => {
		for (let index = 0; index < 13; index++) {
			const fixture = await createFixture();
			const installed = cases(fixture)[index]!;
			await installOperation(fixture, installed);
			const beforeDrive = vi.fn();
			fixture.hooks.on("before_drive", beforeDrive);

			const outcome = await driveOperation(fixture.lane, fixture.drive);

			expect(outcome).toMatchObject({
				kind: "settled",
				outcome: { operationId, status: "aborted" },
			});
			expect(beforeDrive).not.toHaveBeenCalled();
			expect(fixture.lane.state.operation).toBeNull();
			expect(await fixture.lane.getResult(operationId, BACKGROUND_CONTEXT)).toMatchObject({ status: "aborted" });
			expect(
				await fixture.session.getValue(storedValues.operationMeta(operationId), BACKGROUND_CONTEXT),
			).toBeUndefined();
			expect(
				await fixture.session.getValue(storedValues.operationState(operationId), BACKGROUND_CONTEXT),
			).toBeUndefined();
			expect(
				await fixture.session.scanValues(storedValues.operationToolArgsPrefix(operationId), BACKGROUND_CONTEXT),
			).toEqual([]);
			expect(
				await fixture.session.scanValues(storedValues.operationToolMemoPrefix(operationId), BACKGROUND_CONTEXT),
			).toEqual([]);
			expect(
				await fixture.session.scanValues(storedValues.operationPreparationPrefix(operationId), BACKGROUND_CONTEXT),
			).toEqual([]);
			if (installed.state.at === "deferred.suspended" || installed.state.at === "deferred.effect_pending") {
				expect(fixture.faux.state.cancelledDeferred).toHaveLength(1);
			}
			expect(
				fixture.events
					.filter((event) => installed.terminalEvents.includes(event.type))
					.slice(-installed.terminalEvents.length)
					.map((event) => event.type),
			).toEqual(installed.terminalEvents);
		}
	});

	it("durably drains abortable input once and preserves lane-owned input through terminal cleanup", async () => {
		const fixture = await createFixture();
		await installOperation(fixture, {
			state: {
				...scope({ status: "running" }),
				at: "checkpoint",
				continuation: { kind: "need_assistant", overflowRecoveryUsed: false },
				triggerEntryId: "tip",
			},
			intent: { kind: "run", promptEntryIds: ["tip"] },
			terminalEvents: ["run_end"],
		});
		const queued = [
			{ entryId: "steer", kind: "steer" as const, message: user("steer") },
			{ entryId: "write", kind: "write" as const, message: user("write") },
			{ entryId: "follow", kind: "followUp" as const, message: user("follow") },
			{ entryId: "next", kind: "nextRun" as const, message: user("next") },
		];
		await fixture.lane.command(
			(state) => ({
				kind: "commit",
				writes: [
					...queued.map((item) =>
						storedValues.setValue(storedValues.pendingEntry(item.entryId), {
							type: "message" as const,
							payload: item.message,
						}),
					),
					storedValues.setValue(storedValues.laneState("main"), {
						currentOperationId: operationId,
						lastOperationId: null,
						inbox: queued.map(({ entryId, kind }) => ({ entryId, kind })),
					}),
				],
				next: { ...state, inbox: queued.map(({ entryId, kind }) => ({ entryId, kind })) },
				materialize: () => undefined,
			}),
			BACKGROUND_CONTEXT,
		);
		fixture.storage.clearCommitAttempts();

		const requested = await fixture.lane.requestOperationAbort(operationId, BACKGROUND_CONTEXT);
		expect(requested).toMatchObject({
			ok: true,
			value: {
				operationId,
				newlyRequested: true,
				steer: [{ content: "steer" }],
				followUp: [{ content: "follow" }],
			},
		});
		expect(fixture.drive.gate.signal.aborted).toBe(true);
		expect(fixture.drive.closeSignal.aborted).toBe(false);
		expect(fixture.lane.state.inbox).toEqual([
			{ entryId: "write", kind: "write" },
			{ entryId: "next", kind: "nextRun" },
		]);
		expect(await fixture.session.getValue(storedValues.pendingEntry("steer"), BACKGROUND_CONTEXT)).toBeUndefined();
		expect(await fixture.session.getValue(storedValues.pendingEntry("follow"), BACKGROUND_CONTEXT)).toBeUndefined();
		expect(fixture.events.filter((event) => event.type === "operation_abort")).toMatchObject([
			{ operationId, steer: [{ content: "steer" }], followUp: [{ content: "follow" }] },
		]);
		const commitCount = fixture.storage.getCommitAttempts().length;
		const eventCount = fixture.events.length;
		expect(await fixture.lane.requestOperationAbort(operationId, BACKGROUND_CONTEXT)).toEqual({
			ok: true,
			value: { operationId, newlyRequested: false, steer: [], followUp: [] },
		});
		expect(fixture.storage.getCommitAttempts()).toHaveLength(commitCount);
		expect(fixture.events).toHaveLength(eventCount);

		expect(await driveOperation(fixture.lane, fixture.drive)).toMatchObject({
			kind: "settled",
			outcome: { status: "aborted" },
		});
		expect(fixture.lane.state.inbox).toEqual([
			{ entryId: "write", kind: "write" },
			{ entryId: "next", kind: "nextRun" },
		]);
		expect(await fixture.session.getValue(storedValues.pendingEntry("write"), BACKGROUND_CONTEXT)).toBeDefined();
		expect(await fixture.session.getValue(storedValues.pendingEntry("next"), BACKGROUND_CONTEXT)).toBeDefined();
		fixture.storage.clearCommitAttempts();
		const stale = await fixture.lane.requestOperationAbort(operationId, BACKGROUND_CONTEXT);
		expect(stale.ok).toBe(false);
		if (stale.ok) throw new Error("settled abort unexpectedly succeeded");
		expect(stale.error._tag).toBe("OperationMismatch");
		expect(fixture.storage.getCommitAttempts()).toEqual([]);
	});

	it("marks cancellation without installing a Drive", async () => {
		const fixture = await createFixture();
		await installOperation(fixture, {
			state: { ...scope({ status: "running" }), at: "starting" },
			intent: { kind: "run", promptEntryIds: ["tip"] },
			terminalEvents: ["run_end"],
		});
		fixture.lane.activeDrive = undefined;

		expect(await fixture.lane.requestOperationAbort(operationId, BACKGROUND_CONTEXT)).toMatchObject({
			ok: true,
			value: { newlyRequested: true },
		});
		expect(fixture.lane.activeDrive).toBeUndefined();
		expect(fixture.lane.state.operation?.state.control.status).toBe("cancel_requested");
	});

	it("cancels an admitted retry timer only after the abort marker commits", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(1_000);
		const fixture = await createFixture();
		const generation = {
			stepId: "step",
			triggerEntryId: "tip",
			configuration: fixture.configuration,
			streamOptions: {},
			retryPolicy: { maxAttempts: 2, baseDelayMs: 10 },
			overflowRecoveryUsed: false,
		};
		await installOperation(fixture, {
			state: {
				...scope({ status: "running" }),
				at: "assistant.retry_wait",
				generationContext: generation,
				nextAttempt: 2,
				notBefore: 2_000,
				errorMessage: "retry",
			},
			intent: { kind: "run", promptEntryIds: ["tip"] },
			terminalEvents: ["run_end"],
		});
		const drive = new Drive({ operationId, waitForRetry: true }, BACKGROUND_CONTEXT);
		fixture.lane.activeDrive = drive;
		const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
		const running = driveOperation(fixture.lane, drive);
		await vi.waitFor(() => expect(setTimeoutSpy).toHaveBeenCalled());

		expect(await fixture.lane.requestOperationAbort(operationId, BACKGROUND_CONTEXT)).toMatchObject({
			ok: true,
			value: { newlyRequested: true },
		});
		expect(await running).toMatchObject({ kind: "settled", outcome: { status: "aborted" } });
		expect(fixture.events.some((event) => event.type === "retry_start")).toBe(false);
	});

	it("drops a stale structural hook result when cancellation commits first", async () => {
		const fixture = await createFixture();
		const task: SummaryTask = { taskId: "task", reason: "manual", boundary: { kind: "finish" } };
		const deciding = { ...scope({ status: "running" }), at: "summary.deciding", task } as const;
		await installOperation(fixture, {
			state: deciding,
			intent: { kind: "compaction" },
			writes: [
				storedValues.setValue(storedValues.operationPreparation(operationId, task.taskId), {
					kind: "compaction",
					messagesToSummarize: [user("history")],
					turnPrefixMessages: [],
					retainedTail: [],
					isSplitTurn: false,
					tokensBefore: 100,
					fileOps: { read: [], written: [], edited: [] },
					settings: DEFAULT_COMPACTION_SETTINGS,
				}),
			],
			terminalEvents: ["compaction_end"],
		});
		let releaseHook!: () => void;
		const hookStarted = new Promise<void>((resolve) => {
			fixture.hooks.on("before_compaction", async () => {
				resolve();
				await new Promise<void>((release) => {
					releaseHook = release;
				});
				return {
					compaction: { summary: "stale", tokensBefore: 100, retainedTail: [] },
				};
			});
		});
		const running = runStructuralDecision(fixture.lane, fixture.drive, deciding);
		await hookStarted;
		await fixture.lane.requestOperationAbort(operationId, BACKGROUND_CONTEXT);
		releaseHook();

		expect(await running).toEqual({ kind: "continue" });
		expect(await fixture.session.findEntries({ type: "compaction" }, BACKGROUND_CONTEXT)).toEqual([]);
		expect(await driveOperation(fixture.lane, fixture.drive)).toMatchObject({
			kind: "settled",
			outcome: { status: "aborted" },
		});
		expect(fixture.events.at(-1)).toMatchObject({ type: "compaction_end", status: "aborted" });
	});

	it("keeps the deferred cleanup signal separate from operation abort", () => {
		const drive = new Drive({ operationId }, BACKGROUND_CONTEXT);
		drive.beginAbort(Promise.resolve());
		drive.signalAbort();
		expect(drive.gate.signal.aborted).toBe(true);
		expect(drive.closeSignal.aborted).toBe(false);
		const closed = new Error("closed");
		drive.closeGate(closed);
		expect(drive.closeSignal.aborted).toBe(true);
		expect(drive.closeSignal.reason).toBe(closed);
	});

	it("can crash between cancelled response settlement and terminal cleanup", async () => {
		const fixture = await createFixture();
		const installed = cases(fixture)[3]!;
		await installOperation(fixture, installed);

		expect(await reconcileOperation(fixture.lane, fixture.drive)).toEqual({ kind: "continue" });
		expect(fixture.lane.state.operation?.state.at).toBe("checkpoint");
		expect(await fixture.session.getEntry("assistant-response", BACKGROUND_CONTEXT)).toMatchObject({
			type: "message",
			message: { stopReason: "aborted" },
		});
		expect(await fixture.lane.getResult(operationId, BACKGROUND_CONTEXT)).toBeUndefined();
		expect(
			await fixture.session.readList(
				storedValues.pendingAssistantFrames(operationId, "assistant-response"),
				undefined,
				BACKGROUND_CONTEXT,
			),
		).toEqual([]);

		const resumed = new Drive({ operationId }, BACKGROUND_CONTEXT);
		fixture.lane.activeDrive = resumed;
		expect(await driveOperation(fixture.lane, resumed)).toMatchObject({
			kind: "settled",
			outcome: { status: "aborted" },
		});
	});

	it("ignores deferred-provider cancellation failure", async () => {
		const fixture = await createFixture();
		const deferred = deferredOperation(fixture, false);
		const provider: Provider = {
			...fixture.faux.provider,
			cancelDeferred: async () => {
				throw new Error("remote cancellation failed");
			},
		};
		fixture.models.setProvider(provider);
		await installOperation(fixture, {
			state: deferred.state,
			intent: { kind: "run", promptEntryIds: [] },
			entries: [deferred.entry],
			terminalEvents: ["run_end"],
		});

		expect(await driveOperation(fixture.lane, fixture.drive)).toMatchObject({
			kind: "settled",
			outcome: { status: "aborted" },
		});
	});
});

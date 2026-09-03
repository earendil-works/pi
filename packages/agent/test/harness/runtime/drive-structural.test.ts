import { createModels, fauxAssistantMessage, fauxProvider, type MutableModels } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HarnessEvent, WatchHandle } from "../../../src/harness/agent-harness.ts";
import { DEFAULT_COMPACTION_SETTINGS } from "../../../src/harness/compaction/compaction.ts";
import { BACKGROUND_CONTEXT } from "../../../src/harness/context.ts";
import { HookRegistry } from "../../../src/harness/hooks.ts";
import { runCheckpoint } from "../../../src/harness/runtime/drive/checkpoint.ts";
import { runGeneration } from "../../../src/harness/runtime/drive/generation.ts";
import {
	commitNavigation,
	recoverStructuralGeneration,
	runStructuralDecision,
	runStructuralGeneration,
	runStructuralRetryWait,
} from "../../../src/harness/runtime/drive/structural.ts";
import { Lane } from "../../../src/harness/runtime/lane.ts";
import { restoreLane } from "../../../src/harness/runtime/restore.ts";
import { type Config, Drive } from "../../../src/harness/runtime/types.ts";
import { insertEntry } from "../../../src/harness/session/commit.ts";
import { MemoryStorage } from "../../../src/harness/session/memory.ts";
import { StorageBackedSession } from "../../../src/harness/session/session.ts";
import { InstrumentedStorage } from "../../../src/harness/session/testing/instrumented-storage.ts";
import type {
	CheckpointOperation,
	DurableStructuralPreparation,
	LaneConfiguration,
	NewEntry,
	OperationMeta,
	OperationScope,
	OperationState,
	Session,
	SummaryEffectPendingOperation,
	SummaryReadyOperation,
	SummaryTask,
	Write,
} from "../../../src/harness/session/types.ts";
import * as storedValues from "../../../src/harness/session/values.ts";
import { deferred } from "./test-utils.ts";

const sessions: Session[] = [];
const operationId = "01950000-0000-7000-8000-000000000001";

interface Fixture {
	lane: Lane<undefined>;
	drive: Drive;
	session: Session;
	storage: InstrumentedStorage;
	models: MutableModels;
	faux: ReturnType<typeof fauxProvider>;
	hooks: HookRegistry;
	events: HarnessEvent[];
	configuration: LaneConfiguration;
	config: Config<undefined>;
}

function unusedWatch<T>(): WatchHandle<T> {
	throw new Error("watch is not used by structural tests");
}

function runScope(compaction = DEFAULT_COMPACTION_SETTINGS): OperationScope {
	return {
		control: { status: "running" },
		settings: {
			compaction,
			steeringMode: "all",
			followUpMode: "all",
			toolExecution: "parallel",
		},
		latestAssistantEntryId: null,
	};
}

function user(content: string, timestamp = 1) {
	return { role: "user" as const, content, timestamp };
}

function standaloneCompactionTask(customInstructions?: string): SummaryTask {
	return {
		taskId: "task",
		reason: "manual",
		...(customInstructions === undefined ? {} : { customInstructions }),
		boundary: { kind: "finish" },
	};
}

function runCompactionTask(
	reason: "threshold" | "overflow",
	resumeAfter: Omit<CheckpointOperation, keyof OperationScope | "at">,
): SummaryTask {
	return { taskId: "task", reason, boundary: { kind: "resume_checkpoint", resumeAfter } };
}

function navigationSummaryTask(targetId: string, label?: string): SummaryTask {
	return {
		taskId: "task",
		boundary: { kind: "commit_navigation", targetId, ...(label === undefined ? {} : { label }) },
	};
}

function summaryReady(
	scope: OperationScope,
	task: SummaryTask,
	configuration: LaneConfiguration,
	retryPolicy = { maxAttempts: 2, baseDelayMs: 10 },
): SummaryReadyOperation {
	return {
		...scope,
		at: "summary.ready",
		task,
		summaryContext: { resultEntryId: "summary-entry", configuration, streamOptions: {}, retryPolicy },
		nextAttempt: 1,
	};
}

function compactionPreparation(
	overrides: Partial<Extract<DurableStructuralPreparation, { kind: "compaction" }>> = {},
): Extract<DurableStructuralPreparation, { kind: "compaction" }> {
	return {
		kind: "compaction",
		messagesToSummarize: [user("history")],
		turnPrefixMessages: [],
		retainedTail: [user("tail")],
		isSplitTurn: false,
		tokensBefore: 1_000,
		fileOps: { read: [], written: [], edited: [] },
		settings: { enabled: true, reserveTokens: 1_000, keepRecentTokens: 10 },
		...overrides,
	};
}

function branchPreparation(): Extract<DurableStructuralPreparation, { kind: "branch_summary" }> {
	return {
		kind: "branch_summary",
		messages: [user("abandoned")],
		fileOps: { read: [], written: [], edited: [] },
		totalTokens: 10,
	};
}

async function createFixture(): Promise<Fixture> {
	const storage = new InstrumentedStorage(new MemoryStorage({ now: () => 100 }));
	const session = new StorageBackedSession(
		{ id: `structural-${sessions.length}`, createdAt: 1, storageVersion: 1 },
		storage,
	);
	sessions.push(session);
	const faux = fauxProvider({ tokenSize: { min: 1, max: 1 } });
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
	return { lane, drive, session, storage, models, faux, hooks, events, configuration, config };
}

async function installOperation(
	fixture: Fixture,
	state: OperationState,
	intent: OperationMeta["intent"],
	options: {
		entries?: NewEntry[];
		tipId?: string | null;
		preparation?: { taskId: string; value: DurableStructuralPreparation };
	} = {},
): Promise<void> {
	const entries = options.entries ?? [];
	const tipId = options.tipId ?? entries.at(-1)?.id ?? null;
	const meta: OperationMeta = {
		operationId,
		lane: "main",
		sourceTipId: tipId,
		startedAt: 1,
		intent,
	};
	await fixture.lane.command((projection) => {
		const writes: Write[] = [
			...entries.map((entry) => insertEntry(entry)),
			storedValues.setValue(storedValues.branchTip("main"), tipId),
			storedValues.setValue(storedValues.operationMeta(operationId), meta),
			storedValues.setValue(storedValues.operationState(operationId), state),
			storedValues.setValue(storedValues.laneState("main"), {
				currentOperationId: operationId,
				lastOperationId: null,
				inbox: projection.inbox,
			}),
			...(options.preparation === undefined
				? []
				: [
						storedValues.setValue(
							storedValues.operationPreparation(operationId, options.preparation.taskId),
							options.preparation.value,
						),
					]),
		];
		return {
			kind: "commit",
			writes,
			next: { ...projection, tipId, operation: { meta, state } },
			materialize: () => undefined,
		};
	}, BACKGROUND_CONTEXT);
	fixture.storage.clearCommitAttempts();
}

function currentState(fixture: Fixture): OperationState {
	const operation = fixture.lane.state.operation;
	if (operation === null) throw new Error("fixture has no operation");
	return operation.state;
}

async function cancelOperation(fixture: Fixture): Promise<void> {
	await fixture.lane.command((projection) => {
		const operation = projection.operation;
		if (operation === null) throw new Error("fixture has no operation");
		const state: OperationState = {
			...operation.state,
			control: { status: "cancel_requested", requestedAt: 2 },
		};
		return {
			kind: "commit",
			writes: [storedValues.setValue(storedValues.operationState(operationId), state)],
			next: { ...projection, operation: { meta: operation.meta, state } },
			materialize: () => undefined,
		};
	}, BACKGROUND_CONTEXT);
}

afterEach(async () => {
	vi.useRealTimers();
	for (const session of sessions.splice(0)) await session.close(BACKGROUND_CONTEXT);
});

describe("runtime structural drive", () => {
	it("routes a declined threshold directly to assistant generation", async () => {
		const fixture = await createFixture();
		const model = fixture.faux.getModel();
		const settings = {
			enabled: true,
			reserveTokens: model.contextWindow,
			keepRecentTokens: 1,
		};
		const checkpoint: CheckpointOperation = {
			...runScope(settings),
			at: "checkpoint",
			continuation: { kind: "need_assistant", overflowRecoveryUsed: false },
			triggerEntryId: "assistant",
		};
		await installOperation(
			fixture,
			checkpoint,
			{ kind: "run", promptEntryIds: ["user"] },
			{
				entries: [
					{ id: "user", parentId: null, type: "message", message: user("question") },
					{ id: "assistant", parentId: "user", type: "message", message: fauxAssistantMessage("answer") },
				],
			},
		);

		expect(await runCheckpoint(fixture.lane, fixture.drive, checkpoint)).toEqual({ kind: "continue" });
		const deciding = currentState(fixture);
		if (deciding.at !== "summary.deciding") throw new Error("threshold did not enter compaction");
		if (deciding.task.boundary.kind !== "resume_checkpoint") throw new Error("threshold has wrong boundary");
		expect(
			await fixture.session.getValue(
				storedValues.operationPreparation(operationId, deciding.task.taskId),
				BACKGROUND_CONTEXT,
			),
		).toBeDefined();

		fixture.hooks.on("before_compaction", () => ({ decline: true }));
		expect(await runStructuralDecision(fixture.lane, fixture.drive, deciding)).toEqual({ kind: "continue" });
		const routed = currentState(fixture);
		if (routed.at !== "assistant.ready") throw new Error("threshold decline did not route to generation");
		expect(routed.generationContext).toMatchObject({
			triggerEntryId: "assistant",
			overflowRecoveryUsed: false,
		});
		expect(fixture.events.filter((event) => event.type === "compaction_start")).toHaveLength(1);
		expect(fixture.events.filter((event) => event.type === "compaction_end")).toHaveLength(1);
	});

	it("uses a newer compaction entry as the durable threshold guard", async () => {
		const fixture = await createFixture();
		const model = fixture.faux.getModel();
		const checkpoint: CheckpointOperation = {
			...runScope({ enabled: true, reserveTokens: model.contextWindow, keepRecentTokens: 1 }),
			at: "checkpoint",
			continuation: { kind: "need_assistant", overflowRecoveryUsed: false },
			triggerEntryId: "trigger",
		};
		await installOperation(
			fixture,
			checkpoint,
			{ kind: "run", promptEntryIds: ["trigger"] },
			{
				entries: [
					{ id: "trigger", parentId: null, type: "message", message: user("history") },
					{
						id: "compacted",
						parentId: "trigger",
						type: "compaction",
						summary: "already compacted",
						retainedTail: [],
						tokensBefore: model.contextWindow,
						fromHook: false,
					},
				],
			},
		);

		expect(await runCheckpoint(fixture.lane, fixture.drive, checkpoint)).toEqual({ kind: "continue" });
		const ready = currentState(fixture);
		if (ready.at !== "assistant.ready") throw new Error("newer compaction did not guard threshold re-entry");
		expect(ready.generationContext.triggerEntryId).toBe("trigger");
		expect(fixture.events.some((event) => event.type === "compaction_start")).toBe(false);
	});

	it("rejects a missing threshold trigger when no newer compaction guards it", async () => {
		const fixture = await createFixture();
		const model = fixture.faux.getModel();
		const checkpoint: CheckpointOperation = {
			...runScope({ enabled: true, reserveTokens: model.contextWindow, keepRecentTokens: 1 }),
			at: "checkpoint",
			continuation: { kind: "need_assistant", overflowRecoveryUsed: false },
			triggerEntryId: "missing-trigger",
		};
		await installOperation(
			fixture,
			checkpoint,
			{ kind: "run", promptEntryIds: [] },
			{
				entries: [{ id: "tip", parentId: null, type: "message", message: user("history") }],
			},
		);

		await expect(runCheckpoint(fixture.lane, fixture.drive, checkpoint)).rejects.toThrow(
			"Checkpoint trigger missing-trigger is missing from its Branch",
		);
	});

	it("finishes a may-finish run directly after threshold decline", async () => {
		const fixture = await createFixture();
		const deciding = {
			...runScope(),
			at: "summary.deciding",
			task: runCompactionTask("threshold", {
				continuation: { kind: "may_finish", includeFinalAssistant: false },
				triggerEntryId: "tip",
			}),
		} as const;
		await installOperation(
			fixture,
			deciding,
			{ kind: "run", promptEntryIds: ["tip"] },
			{
				entries: [{ id: "tip", parentId: null, type: "message", message: user("history") }],
				preparation: { taskId: "task", value: compactionPreparation() },
			},
		);
		let finishHooks = 0;
		fixture.hooks.on("before_compaction", () => ({ decline: true }));
		fixture.hooks.on("before_run_end", () => {
			finishHooks++;
			return undefined;
		});

		expect(await runStructuralDecision(fixture.lane, fixture.drive, deciding)).toMatchObject({
			kind: "settled",
			outcome: { operationId, kind: "run", status: "completed", tipId: "tip" },
		});
		expect(fixture.storage.getCommitAttempts()).toHaveLength(1);
		expect(finishHooks).toBe(1);
		expect(fixture.lane.state.operation).toBeNull();
		expect(fixture.events.slice(-2)).toMatchObject([
			{ type: "compaction_end", reason: "threshold", status: "declined" },
			{ type: "run_end", status: "completed" },
		]);
	});

	it("routes queued follow-up before before_run_end after threshold decline", async () => {
		const fixture = await createFixture();
		const deciding = {
			...runScope(),
			at: "summary.deciding",
			task: runCompactionTask("threshold", {
				continuation: { kind: "may_finish", includeFinalAssistant: false },
				triggerEntryId: "tip",
			}),
		} as const;
		await installOperation(
			fixture,
			deciding,
			{ kind: "run", promptEntryIds: ["tip"] },
			{
				entries: [{ id: "tip", parentId: null, type: "message", message: user("history") }],
				preparation: { taskId: "task", value: compactionPreparation() },
			},
		);
		await fixture.lane.command((projection) => {
			const inbox = [...projection.inbox, { entryId: "follow-up", kind: "followUp" as const }];
			return {
				kind: "commit",
				writes: [
					storedValues.setValue(storedValues.pendingEntry("follow-up"), {
						type: "message",
						payload: user("continue"),
					}),
					storedValues.setValue(storedValues.laneState("main"), {
						currentOperationId: operationId,
						lastOperationId: null,
						inbox,
					}),
				],
				next: { ...projection, inbox },
				materialize: () => undefined,
			};
		}, BACKGROUND_CONTEXT);
		fixture.storage.clearCommitAttempts();
		let finishHooks = 0;
		fixture.hooks.on("before_compaction", () => ({ decline: true }));
		fixture.hooks.on("before_run_end", () => {
			finishHooks++;
			return undefined;
		});

		expect(await runStructuralDecision(fixture.lane, fixture.drive, deciding)).toEqual({ kind: "continue" });
		expect(fixture.storage.getCommitAttempts()).toHaveLength(1);
		expect(finishHooks).toBe(0);
		const ready = currentState(fixture);
		if (ready.at !== "assistant.ready") throw new Error("follow-up did not route to generation");
		expect(ready.generationContext.triggerEntryId).toBe("follow-up");
		expect(fixture.events.map((event) => event.type)).toContain("compaction_end");
	});

	it.each(["steer", "followUp"] as const)(
		"continues to an assistant turn when %s arrives during in-run compaction",
		async (queue) => {
			const fixture = await createFixture();
			const deciding = {
				...runScope(),
				at: "summary.deciding",
				task: runCompactionTask("threshold", {
					continuation: { kind: "may_finish", includeFinalAssistant: true },
					triggerEntryId: "tip",
				}),
			} as const;
			await installOperation(
				fixture,
				deciding,
				{ kind: "run", promptEntryIds: ["tip"] },
				{
					entries: [{ id: "tip", parentId: null, type: "message", message: user("history") }],
					preparation: { taskId: "task", value: compactionPreparation() },
				},
			);
			const hookStarted = deferred();
			const releaseHook = deferred();
			fixture.hooks.on("before_compaction", async () => {
				hookStarted.resolve();
				await releaseHook.promise;
				return {
					compaction: {
						summary: "hook summary",
						tokensBefore: 1_000,
						retainedTail: [user("tail")],
					},
				};
			});
			const running = runStructuralDecision(fixture.lane, fixture.drive, deciding);
			await hookStarted.promise;
			await fixture.lane.command((projection) => {
				const operation = projection.operation;
				if (operation?.state.at !== "summary.deciding") throw new Error("missing run compaction");
				const inbox = [...projection.inbox, { entryId: "queued", kind: queue }];
				return {
					kind: "commit",
					writes: [
						storedValues.setValue(storedValues.pendingEntry("queued"), {
							type: "message",
							payload: user(`${queue} during compaction`),
						}),
						storedValues.setValue(storedValues.laneState("main"), {
							currentOperationId: operationId,
							lastOperationId: null,
							inbox,
						}),
					],
					next: { ...projection, inbox },
					materialize: () => undefined,
				};
			}, BACKGROUND_CONTEXT);
			releaseHook.resolve();
			expect(await running).toEqual({ kind: "continue" });

			const routed = currentState(fixture);
			if (queue === "steer") {
				if (routed.at !== "assistant.ready") throw new Error("steer did not route directly to generation");
				expect(routed.generationContext).toMatchObject({
					triggerEntryId: "queued",
					overflowRecoveryUsed: false,
				});
				expect(fixture.lane.state.inbox).toEqual([]);
				expect(
					await fixture.session.getValue(storedValues.pendingEntry("queued"), BACKGROUND_CONTEXT),
				).toBeUndefined();
				const entry = await fixture.session.getEntry("queued", BACKGROUND_CONTEXT);
				expect(entry).toMatchObject({ parentId: expect.any(String), type: "message" });
				expect((await fixture.session.getEntry(entry!.parentId!, BACKGROUND_CONTEXT))?.type).toBe("compaction");
			} else {
				if (routed.at !== "checkpoint") throw new Error("follow-up did not reach the finish checkpoint");
				expect(fixture.lane.state.inbox).toEqual([{ entryId: "queued", kind: "followUp" }]);
				expect(await runCheckpoint(fixture.lane, fixture.drive, routed)).toEqual({ kind: "continue" });
				const ready = currentState(fixture);
				if (ready.at !== "assistant.ready") throw new Error("follow-up did not route directly to generation");
				expect(ready.generationContext).toMatchObject({
					triggerEntryId: "queued",
					overflowRecoveryUsed: false,
				});
				expect(fixture.lane.state.inbox).toEqual([]);
			}
		},
	);

	it("publishes structural output and mixed write/steer input in one admission-ordered commit", async () => {
		const fixture = await createFixture();
		const scope = runScope();
		const deciding = {
			...scope,
			settings: { ...scope.settings, steeringMode: "one-at-a-time" },
			at: "summary.deciding",
			task: runCompactionTask("threshold", {
				continuation: { kind: "need_assistant", overflowRecoveryUsed: false },
				triggerEntryId: "tip",
			}),
		} as const;
		await installOperation(
			fixture,
			deciding,
			{ kind: "run", promptEntryIds: ["tip"] },
			{
				entries: [{ id: "tip", parentId: null, type: "message", message: user("history") }],
				preparation: { taskId: "task", value: compactionPreparation() },
			},
		);
		await fixture.lane.command((projection) => {
			const inbox = [
				{ entryId: "write-1", kind: "write" as const },
				{ entryId: "steer", kind: "steer" as const },
				{ entryId: "write-2", kind: "write" as const },
				{ entryId: "steer-2", kind: "steer" as const },
			];
			return {
				kind: "commit",
				writes: [
					storedValues.setValue(storedValues.pendingEntry("write-1"), {
						type: "custom",
						customType: "note",
						payload: { order: 1 },
					}),
					storedValues.setValue(storedValues.pendingEntry("steer"), {
						type: "message",
						payload: user("steer"),
					}),
					storedValues.setValue(storedValues.pendingEntry("write-2"), {
						type: "custom",
						customType: "note",
						payload: { order: 2 },
					}),
					storedValues.setValue(storedValues.pendingEntry("steer-2"), {
						type: "message",
						payload: user("next steer"),
					}),
					storedValues.setValue(storedValues.laneState("main"), {
						currentOperationId: operationId,
						lastOperationId: null,
						inbox,
					}),
				],
				next: { ...projection, inbox },
				materialize: () => undefined,
			};
		}, BACKGROUND_CONTEXT);
		fixture.storage.clearCommitAttempts();
		fixture.hooks.on("before_compaction", () => ({
			compaction: { summary: "summary", tokensBefore: 1_000, retainedTail: [user("tail")] },
		}));

		expect(await runStructuralDecision(fixture.lane, fixture.drive, deciding)).toEqual({ kind: "continue" });
		expect(fixture.storage.getCommitAttempts()).toHaveLength(1);
		expect(fixture.lane.state.inbox).toEqual([{ entryId: "steer-2", kind: "steer" }]);
		expect(await fixture.session.getValue(storedValues.pendingEntry("steer-2"), BACKGROUND_CONTEXT)).toBeDefined();
		const routed = currentState(fixture);
		if (routed.at !== "assistant.ready") throw new Error("mixed input did not route to generation");
		expect(routed.generationContext.triggerEntryId).toBe("steer");
		expect(await fixture.session.getEntry("write-1", BACKGROUND_CONTEXT)).toMatchObject({
			parentId: expect.any(String),
		});
		expect(await fixture.session.getEntry("steer", BACKGROUND_CONTEXT)).toMatchObject({ parentId: "write-1" });
		expect(await fixture.session.getEntry("write-2", BACKGROUND_CONTEXT)).toMatchObject({ parentId: "steer" });
		expect(fixture.lane.state.tipId).toBe("write-2");
	});

	it("queues writes during standalone structural work without changing the operation", async () => {
		const fixture = await createFixture();
		const deciding = {
			...runScope(),
			at: "summary.deciding",
			task: standaloneCompactionTask(),
		} as const;
		await installOperation(
			fixture,
			deciding,
			{ kind: "compaction" },
			{
				entries: [{ id: "tip", parentId: null, type: "message", message: user("history") }],
				preparation: { taskId: "task", value: compactionPreparation() },
			},
		);

		const entryId = await fixture.lane.appendCustomEntry("note", { pending: true }, BACKGROUND_CONTEXT);

		expect(currentState(fixture)).toEqual(deciding);
		expect(fixture.lane.state.tipId).toBe("tip");
		expect(fixture.lane.state.inbox).toEqual([{ entryId, kind: "write" }]);
		expect((await fixture.session.getValue(storedValues.laneState("main"), BACKGROUND_CONTEXT))?.value).toEqual({
			currentOperationId: operationId,
			lastOperationId: null,
			inbox: [{ entryId, kind: "write" }],
		});
		expect(await fixture.session.getValue(storedValues.pendingEntry(entryId), BACKGROUND_CONTEXT)).toBeDefined();
		expect(fixture.events.at(-1)).toMatchObject({
			type: "queue_update",
			queues: [{ entryId, kind: "write", type: "custom" }],
		});
	});

	it("publishes overflow preparation with the normalized response settlement", async () => {
		const fixture = await createFixture();
		const ready = {
			...runScope({ enabled: true, reserveTokens: 1_000, keepRecentTokens: 1 }),
			at: "assistant.ready",
			generationContext: {
				stepId: "step",
				triggerEntryId: "tip",
				configuration: fixture.configuration,
				streamOptions: {},
				retryPolicy: { maxAttempts: 2, baseDelayMs: 10 },
				overflowRecoveryUsed: false,
			},
			nextAttempt: 1,
		} as const;
		await installOperation(
			fixture,
			ready,
			{ kind: "run", promptEntryIds: ["tip"] },
			{
				entries: [{ id: "tip", parentId: null, type: "message", message: user("large prompt") }],
			},
		);
		fixture.faux.setResponses([
			fauxAssistantMessage("", {
				stopReason: "error",
				errorMessage: "prompt exceeds the context window",
			}),
		]);

		expect(await runGeneration(fixture.lane, fixture.drive, ready)).toEqual({ kind: "continue" });
		const deciding = currentState(fixture);
		if (deciding.at !== "summary.deciding") throw new Error("overflow did not enter compaction");
		expect(deciding.task.reason).toBe("overflow");
		if (deciding.task.boundary.kind !== "resume_checkpoint") throw new Error("overflow has wrong boundary");
		expect(deciding.task.boundary.resumeAfter).toMatchObject({
			continuation: { kind: "need_assistant", overflowRecoveryUsed: true },
			triggerEntryId: "tip",
		});
		expect(
			await fixture.session.getValue(
				storedValues.operationPreparation(operationId, deciding.task.taskId),
				BACKGROUND_CONTEXT,
			),
		).toBeDefined();
		const response = await fixture.session.getEntry(fixture.lane.state.tipId!, BACKGROUND_CONTEXT);
		expect(response).toMatchObject({ type: "message", message: { stopReason: "error" } });
		expect(fixture.events.map((event) => event.type)).toContain("compaction_start");
	});

	it("publishes a hook compaction and terminal cleanup atomically without assistant lifecycle", async () => {
		const fixture = await createFixture();
		const deciding = {
			...runScope(),
			at: "summary.deciding",
			task: { taskId: "task", customInstructions: "focus", boundary: { kind: "finish" } },
		} as const;
		await installOperation(
			fixture,
			deciding,
			{ kind: "compaction", customInstructions: "focus" },
			{
				entries: [{ id: "tip", parentId: null, type: "message", message: user("history") }],
				preparation: { taskId: "task", value: compactionPreparation() },
			},
		);
		const queuedId = await fixture.lane.appendCustomEntry("retained", { after: "compaction" }, BACKGROUND_CONTEXT);
		fixture.hooks.on("before_compaction", () => ({
			compaction: {
				summary: "hook summary",
				tokensBefore: 1_000,
				retainedTail: [user("tail")],
				details: { source: "hook" },
			},
		}));

		const result = await runStructuralDecision(fixture.lane, fixture.drive, deciding);
		expect(result).toMatchObject({
			kind: "settled",
			outcome: { operationId, kind: "compaction", status: "completed" },
		});
		expect(fixture.lane.state.operation).toBeNull();
		expect(fixture.lane.state.inbox).toEqual([{ entryId: queuedId, kind: "write" }]);
		expect(await fixture.session.getValue(storedValues.pendingEntry(queuedId), BACKGROUND_CONTEXT)).toBeDefined();
		const entry = await fixture.session.getEntry(fixture.lane.state.tipId!, BACKGROUND_CONTEXT);
		expect(entry).toMatchObject({
			type: "compaction",
			summary: "hook summary",
			fromHook: true,
			seq: expect.any(Number),
			timestamp: 100,
		});
		expect(
			await fixture.session.getValue(storedValues.operationMeta(operationId), BACKGROUND_CONTEXT),
		).toBeUndefined();
		expect(
			await fixture.session.getValue(storedValues.operationPreparation(operationId, "task"), BACKGROUND_CONTEXT),
		).toBeUndefined();
		expect(fixture.events.some((event) => event.type === "message_start" || event.type === "message_end")).toBe(
			false,
		);
		expect(fixture.events.map((event) => event.type)).toContain("entry_added");
		expect(fixture.events.at(-1)).toMatchObject({ type: "compaction_end", reason: "manual", status: "completed" });
	});

	it("terminal-declines standalone compaction without publishing an entry", async () => {
		const fixture = await createFixture();
		const deciding = { ...runScope(), at: "summary.deciding", task: standaloneCompactionTask() } as const;
		await installOperation(
			fixture,
			deciding,
			{ kind: "compaction" },
			{
				entries: [{ id: "tip", parentId: null, type: "message", message: user("history") }],
				preparation: { taskId: "task", value: compactionPreparation() },
			},
		);
		fixture.hooks.on("before_compaction", () => ({ decline: true }));

		expect(await runStructuralDecision(fixture.lane, fixture.drive, deciding)).toMatchObject({
			kind: "settled",
			outcome: { operationId, kind: "compaction", status: "declined", tipId: "tip" },
		});
		expect(fixture.lane.state.operation).toBeNull();
		expect(fixture.lane.state.tipId).toBe("tip");
		expect(fixture.events.at(-1)).toMatchObject({ type: "compaction_end", status: "declined" });
	});

	it("terminal-fails overflow decline while preserving lane-owned input", async () => {
		const fixture = await createFixture();
		const deciding = {
			...runScope(),
			at: "summary.deciding",
			task: runCompactionTask("overflow", {
				continuation: { kind: "need_assistant", overflowRecoveryUsed: true },
				triggerEntryId: "tip",
			}),
		} as const;
		await installOperation(
			fixture,
			deciding,
			{ kind: "run", promptEntryIds: ["tip"] },
			{
				entries: [{ id: "tip", parentId: null, type: "message", message: user("history") }],
				preparation: { taskId: "task", value: compactionPreparation() },
			},
		);
		const queuedId = await fixture.lane.appendCustomEntry("retained", { value: true }, BACKGROUND_CONTEXT);
		fixture.hooks.on("before_compaction", () => ({ decline: true }));

		expect(await runStructuralDecision(fixture.lane, fixture.drive, deciding)).toMatchObject({
			kind: "settled",
			outcome: { operationId, kind: "run", status: "failed", error: { code: "compaction_declined" } },
		});
		expect(fixture.lane.state.inbox).toEqual([{ entryId: queuedId, kind: "write" }]);
		expect(await fixture.session.getValue(storedValues.pendingEntry(queuedId), BACKGROUND_CONTEXT)).toBeDefined();
		expect(fixture.events.slice(-2)).toMatchObject([
			{ type: "compaction_end", status: "declined" },
			{ type: "run_end", status: "failed" },
		]);
	});

	it("gives each split-turn provider request its own durable intent and usage row", async () => {
		const fixture = await createFixture();
		const ready = summaryReady(runScope(), standaloneCompactionTask(), fixture.configuration);
		await installOperation(
			fixture,
			ready,
			{ kind: "compaction" },
			{
				entries: [{ id: "tip", parentId: null, type: "message", message: user("history") }],
				preparation: {
					taskId: "task",
					value: compactionPreparation({
						messagesToSummarize: [user("old history")],
						turnPrefixMessages: [user("large turn")],
						isSplitTurn: true,
					}),
				},
			},
		);
		fixture.faux.setResponses([fauxAssistantMessage("history summary"), fauxAssistantMessage("turn prefix summary")]);

		const result = await runStructuralGeneration(fixture.lane, fixture.drive, ready);
		expect(result).toMatchObject({
			kind: "settled",
			outcome: { operationId, kind: "compaction", status: "completed" },
		});
		const attempts = fixture.storage.getCommitAttempts();
		const requestIndices = attempts.flatMap((writes) =>
			writes.flatMap((write) =>
				write.kind === "value" &&
				write.op === "set" &&
				write.namespace === "pi.op.state" &&
				typeof write.value === "object" &&
				write.value !== null &&
				"request" in write.value &&
				typeof write.value.request === "object" &&
				write.value.request !== null &&
				"index" in write.value.request &&
				typeof write.value.request.index === "number"
					? [write.value.request.index]
					: [],
			),
		);
		expect(requestIndices).toEqual([0, 1]);
		expect(attempts.flat().filter((write) => write.kind === "usage")).toHaveLength(2);
		expect(
			attempts.flat().some((write) => write.kind === "list" && write.namespace === "pi.pending.assistant_frame"),
		).toBe(false);
		expect(
			fixture.events.some((event) => ["message_start", "message_update", "message_end"].includes(event.type)),
		).toBe(false);
		expect(fixture.events.filter((event) => event.type === "usage")).toHaveLength(2);
	});

	it("preserves the overflow recovery bound when compaction resumes generation", async () => {
		const fixture = await createFixture();
		const resumeAfter: CheckpointOperation = {
			...runScope(),
			at: "checkpoint",
			continuation: { kind: "need_assistant", overflowRecoveryUsed: false },
			triggerEntryId: "tip",
		};
		const ready = summaryReady(
			runScope(),
			runCompactionTask("overflow", {
				continuation: { kind: "need_assistant", overflowRecoveryUsed: true },
				triggerEntryId: resumeAfter.triggerEntryId,
			}),
			fixture.configuration,
		);
		await installOperation(
			fixture,
			ready,
			{ kind: "run", promptEntryIds: ["tip"] },
			{
				entries: [{ id: "tip", parentId: null, type: "message", message: user("history") }],
				preparation: { taskId: "task", value: compactionPreparation() },
			},
		);
		fixture.faux.setResponses([fauxAssistantMessage("generated summary")]);

		expect(await runStructuralGeneration(fixture.lane, fixture.drive, ready)).toEqual({ kind: "continue" });
		const routed = currentState(fixture);
		if (routed.at !== "assistant.ready") throw new Error("generated compaction did not route to generation");
		expect(routed.generationContext).toMatchObject({
			triggerEntryId: "tip",
			overflowRecoveryUsed: true,
		});
		expect(fixture.lane.state.tipId).toBe("summary-entry");
		const entry = await fixture.session.getEntry("summary-entry", BACKGROUND_CONTEXT);
		expect(entry).toMatchObject({ type: "compaction", summary: "generated summary", fromHook: false });
	});

	it("settles structural usage without faulting when durable cancellation aborts the request", async () => {
		const fixture = await createFixture();
		const ready = summaryReady(runScope(), standaloneCompactionTask(), fixture.configuration);
		await installOperation(
			fixture,
			ready,
			{ kind: "compaction" },
			{
				entries: [{ id: "tip", parentId: null, type: "message", message: user("history") }],
				preparation: { taskId: "task", value: compactionPreparation() },
			},
		);
		const started = deferred();
		const release = deferred();
		fixture.faux.setResponses([
			async (_context, options) => {
				started.resolve();
				await release.promise;
				return fauxAssistantMessage("", {
					stopReason: options?.signal?.aborted ? "aborted" : "stop",
					errorMessage: options?.signal?.aborted ? "cancelled" : undefined,
				});
			},
		]);

		const running = runStructuralGeneration(fixture.lane, fixture.drive, ready);
		await started.promise;
		const cancellation = deferred();
		fixture.drive.beginAbort(cancellation.promise);
		await cancelOperation(fixture);
		cancellation.resolve();
		fixture.drive.signalAbort();
		release.resolve();

		expect(await running).toEqual({ kind: "continue" });
		const cancelled = currentState(fixture);
		if (cancelled.at !== "summary.effect_pending") {
			throw new Error("cancelled generation did not remain effect-pending for reconciliation");
		}
		expect(cancelled.control.status).toBe("cancel_requested");
		expect(cancelled.request).toBeUndefined();
		expect(cancelled.usageIds).toHaveLength(1);
		expect(
			fixture.storage
				.getCommitAttempts()
				.flat()
				.filter((write) => write.kind === "usage"),
		).toHaveLength(1);
	});

	it("fails missing in-run structural models with configuration provenance", async () => {
		const fixture = await createFixture();
		const ready = summaryReady(
			runScope(),
			runCompactionTask("threshold", {
				continuation: { kind: "need_assistant", overflowRecoveryUsed: false },
				triggerEntryId: "tip",
			}),
			{ ...fixture.configuration, model: { provider: "missing", modelId: "missing" } },
		);
		await installOperation(
			fixture,
			ready,
			{ kind: "run", promptEntryIds: ["tip"] },
			{
				entries: [{ id: "tip", parentId: null, type: "message", message: user("history") }],
				preparation: { taskId: "task", value: compactionPreparation() },
			},
		);

		expect(await runStructuralGeneration(fixture.lane, fixture.drive, ready)).toMatchObject({
			kind: "settled",
			outcome: { operationId, kind: "run", status: "failed", error: { code: "model_unavailable" } },
		});
		expect(fixture.lane.state.operation).toBeNull();
		expect(
			fixture.storage
				.getCommitAttempts()
				.flat()
				.some((write) => write.kind === "usage"),
		).toBe(false);

		const standalone = await createFixture();
		const standaloneReady = summaryReady(runScope(), standaloneCompactionTask(), {
			...standalone.configuration,
			model: { provider: "missing", modelId: "missing" },
		});
		await installOperation(
			standalone,
			standaloneReady,
			{ kind: "compaction" },
			{
				entries: [{ id: "standalone-tip", parentId: null, type: "message", message: user("history") }],
				preparation: { taskId: "task", value: compactionPreparation() },
			},
		);
		expect(await runStructuralGeneration(standalone.lane, standalone.drive, standaloneReady)).toMatchObject({
			kind: "settled",
			outcome: { operationId, kind: "compaction", status: "failed", error: { code: "model_unavailable" } },
		});
		expect(standalone.lane.state.operation).toBeNull();
	});

	it("durably brackets a delayed structural retry through success", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(1_000);
		const fixture = await createFixture();
		const ready = summaryReady(runScope(), standaloneCompactionTask(), fixture.configuration, {
			maxAttempts: 2,
			baseDelayMs: 10,
		});
		await installOperation(
			fixture,
			ready,
			{ kind: "compaction" },
			{
				entries: [{ id: "tip", parentId: null, type: "message", message: user("history") }],
				preparation: { taskId: "task", value: compactionPreparation() },
			},
		);
		fixture.faux.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "rate limit exceeded" }),
		]);

		expect(await runStructuralGeneration(fixture.lane, fixture.drive, ready)).toEqual({ kind: "continue" });
		const retry = currentState(fixture);
		if (retry.at !== "summary.retry_wait") throw new Error("retryable failure did not wait");
		expect(retry.nextAttempt).toBe(2);
		expect(await runStructuralRetryWait(fixture.lane, fixture.drive, retry)).toEqual({
			kind: "waiting",
			outcome: {
				kind: "waiting",
				operationId,
				reason: "retry",
				notBefore: retry.notBefore,
			},
		});
		vi.setSystemTime(retry.notBefore);
		expect(await runStructuralRetryWait(fixture.lane, fixture.drive, retry)).toEqual({ kind: "continue" });
		const second = currentState(fixture);
		if (second.at !== "summary.ready") throw new Error("elapsed retry did not become ready");
		fixture.faux.setResponses([fauxAssistantMessage("summary")]);
		expect(await runStructuralGeneration(fixture.lane, fixture.drive, second)).toMatchObject({
			kind: "settled",
			outcome: { status: "completed" },
		});
		expect(
			fixture.events
				.filter((event) => event.type.startsWith("retry_"))
				.map((event) => ({ type: event.type, ...("success" in event ? { success: event.success } : {}) })),
		).toEqual([{ type: "retry_scheduled" }, { type: "retry_start" }, { type: "retry_end", success: true }]);
	});

	it("closes an exhausted structural retry with its final error", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(2_000);
		const fixture = await createFixture();
		const ready = summaryReady(runScope(), standaloneCompactionTask(), fixture.configuration, {
			maxAttempts: 2,
			baseDelayMs: 10,
		});
		await installOperation(
			fixture,
			ready,
			{ kind: "compaction" },
			{
				entries: [{ id: "tip", parentId: null, type: "message", message: user("history") }],
				preparation: { taskId: "task", value: compactionPreparation() },
			},
		);
		fixture.faux.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "rate limit exceeded" }),
		]);
		await runStructuralGeneration(fixture.lane, fixture.drive, ready);
		const retry = currentState(fixture);
		if (retry.at !== "summary.retry_wait") throw new Error("retryable failure did not wait");
		vi.setSystemTime(retry.notBefore);
		await runStructuralRetryWait(fixture.lane, fixture.drive, retry);
		const second = currentState(fixture);
		if (second.at !== "summary.ready") throw new Error("elapsed retry did not become ready");
		fixture.faux.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "rate limit exceeded" }),
		]);

		expect(await runStructuralGeneration(fixture.lane, fixture.drive, second)).toMatchObject({
			kind: "settled",
			outcome: { status: "failed" },
		});
		expect(fixture.events.filter((event) => event.type === "retry_end")).toMatchObject([
			{ attempt: 2, success: false, finalError: expect.stringContaining("rate limit exceeded") },
		]);
	});

	it("finishes a standalone structural failure at the retry cap", async () => {
		const fixture = await createFixture();
		const ready = summaryReady(runScope(), standaloneCompactionTask(), fixture.configuration, {
			maxAttempts: 1,
			baseDelayMs: 10,
		});
		await installOperation(
			fixture,
			ready,
			{ kind: "compaction" },
			{
				entries: [{ id: "tip", parentId: null, type: "message", message: user("history") }],
				preparation: { taskId: "task", value: compactionPreparation() },
			},
		);
		fixture.faux.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "rate limit exceeded" }),
		]);

		const result = await runStructuralGeneration(fixture.lane, fixture.drive, ready);
		expect(result).toMatchObject({
			kind: "settled",
			outcome: { operationId, kind: "compaction", status: "failed", error: { code: "summarization_failed" } },
		});
		expect(fixture.lane.state.operation).toBeNull();
		expect(fixture.events.map((event) => event.type)).not.toContain("retry_scheduled");
	});

	it("rejects invalid unsummarized navigation state without committing", async () => {
		for (const invalid of ["missing", "source", "root_label"] as const) {
			const fixture = await createFixture();
			const targetId = invalid === "missing" ? "missing" : invalid === "source" ? "source" : null;
			const navigation = {
				...runScope(),
				at: "navigation.ready_to_commit",
				targetId,
				...(invalid === "root_label" ? { label: "invalid" } : {}),
			} as const;
			await installOperation(
				fixture,
				navigation,
				{
					kind: "navigation",
					targetId,
					summarize: false,
					...(invalid === "root_label" ? { label: "invalid" } : {}),
				},
				{
					entries: [{ id: "source", parentId: null, type: "message", message: user("source") }],
					tipId: "source",
				},
			);

			await expect(commitNavigation(fixture.lane, fixture.drive, navigation)).rejects.toThrow();
			expect(fixture.storage.getCommitAttempts()).toEqual([]);
			expect(fixture.lane.state.tipId).toBe("source");
		}
	});

	it("moves an unsummarized navigation and cleans up in one terminal transaction", async () => {
		const fixture = await createFixture();
		const navigation = {
			...runScope(),
			at: "navigation.ready_to_commit",
			targetId: "target",
			label: "chosen",
		} as const;
		await installOperation(
			fixture,
			navigation,
			{ kind: "navigation", targetId: "target", summarize: false, label: "chosen" },
			{
				entries: [
					{ id: "root", parentId: null, type: "message", message: user("root") },
					{ id: "source", parentId: "root", type: "message", message: user("source") },
					{ id: "target", parentId: "root", type: "message", message: user("target") },
				],
				tipId: "source",
			},
		);
		const result = await commitNavigation(fixture.lane, fixture.drive, navigation);
		expect(result).toMatchObject({
			kind: "settled",
			outcome: {
				operationId,
				kind: "navigation",
				status: "completed",
				fromTipId: "source",
				tipId: "target",
			},
		});
		expect(fixture.lane.state.tipId).toBe("target");
		expect(await fixture.session.getLabel("target", BACKGROUND_CONTEXT)).toBe("chosen");
		const writes = fixture.storage.getCommitAttempts().at(-1)!;
		expect(
			writes.some((write) => write.kind === "value" && write.namespace === "pi.op.state" && write.op === "delete"),
		).toBe(true);
		expect(writes.some((write) => write.kind === "value" && write.namespace === "pi.result")).toBe(true);
		expect(writes.some((write) => write.kind === "value" && write.namespace === "pi.lane.state")).toBe(true);
	});

	it("publishes a hook navigation summary with the target parent and source identity", async () => {
		const fixture = await createFixture();
		const deciding = {
			...runScope(),
			at: "summary.deciding",
			task: navigationSummaryTask("target"),
		} as const;
		await installOperation(
			fixture,
			deciding,
			{ kind: "navigation", targetId: "target", summarize: true },
			{
				entries: [
					{ id: "root", parentId: null, type: "message", message: user("root") },
					{ id: "source", parentId: "root", type: "message", message: user("source") },
					{ id: "target", parentId: "root", type: "message", message: user("target") },
				],
				tipId: "source",
				preparation: { taskId: "task", value: branchPreparation() },
			},
		);
		fixture.hooks.on("before_navigation", () => ({
			summary: { summary: "branch summary", readFiles: ["read.ts"], modifiedFiles: ["edit.ts"] },
		}));

		const result = await runStructuralDecision(fixture.lane, fixture.drive, deciding);
		expect(result).toMatchObject({
			kind: "settled",
			outcome: { operationId, kind: "navigation", status: "completed" },
		});
		const entry = await fixture.session.getEntry(fixture.lane.state.tipId!, BACKGROUND_CONTEXT);
		expect(entry).toMatchObject({
			type: "branch_summary",
			parentId: "target",
			fromId: "source",
			summary: "branch summary",
			fromHook: true,
		});
	});

	it("terminal-declines summarized navigation without moving the tip", async () => {
		const fixture = await createFixture();
		const deciding = { ...runScope(), at: "summary.deciding", task: navigationSummaryTask("target") } as const;
		await installOperation(
			fixture,
			deciding,
			{ kind: "navigation", targetId: "target", summarize: true },
			{
				entries: [
					{ id: "root", parentId: null, type: "message", message: user("root") },
					{ id: "source", parentId: "root", type: "message", message: user("source") },
					{ id: "target", parentId: "root", type: "message", message: user("target") },
				],
				tipId: "source",
				preparation: { taskId: "task", value: branchPreparation() },
			},
		);
		fixture.hooks.on("before_navigation", () => ({ decline: true }));

		expect(await runStructuralDecision(fixture.lane, fixture.drive, deciding)).toMatchObject({
			kind: "settled",
			outcome: { operationId, kind: "navigation", status: "declined", tipId: "source" },
		});
		expect(fixture.lane.state.tipId).toBe("source");
		expect(fixture.events.at(-1)).toMatchObject({ type: "navigation_end", status: "declined" });
	});

	it("generates and atomically publishes a navigation summary", async () => {
		const fixture = await createFixture();
		const ready = summaryReady(runScope(), navigationSummaryTask("target"), fixture.configuration);
		await installOperation(
			fixture,
			ready,
			{ kind: "navigation", targetId: "target", summarize: true },
			{
				entries: [
					{ id: "root", parentId: null, type: "message", message: user("root") },
					{ id: "source", parentId: "root", type: "message", message: user("source") },
					{ id: "target", parentId: "root", type: "message", message: user("target") },
				],
				tipId: "source",
				preparation: { taskId: "task", value: branchPreparation() },
			},
		);
		fixture.faux.setResponses([fauxAssistantMessage("generated branch summary")]);

		const result = await runStructuralGeneration(fixture.lane, fixture.drive, ready);
		expect(result).toMatchObject({
			kind: "settled",
			outcome: {
				operationId,
				kind: "navigation",
				status: "completed",
				fromTipId: "source",
				tipId: "summary-entry",
			},
		});
		const entry = await fixture.session.getEntry("summary-entry", BACKGROUND_CONTEXT);
		expect(entry).toMatchObject({
			type: "branch_summary",
			parentId: "target",
			fromId: "source",
			fromHook: false,
		});
		expect(fixture.events.filter((event) => event.type === "usage")).toHaveLength(1);
	});

	it("consumes an orphaned structural attempt and never resumes its nested request", async () => {
		const fixture = await createFixture();
		const effect = {
			...runScope(),
			at: "summary.effect_pending",
			task: standaloneCompactionTask(),
			summaryContext: {
				resultEntryId: "summary-entry",
				configuration: fixture.configuration,
				streamOptions: {},
				retryPolicy: { maxAttempts: 2, baseDelayMs: 10 },
			},
			attempt: 1,
			request: { index: 1, usageId: "abandoned-usage" },
			usageIds: ["settled-usage"],
		} satisfies SummaryEffectPendingOperation;
		await installOperation(
			fixture,
			effect,
			{ kind: "compaction" },
			{
				entries: [{ id: "tip", parentId: null, type: "message", message: user("history") }],
				preparation: { taskId: "task", value: compactionPreparation() },
			},
		);

		expect(await recoverStructuralGeneration(fixture.lane, fixture.drive, effect)).toEqual({ kind: "continue" });
		const retry = currentState(fixture);
		if (retry.at !== "summary.retry_wait") throw new Error("orphan did not enter retry wait");
		expect(retry.nextAttempt).toBe(2);
		expect("request" in retry).toBe(false);
		expect(
			fixture.storage
				.getCommitAttempts()
				.flat()
				.some((write) => write.kind === "usage"),
		).toBe(false);
		expect(fixture.events.at(-1)).toMatchObject({
			type: "retry_scheduled",
			attempt: 2,
			recovery: true,
		});
	});

	it("terminal-fails an orphaned structural attempt at the retry cap", async () => {
		const fixture = await createFixture();
		const effect = {
			...runScope(),
			at: "summary.effect_pending",
			task: standaloneCompactionTask(),
			summaryContext: {
				resultEntryId: "summary-entry",
				configuration: fixture.configuration,
				streamOptions: {},
				retryPolicy: { maxAttempts: 1, baseDelayMs: 10 },
			},
			attempt: 1,
			request: { index: 0, usageId: "abandoned-usage" },
			usageIds: [],
		} satisfies SummaryEffectPendingOperation;
		await installOperation(
			fixture,
			effect,
			{ kind: "compaction" },
			{
				entries: [{ id: "tip", parentId: null, type: "message", message: user("history") }],
				preparation: { taskId: "task", value: compactionPreparation() },
			},
		);

		expect(await recoverStructuralGeneration(fixture.lane, fixture.drive, effect)).toMatchObject({
			kind: "settled",
			outcome: {
				status: "failed",
				error: { code: "structural_interrupted" },
			},
		});
		expect(fixture.lane.state.operation).toBeNull();
		expect(fixture.events.map((event) => event.type)).not.toContain("retry_scheduled");
	});

	it("rejects a preparation whose durable kind contradicts the structural state", async () => {
		const fixture = await createFixture();
		const deciding = {
			...runScope(),
			at: "summary.deciding",
			task: standaloneCompactionTask(),
		} as const;
		await installOperation(
			fixture,
			deciding,
			{ kind: "compaction" },
			{
				entries: [{ id: "tip", parentId: null, type: "message", message: user("history") }],
				preparation: { taskId: "task", value: branchPreparation() },
			},
		);

		await expect(runStructuralDecision(fixture.lane, fixture.drive, deciding)).rejects.toThrow(
			"Structural task task is missing its compaction preparation",
		);
	});
});

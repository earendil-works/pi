import { type AssistantMessageFrame, createModels } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WatchHandle } from "../../../src/harness/agent-harness.ts";
import { DEFAULT_COMPACTION_SETTINGS } from "../../../src/harness/compaction/compaction.ts";
import { BACKGROUND_CONTEXT, type Context, withAbortSignal } from "../../../src/harness/context.ts";
import { HookRegistry } from "../../../src/harness/hooks.ts";
import { Lane } from "../../../src/harness/runtime/lane.ts";
import { openFrameProgress, openToolProgress } from "../../../src/harness/runtime/progress.ts";
import { type Config, Drive, type LaneState as RuntimeLaneState } from "../../../src/harness/runtime/types.ts";
import { MemoryStorage } from "../../../src/harness/session/memory.ts";
import { StorageBackedSession } from "../../../src/harness/session/session.ts";
import {
	type AssistantEffectPendingOperation,
	type CheckpointOperation,
	type OperationState,
	operationScopeOf,
	type Session,
	type Write,
} from "../../../src/harness/session/types.ts";
import * as storedValues from "../../../src/harness/session/values.ts";
import { deferred } from "./test-utils.ts";

const sessions: Session[] = [];
const operationId = "operation";
const configuration = {
	model: { provider: "test", modelId: "model" },
	thinkingLevel: "off" as const,
	activeToolNames: [],
};

class FailingStorage extends MemoryStorage {
	failure: Error | undefined;
	beforeNextCommit: (() => Promise<void>) | undefined;

	override async commit(writes: Write[], context: Context) {
		const beforeCommit = this.beforeNextCommit;
		this.beforeNextCommit = undefined;
		await beforeCommit?.();
		if (this.failure === undefined) return super.commit(writes, context);
		const failure = this.failure;
		this.failure = undefined;
		throw failure;
	}
}

const runtimeConfig: Config<undefined> = {
	tools: [],
	resources: {},
	streamOptions: {},
	retryPolicy: { enabled: true, maxRetries: 3, baseDelayMs: 1_000 },
	compaction: DEFAULT_COMPACTION_SETTINGS,
	steeringMode: "all",
	followUpMode: "all",
	toolExecution: "parallel",
	toolContext: undefined,
	systemPrompt: undefined,
	toProviderMessages: () => [],
	entryProjectors: {},
};

function unusedWatch<T>(): WatchHandle<T> {
	throw new Error("watch is not used by progress tests");
}

function runScope() {
	return {
		control: { status: "running" as const },
		settings: {
			compaction: DEFAULT_COMPACTION_SETTINGS,
			steeringMode: "all" as const,
			followUpMode: "all" as const,
			toolExecution: "parallel" as const,
		},
		inbox: { steer: [], followUp: [], writes: [] },
		latestAssistantEntryId: null,
	};
}

function assistantEffectPending(responseEntryId: string): AssistantEffectPendingOperation {
	return {
		...runScope(),
		at: "assistant.effect_pending",
		generationContext: {
			stepId: "step",
			triggerEntryId: "trigger",
			configuration,
			streamOptions: {},
			retryPolicy: { maxAttempts: 2, baseDelayMs: 1 },
			overflowRecoveryUsed: false,
		},
		attempt: 1,
		responseEntryId,
		usageId: "usage",
		intendedOutputLimit: 100,
		contextWindow: 1_000,
	};
}

async function createFixture(
	state: OperationState,
	storage = new FailingStorage(),
): Promise<{ lane: Lane<undefined>; drive: Drive; storage: FailingStorage }> {
	const session = new StorageBackedSession(
		{ id: `progress-${sessions.length}`, createdAt: 1, storageVersion: 1 },
		storage,
	);
	sessions.push(session);
	const meta = {
		operationId,
		lane: "main",
		sourceTipId: null,
		startedAt: 1,
		intent: { kind: "run" as const, promptEntryIds: [] },
	};
	const projection: RuntimeLaneState = {
		tipId: null,
		configuration,
		inbox: [],
		lastOperationId: null,
		operation: { meta, state },
	};
	const lane = new Lane<undefined>(
		"main",
		session,
		createModels(),
		new HookRegistry(() => {}),
		projection,
		(cause) => (cause instanceof Error ? cause : new Error(String(cause))),
		() => Promise.resolve(),
		unusedWatch,
		() => runtimeConfig,
	);
	await session.mutate(
		(mutator) =>
			mutator.commit(
				[
					storedValues.setValue(storedValues.branchTip("main"), null),
					storedValues.setValue(storedValues.laneConfig("main"), configuration),
					storedValues.setValue(storedValues.laneState("main"), {
						currentOperationId: operationId,
						lastOperationId: null,
						inbox: [],
					}),
					storedValues.setValue(storedValues.operationMeta(operationId), meta),
					storedValues.setValue(storedValues.operationState(operationId), state),
				],
				BACKGROUND_CONTEXT,
			),
		BACKGROUND_CONTEXT,
	);
	const drive = new Drive({ operationId }, BACKGROUND_CONTEXT);
	lane.activeDrive = drive;
	return { lane, drive, storage };
}

afterEach(async () => {
	for (const session of sessions.splice(0)) await session.close(BACKGROUND_CONTEXT);
});

describe("runtime active drive ownership", () => {
	it("settles or rejects the shared completion without exposing owner controls through the gate", async () => {
		const settled = new Drive({ operationId }, BACKGROUND_CONTEXT);
		const outcome = { kind: "waiting", operationId, reason: "retry", notBefore: 10 } as const;
		settled.settle(outcome);
		settled.fail(new Error("late failure"));
		await expect(settled.completion).resolves.toBe(outcome);

		const failed = new Drive({ operationId }, BACKGROUND_CONTEXT);
		const error = new Error("drive failed");
		failed.fail(error);
		await expect(failed.completion).rejects.toBe(error);
		expect("beginAbort" in failed.gate).toBe(false);
	});

	it("strips invocation cancellation from pass context and owns policy and gate control", () => {
		const controller = new AbortController();
		const drive = new Drive(
			{ operationId, waitForRetry: true, pollDeferred: true },
			withAbortSignal(controller.signal, BACKGROUND_CONTEXT),
		);

		expect(drive.operationId).toBe(operationId);
		expect(drive.context.abortSignal).toBeUndefined();
		expect(drive.waitForRetry).toBe(true);
		expect(drive.deferredPermits).toBe(1);

		const closed = new Error("closed");
		drive.closeGate(closed);
		expect(drive.gate.signal.aborted).toBe(true);
		expect(() => drive.gate.admit(() => undefined)).toThrow(closed);
	});
});

describe("runtime progress channels", () => {
	it("enqueues assistant frames in order, seals admission, and exposes the settlement delete", async () => {
		const responseEntryId = "response";
		const { lane, drive } = await createFixture(assistantEffectPending(responseEntryId));
		const progress = openFrameProgress(lane, drive, responseEntryId);
		const frames: AssistantMessageFrame[] = [
			{ type: "text_delta", contentIndex: 0, delta: "a" },
			{ type: "text_delta", contentIndex: 0, delta: "b" },
		];

		progress.write(frames[0]!);
		progress.write(frames[1]!);
		progress.seal();
		progress.write({ type: "text_delta", contentIndex: 0, delta: "late" });
		await progress.drain();

		expect(
			(
				await lane.session.readList(
					storedValues.pendingAssistantFrames(operationId, responseEntryId),
					undefined,
					BACKGROUND_CONTEXT,
				)
			).map(({ value }) => value),
		).toEqual(frames);
	});

	it("declines a queued frame after the authoritative projection leaves its phase without control reads", async () => {
		const responseEntryId = "response";
		const { lane, drive, storage } = await createFixture(assistantEffectPending(responseEntryId));
		const progress = openFrameProgress(lane, drive, responseEntryId);
		const commitStarted = deferred();
		const releaseCommit = deferred();
		storage.beforeNextCommit = async () => {
			commitStarted.resolve();
			await releaseCommit.promise;
		};
		const getValue = vi.spyOn(storage, "getValue");
		const moving = lane.command((state) => {
			const operation = state.operation;
			if (operation === null) throw new Error("missing operation");
			const nextState: CheckpointOperation = {
				...operationScopeOf(operation.state),
				at: "checkpoint",
				continuation: { kind: "may_finish", includeFinalAssistant: true },
				triggerEntryId: responseEntryId,
			};
			return {
				kind: "commit",
				writes: [storedValues.setValue(storedValues.operationState(operationId), nextState)],
				next: { ...state, operation: { meta: operation.meta, state: nextState } },
				materialize: () => undefined,
			};
		}, BACKGROUND_CONTEXT);
		await commitStarted.promise;
		progress.write({ type: "text_delta", contentIndex: 0, delta: "late" });
		releaseCommit.resolve();
		await moving;
		await progress.drain();

		expect(
			await lane.session.readList(
				storedValues.pendingAssistantFrames(operationId, responseEntryId),
				undefined,
				BACKGROUND_CONTEXT,
			),
		).toEqual([]);
		expect(getValue).not.toHaveBeenCalled();
	});

	it("declines a queued frame after terminal projection publication", async () => {
		const responseEntryId = "response";
		const { lane, drive, storage } = await createFixture(assistantEffectPending(responseEntryId));
		const progress = openFrameProgress(lane, drive, responseEntryId);
		const commitStarted = deferred();
		const releaseCommit = deferred();
		storage.beforeNextCommit = async () => {
			commitStarted.resolve();
			await releaseCommit.promise;
		};
		const getValue = vi.spyOn(storage, "getValue");
		const ending = lane.command(
			(state) => ({
				kind: "commit",
				writes: [
					storedValues.deleteValue(storedValues.operationMeta(operationId)),
					storedValues.deleteValue(storedValues.operationState(operationId)),
					storedValues.setValue(storedValues.laneState("main"), {
						currentOperationId: null,
						lastOperationId: null,
						inbox: state.inbox,
					}),
				],
				next: { ...state, operation: null },
				materialize: () => undefined,
			}),
			BACKGROUND_CONTEXT,
		);
		await commitStarted.promise;
		progress.write({ type: "text_delta", contentIndex: 0, delta: "late" });
		releaseCommit.resolve();
		await ending;
		await progress.drain();

		expect(
			await lane.session.readList(
				storedValues.pendingAssistantFrames(operationId, responseEntryId),
				undefined,
				BACKGROUND_CONTEXT,
			),
		).toEqual([]);
		expect(getValue).not.toHaveBeenCalled();
	});

	it("replaces tool checkpoints in invocation order", async () => {
		const invocationId = "result";
		const { lane, drive } = await createFixture({
			...runScope(),
			at: "tools",
			batch: {
				assistantEntryId: "assistant",
				configuration,
				turnId: "turn",
				calls: [{ status: "effect_pending", sourceIndex: 0, resultEntryId: invocationId, replay: "safe" }],
			},
		} satisfies OperationState);
		const progress = openToolProgress(lane, drive, "turn", 0, invocationId);
		progress.write({ content: [{ type: "text", text: "first" }], details: {} });
		progress.write({ content: [{ type: "text", text: "second" }], details: {} });
		await progress.drain();
		expect(
			(await lane.session.getValue(storedValues.pendingToolOutput(operationId, invocationId), BACKGROUND_CONTEXT))
				?.value.content,
		).toEqual([{ type: "text", text: "second" }]);
	});

	it("retains the rejecting write promise so drain propagates commit failure", async () => {
		const responseEntryId = "response";
		const { lane, drive, storage } = await createFixture(assistantEffectPending(responseEntryId));
		const failure = new Error("frame commit failed");
		storage.failure = failure;
		const progress = openFrameProgress(lane, drive, responseEntryId);

		progress.write({ type: "text_delta", contentIndex: 0, delta: "lost" });

		await expect(progress.drain()).rejects.toBe(failure);
	});
});

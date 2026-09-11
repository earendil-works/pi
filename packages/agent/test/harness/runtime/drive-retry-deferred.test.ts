import {
	type AssistantMessage,
	type DeferredFetchOptions,
	fauxAssistantMessage,
	fauxProvider,
	fauxToolCall,
	type MutableModels,
	type Provider,
} from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createModels } from "../../../../ai/src/models.ts";
import type { HarnessEvent, WatchHandle } from "../../../src/harness/agent-harness.ts";
import { DEFAULT_COMPACTION_SETTINGS } from "../../../src/harness/compaction/compaction.ts";
import { BACKGROUND_CONTEXT } from "../../../src/harness/context.ts";
import { HookRegistry } from "../../../src/harness/hooks.ts";
import { runCheckpoint, startRun } from "../../../src/harness/runtime/drive/checkpoint.ts";
import { recoverDeferredPoll, runDeferred, runDeferredSuspended } from "../../../src/harness/runtime/drive/deferred.ts";
import { runGeneration } from "../../../src/harness/runtime/drive/generation.ts";
import { Lane } from "../../../src/harness/runtime/lane.ts";
import { restoreLane } from "../../../src/harness/runtime/restore.ts";
import { type Config, Drive } from "../../../src/harness/runtime/types.ts";
import { MemoryStorage } from "../../../src/harness/session/memory.ts";
import { StorageBackedSession } from "../../../src/harness/session/session.ts";
import { GatingStorage } from "../../../src/harness/session/testing/gating-storage.ts";
import { InstrumentedStorage } from "../../../src/harness/session/testing/instrumented-storage.ts";
import {
	type AssistantReadyOperation,
	type AssistantRetryWaitOperation,
	type DeferredEffectPendingOperation,
	type DeferredSuspendedOperation,
	type LaneConfiguration,
	type OperationState,
	operationScopeOf,
	type Session,
	type Write,
} from "../../../src/harness/session/types.ts";
import * as storedValues from "../../../src/harness/session/values.ts";
import { deferred } from "./test-utils.ts";

const sessions: Session[] = [];
const operationId = "01950000-0000-7000-8000-000000000001";

interface Fixture {
	backend: MemoryStorage;
	gating: GatingStorage | undefined;
	storage: InstrumentedStorage;
	session: Session;
	lane: Lane<undefined>;
	drive: Drive;
	models: MutableModels;
	faux: ReturnType<typeof fauxProvider>;
	hooks: HookRegistry;
	events: HarnessEvent[];
	config: Config<undefined>;
}

function unusedWatch<T>(): WatchHandle<T> {
	throw new Error("watch is not used by retry/deferred tests");
}

async function createFixture(
	options: { gated?: boolean; pendingFetches?: number; deferredSubmission?: boolean } = {},
): Promise<Fixture> {
	const backend = new MemoryStorage({ now: () => 100 });
	const gating = options.gated ? new GatingStorage(backend) : undefined;
	const storage = new InstrumentedStorage(gating ?? backend);
	const session = new StorageBackedSession(
		{ id: `retry-deferred-${sessions.length}`, createdAt: 1, storageVersion: 1 },
		storage,
	);
	sessions.push(session);
	const faux = fauxProvider({
		tokenSize: { min: 1, max: 1 },
		deferred: { pendingFetches: options.pendingFetches ?? 0 },
	});
	const model = faux.getModel();
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
	const models = createModels();
	models.setProvider(faux.provider);
	const hooks = new HookRegistry(() => {});
	const events: HarnessEvent[] = [];
	const config: Config<undefined> = {
		tools: [],
		resources: {},
		streamOptions: { deferred: options.deferredSubmission ?? true },
		retryPolicy: { enabled: true, maxRetries: 3, baseDelayMs: 10 },
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
	const admission = await lane.accept({ kind: "prompt", operationId, prompt: "question" }, BACKGROUND_CONTEXT);
	if (!admission.ok) throw admission.error;
	const drive = new Drive({ operationId }, BACKGROUND_CONTEXT);
	lane.activeDrive = drive;
	storage.clearCommitAttempts();
	return { backend, gating, storage, session, lane, drive, models, faux, hooks, events, config };
}

function currentRun(fixture: Fixture): OperationState {
	const operation = fixture.lane.state.operation;
	if (operation === null) throw new Error("fixture has no operation");
	return operation.state;
}

async function advanceToReady(fixture: Fixture): Promise<AssistantReadyOperation> {
	const starting = currentRun(fixture);
	if (starting.at !== "starting") throw new Error("run did not start at its initial boundary");
	await startRun(fixture.lane, fixture.drive, starting);
	let run = currentRun(fixture);
	if (run.at !== "checkpoint") throw new Error("run did not reach checkpoint");
	await runCheckpoint(fixture.lane, fixture.drive, run);
	run = currentRun(fixture);
	if (run.at !== "assistant.ready") {
		throw new Error("run did not reach ready generation");
	}
	return run;
}

async function replaceRunState(fixture: Fixture, nextState: OperationState, extraWrites: Write[] = []): Promise<void> {
	await fixture.lane.command((state) => {
		const operation = state.operation;
		if (operation === null) throw new Error("fixture has no operation");
		return {
			kind: "commit",
			writes: [...extraWrites, storedValues.setValue(storedValues.operationState(operationId), nextState)],
			next: { ...state, operation: { meta: operation.meta, state: nextState } },
			materialize: () => undefined,
		};
	}, BACKGROUND_CONTEXT);
}

async function submitDeferred(
	fixture: Fixture,
	response: AssistantMessage = fauxAssistantMessage("done", { timestamp: 20 }),
): Promise<DeferredSuspendedOperation> {
	fixture.faux.setResponses([response]);
	const ready = await advanceToReady(fixture);
	await runGeneration(fixture.lane, fixture.drive, ready);
	const run = currentRun(fixture);
	if (run.at !== "deferred.suspended") {
		throw new Error("initial request did not suspend");
	}
	return run;
}

async function installUnknownPoll(
	fixture: Fixture,
	suspended: DeferredSuspendedOperation,
): Promise<DeferredEffectPendingOperation> {
	const effectPending: DeferredEffectPendingOperation = {
		...operationScopeOf(currentRun(fixture)),
		at: "deferred.effect_pending",
		stepId: suspended.stepId,
		sourceEntryId: suspended.sourceEntryId,
		poll: suspended.poll + 1,
		responseEntryId: fixture.session.idGenerator.next(),
		usageId: fixture.session.idGenerator.next(),
		configuration: suspended.configuration,
		streamOptions: suspended.streamOptions,
	};
	await replaceRunState(fixture, effectPending, [
		storedValues.appendList(storedValues.pendingAssistantFrames(operationId, effectPending.responseEntryId), {
			type: "text_delta",
			contentIndex: 0,
			delta: "old",
		}),
	]);
	return effectPending;
}

function currentDeferred(fixture: Fixture): DeferredSuspendedOperation | DeferredEffectPendingOperation {
	const run = currentRun(fixture);
	if (run.at !== "deferred.suspended" && run.at !== "deferred.effect_pending") {
		throw new Error("fixture has no deferred phase");
	}
	return run;
}

function installDrive(fixture: Fixture, options: { waitForRetry?: boolean; pollDeferred?: boolean }): Drive {
	const drive = new Drive({ operationId, ...options }, BACKGROUND_CONTEXT);
	fixture.lane.activeDrive = drive;
	return drive;
}

async function expectProjectionRestores(fixture: Fixture): Promise<void> {
	expect(fixture.lane.state).toEqual(await restoreLane(fixture.session, "main", BACKGROUND_CONTEXT));
}

afterEach(async () => {
	vi.useRealTimers();
	for (const session of sessions.splice(0)) await session.close(BACKGROUND_CONTEXT);
});

describe("runtime assistant retry wait", () => {
	it("classifies a live retryable provider error into durable retry wait", async () => {
		const fixture = await createFixture({ deferredSubmission: false });
		const ready = await advanceToReady(fixture);
		fixture.faux.setResponses([
			fauxAssistantMessage([], { stopReason: "error", errorMessage: "503 service unavailable", timestamp: 10 }),
		]);

		expect(await runGeneration(fixture.lane, fixture.drive, ready)).toEqual({
			kind: "continue",
		});
		expect(currentRun(fixture)).toMatchObject({
			at: "assistant.retry_wait",
			nextAttempt: 2,
			errorMessage: "503 service unavailable",
		});
		expect(fixture.events.at(-1)).toMatchObject({ type: "retry_scheduled", attempt: 2 });
		await expectProjectionRestores(fixture);
	});

	it("returns a durable waiting outcome without a timer or write when local waiting is disabled", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(1_000);
		const fixture = await createFixture({ deferredSubmission: false });
		const ready = await advanceToReady(fixture);
		const retryWait: AssistantRetryWaitOperation = {
			...operationScopeOf(ready),
			at: "assistant.retry_wait",
			generationContext: ready.generationContext,
			nextAttempt: 2,
			notBefore: 1_100,
			errorMessage: "retry",
		};
		await replaceRunState(fixture, retryWait);
		fixture.storage.clearCommitAttempts();
		const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");

		expect(await runGeneration(fixture.lane, fixture.drive, retryWait)).toEqual({
			kind: "waiting",
			outcome: { kind: "waiting", operationId, reason: "retry", notBefore: 1_100 },
		});
		expect(setTimeoutSpy).not.toHaveBeenCalled();
		expect(fixture.storage.getCommitAttempts()).toEqual([]);
	});

	it("commits ready at the deadline and emits retry lifecycle around the next attempt", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(2_000);
		const fixture = await createFixture({ deferredSubmission: false });
		const ready = await advanceToReady(fixture);
		const retryWait: AssistantRetryWaitOperation = {
			...operationScopeOf(ready),
			at: "assistant.retry_wait",
			generationContext: ready.generationContext,
			nextAttempt: 2,
			notBefore: 2_000,
			errorMessage: "retry",
		};
		await replaceRunState(fixture, retryWait);
		fixture.storage.clearCommitAttempts();

		expect(await runGeneration(fixture.lane, fixture.drive, retryWait)).toEqual({
			kind: "continue",
		});
		const next = currentRun(fixture);
		if (next.at !== "assistant.ready") {
			throw new Error("retry did not become ready");
		}
		expect(fixture.events.at(-1)).toMatchObject({ type: "retry_start", attempt: 2 });
		fixture.faux.setResponses([fauxAssistantMessage("retried", { timestamp: 30 })]);
		await runGeneration(fixture.lane, fixture.drive, next);
		expect(fixture.events).toContainEqual(expect.objectContaining({ type: "retry_end", attempt: 2, success: true }));
		await expectProjectionRestores(fixture);
	});

	it("admits an abort-aware timer only for local waiting", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(3_000);
		const fixture = await createFixture({ deferredSubmission: false });
		const ready = await advanceToReady(fixture);
		const retryWait: AssistantRetryWaitOperation = {
			...operationScopeOf(ready),
			at: "assistant.retry_wait",
			generationContext: ready.generationContext,
			nextAttempt: 2,
			notBefore: 3_100,
			errorMessage: "retry",
		};
		await replaceRunState(fixture, retryWait);
		const drive = installDrive(fixture, { waitForRetry: true });
		fixture.storage.clearCommitAttempts();
		const waiting = runGeneration(fixture.lane, drive, retryWait);

		await vi.advanceTimersByTimeAsync(99);
		expect(fixture.storage.getCommitAttempts()).toEqual([]);
		await vi.advanceTimersByTimeAsync(1);
		expect(await waiting).toEqual({ kind: "continue" });
		expect(currentRun(fixture)).toMatchObject({
			at: "assistant.ready",
			nextAttempt: 2,
		});
	});
});

describe("runtime deferred polling", () => {
	it("waits without a permit, then performs at most one pending poll from captured options", async () => {
		const fixture = await createFixture({ pendingFetches: 1 });
		const suspended = await submitDeferred(fixture);
		fixture.storage.clearCommitAttempts();

		expect(await runDeferredSuspended(fixture.lane, fixture.drive, suspended)).toEqual({
			kind: "waiting",
			outcome: {
				kind: "waiting",
				operationId,
				reason: "deferred",
				deferred: expect.objectContaining({ id: expect.any(String) }),
			},
		});
		expect(fixture.faux.state.deferredFetchCount).toBe(0);
		expect(fixture.storage.getCommitAttempts()).toEqual([]);

		let hookOptions: unknown;
		fixture.hooks.on("before_request", (event) => {
			if (event.step === "deferred") hookOptions = event.streamOptions;
			return undefined;
		});
		let fetchOptions: DeferredFetchOptions | undefined;
		const provider = fixture.faux.provider;
		const fetchDeferred = provider.fetchDeferred;
		if (fetchDeferred === undefined) throw new Error("faux provider has no deferred fetch");
		const wrapped: Provider = {
			...provider,
			fetchDeferred: (model, handle, options) => {
				fetchOptions = options;
				return fetchDeferred(model, handle, options);
			},
		};
		fixture.models.setProvider(wrapped);
		const driveOptions = { operationId, pollDeferred: true } as const;
		const drive = new Drive(driveOptions, BACKGROUND_CONTEXT);
		fixture.lane.activeDrive = drive;

		expect(await runDeferred(fixture.lane, drive, currentDeferred(fixture))).toEqual({
			kind: "continue",
		});
		expect(drive.deferredPermits).toBe(0);
		expect(driveOptions).toEqual({ operationId, pollDeferred: true });
		expect(hookOptions).toMatchObject({ deferred: false });
		expect(fetchOptions).toMatchObject({ wait: 0 });
		expect(fetchOptions?.signal).toBe(drive.gate.signal);
		expect(currentDeferred(fixture)).toMatchObject({ at: "deferred.suspended", poll: 1 });
		expect(fixture.faux.state.deferredFetchCount).toBe(1);
		expect(fixture.events.slice(-2).map((event) => event.type)).toEqual(["turn_end", "run_suspend"]);

		expect(await runDeferred(fixture.lane, drive, currentDeferred(fixture))).toMatchObject({
			kind: "waiting",
			outcome: { reason: "deferred" },
		});
		expect(fixture.faux.state.deferredFetchCount).toBe(1);
		await expectProjectionRestores(fixture);
	});

	it("declines poll intent when cancellation wins preparation", async () => {
		const fixture = await createFixture();
		const suspended = await submitDeferred(fixture);
		const drive = installDrive(fixture, { pollDeferred: true });
		const hookStarted = deferred();
		const releaseHook = deferred();
		fixture.hooks.on("before_request", async (event) => {
			if (event.step !== "deferred") return undefined;
			hookStarted.resolve();
			await releaseHook.promise;
			return undefined;
		});

		const polling = runDeferredSuspended(fixture.lane, drive, suspended);
		await hookStarted.promise;
		await fixture.lane.command((state) => {
			const operation = state.operation;
			if (operation === null) throw new Error("missing operation");
			const nextState: OperationState = {
				...operation.state,
				control: { status: "cancel_requested", requestedAt: 10 },
			};
			return {
				kind: "commit",
				writes: [storedValues.setValue(storedValues.operationState(operationId), nextState)],
				next: { ...state, operation: { meta: operation.meta, state: nextState } },
				materialize: () => undefined,
			};
		}, BACKGROUND_CONTEXT);
		releaseHook.resolve();

		expect(await polling).toEqual({ kind: "continue" });
		expect(fixture.faux.state.deferredFetchCount).toBe(0);
		expect(currentRun(fixture)).toMatchObject({
			at: "deferred.suspended",
			control: { status: "cancel_requested" },
		});
	});

	it("plans ready deferred tool calls with the poll turn identity and follower result ids", async () => {
		const fixture = await createFixture();
		const suspended = await submitDeferred(
			fixture,
			fauxAssistantMessage(fauxToolCall("lookup", { query: "value" }), {
				stopReason: "toolUse",
				timestamp: 20,
			}),
		);
		const drive = installDrive(fixture, { pollDeferred: true });

		expect(await runDeferredSuspended(fixture.lane, drive, suspended)).toEqual({
			kind: "continue",
		});
		const run = currentRun(fixture);
		if (run.at !== "tools") throw new Error("deferred tool response did not create a batch");
		expect(run.batch).toMatchObject({
			turnId: `${suspended.stepId}:poll:1`,
			calls: [{ status: "planned", sourceIndex: 0 }],
		});
		expect(run.batch.calls[0]?.resultEntryId.slice(0, 13)).toBe(run.latestAssistantEntryId?.slice(0, 13));
		expect(fixture.events.at(-1)).toMatchObject({ type: "usage" });
		await expectProjectionRestores(fixture);
	});

	it("consumes its permit only after the fresh intent commit lands", async () => {
		const fixture = await createFixture({ gated: true });
		const suspended = await submitDeferred(
			fixture,
			fauxAssistantMessage([], { stopReason: "error", errorMessage: "failed", timestamp: 20 }),
		);
		const gating = fixture.gating;
		if (gating === undefined) throw new Error("fixture is not gated");
		const drive = installDrive(fixture, { pollDeferred: true });
		gating.arm();
		const polling = runDeferredSuspended(fixture.lane, drive, suspended);

		await gating.waitPending();
		expect(drive.deferredPermits).toBe(1);
		expect(fixture.faux.state.deferredFetchCount).toBe(0);
		await gating.next();
		expect(drive.deferredPermits).toBe(0);
		await expect.poll(() => fixture.faux.state.deferredFetchCount).toBe(1);
		await gating.next(2); // start frame, then response settlement
		expect(await polling).toMatchObject({
			kind: "settled",
			outcome: { operationId, kind: "run", status: "failed" },
		});
		expect(fixture.lane.state.operation).toBeNull();
	});

	it("leaves suspended state unchanged when the fresh intent is discarded", async () => {
		const fixture = await createFixture({ gated: true });
		const suspended = await submitDeferred(fixture);
		const gating = fixture.gating;
		if (gating === undefined) throw new Error("fixture is not gated");
		const drive = installDrive(fixture, { pollDeferred: true });
		gating.arm();
		const polling = runDeferredSuspended(fixture.lane, drive, suspended);
		void polling.catch(() => {});

		await gating.waitPending();
		gating.discard();
		await expect(polling).rejects.toThrow("commit discarded");
		expect(drive.deferredPermits).toBe(1);
		expect(fixture.faux.state.deferredFetchCount).toBe(0);
		const durable = await fixture.backend.getValue(storedValues.operationState(operationId), BACKGROUND_CONTEXT);
		expect(durable?.value).toMatchObject({ at: "deferred.suspended", poll: 0 });
	});

	it("replaces an unknown poll under fresh ids at the same poll number and deletes old frames", async () => {
		const fixture = await createFixture();
		const suspended = await submitDeferred(fixture);
		const unknown = await installUnknownPoll(fixture, suspended);
		fixture.storage.clearCommitAttempts();

		const noPermit = installDrive(fixture, {});
		expect(await recoverDeferredPoll(fixture.lane, noPermit, unknown)).toMatchObject({
			kind: "waiting",
			outcome: { reason: "deferred" },
		});
		expect(
			await fixture.session.readList(
				storedValues.pendingAssistantFrames(operationId, unknown.responseEntryId),
				undefined,
				BACKGROUND_CONTEXT,
			),
		).toHaveLength(1);
		expect(fixture.faux.state.deferredFetchCount).toBe(0);

		const replacement = installDrive(fixture, { pollDeferred: true });
		expect(await recoverDeferredPoll(fixture.lane, replacement, unknown)).toEqual({
			kind: "continue",
		});
		const intent = fixture.storage
			.getCommitAttempts()
			.find((writes) =>
				writes.some(
					(write) =>
						write.kind === "list" &&
						write.op === "delete" &&
						write.namespace === "pi.pending.assistant_frame" &&
						write.key.endsWith(unknown.responseEntryId),
				),
			);
		expect(intent?.map((write) => `${write.kind}:${"op" in write ? write.op : "insert"}`)).toEqual([
			"list:delete",
			"value:set",
		]);
		const intentState = intent?.find(
			(write) => write.kind === "value" && write.op === "set" && write.namespace === "pi.op.state",
		);
		expect(intentState).toMatchObject({
			value: {
				at: "deferred.effect_pending",
				poll: unknown.poll,
				responseEntryId: expect.not.stringMatching(unknown.responseEntryId),
				usageId: expect.not.stringMatching(unknown.usageId),
			},
		});
		expect(await fixture.session.getEntry(unknown.responseEntryId, BACKGROUND_CONTEXT)).toBeUndefined();
		expect((await fixture.storage.scanUsage({}, BACKGROUND_CONTEXT)).some((row) => row.id === unknown.usageId)).toBe(
			false,
		);
		expect(
			await fixture.session.readList(
				storedValues.pendingAssistantFrames(operationId, unknown.responseEntryId),
				undefined,
				BACKGROUND_CONTEXT,
			),
		).toEqual([]);
		expect(currentRun(fixture).at).toBe("checkpoint");
		expect(fixture.events.some((event) => "recovery" in event && event.recovery === true)).toBe(true);
		await expectProjectionRestores(fixture);
	});

	it("abandons unknown ids and frames into configuration failure when the captured model is unavailable", async () => {
		const fixture = await createFixture();
		const suspended = await submitDeferred(fixture);
		const unknown = await installUnknownPoll(fixture, suspended);
		fixture.models.deleteProvider(fixture.faux.provider.id);
		fixture.storage.clearCommitAttempts();
		const drive = installDrive(fixture, { pollDeferred: true });

		expect(await recoverDeferredPoll(fixture.lane, drive, unknown)).toMatchObject({
			kind: "settled",
			outcome: { operationId, kind: "run", status: "failed", error: { code: "model_unavailable" } },
		});
		expect(drive.deferredPermits).toBe(1);
		expect(fixture.faux.state.deferredFetchCount).toBe(0);
		expect(fixture.lane.state.operation).toBeNull();
		expect(
			fixture.storage
				.getCommitAttempts()
				.at(-1)
				?.map((write) =>
					write.kind === "value" || write.kind === "list"
						? `${write.kind}:${write.op}:${write.namespace}`
						: write.kind,
				),
		).toEqual([
			"value:delete:pi.op.meta",
			"value:delete:pi.op.state",
			"list:delete:pi.pending.assistant_frame",
			"value:set:pi.result",
			"value:set:pi.lane.state",
		]);
		expect(
			fixture.storage
				.getCommitAttempts()
				.flat()
				.some((write) => write.kind === "entry" || write.kind === "usage"),
		).toBe(false);
		await expectProjectionRestores(fixture);
	});
});

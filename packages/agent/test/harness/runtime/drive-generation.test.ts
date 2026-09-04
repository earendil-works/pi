import {
	type AssistantMessage,
	createAssistantMessageEventStream,
	createModels,
	fauxAssistantMessage,
	fauxProvider,
	type MutableModels,
	type Provider,
} from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HarnessEvent, WatchHandle } from "../../../src/harness/agent-harness.ts";
import { DEFAULT_COMPACTION_SETTINGS } from "../../../src/harness/compaction/compaction.ts";
import { BACKGROUND_CONTEXT, type Context } from "../../../src/harness/context.ts";
import { HookRegistry } from "../../../src/harness/hooks.ts";
import { runCheckpoint, startRun } from "../../../src/harness/runtime/drive/checkpoint.ts";
import { runGeneration } from "../../../src/harness/runtime/drive/generation.ts";
import { recoverAssistantGeneration } from "../../../src/harness/runtime/drive/recovery.ts";
import { Lane } from "../../../src/harness/runtime/lane.ts";
import { restoreLane } from "../../../src/harness/runtime/restore.ts";
import { type Config, Drive } from "../../../src/harness/runtime/types.ts";
import { MemoryStorage } from "../../../src/harness/session/memory.ts";
import { StorageBackedSession } from "../../../src/harness/session/session.ts";
import { InstrumentedStorage } from "../../../src/harness/session/testing/instrumented-storage.ts";
import {
	type AssistantEffectPendingOperation,
	type AssistantReadyOperation,
	type CheckpointOperation,
	type LaneConfiguration,
	type MessageEntry,
	type OperationState,
	operationScopeOf,
	type Session,
	type Write,
} from "../../../src/harness/session/types.ts";
import * as storedValues from "../../../src/harness/session/values.ts";
import { deferred } from "./test-utils.ts";

const sessions: Session[] = [];
const operationId = "01950000-0000-7000-8000-000000000001";

class FrameBlockingMemoryStorage extends MemoryStorage {
	blockNextFrame = false;
	readonly frameStarted = deferred();
	readonly releaseFrame = deferred();

	override async commit(writes: Write[], context: Context) {
		if (
			this.blockNextFrame &&
			writes.some(
				(write) =>
					write.kind === "list" && write.op === "append" && write.namespace === "pi.pending.assistant_frame",
			)
		) {
			this.blockNextFrame = false;
			this.frameStarted.resolve();
			await this.releaseFrame.promise;
		}
		return super.commit(writes, context);
	}
}

interface Fixture {
	lane: Lane<undefined>;
	drive: Drive;
	session: Session;
	storage: InstrumentedStorage;
	models: MutableModels;
	faux: ReturnType<typeof fauxProvider>;
	hooks: HookRegistry;
	events: HarnessEvent[];
	config: Config<undefined>;
}

function unusedWatch<T>(): WatchHandle<T> {
	throw new Error("watch is not used by generation tests");
}

async function createFixture(backend: MemoryStorage = new MemoryStorage({ now: () => 100 })): Promise<Fixture> {
	const storage = new InstrumentedStorage(backend);
	const session = new StorageBackedSession(
		{ id: `generation-${sessions.length}`, createdAt: 1, storageVersion: 1 },
		storage,
	);
	sessions.push(session);
	const faux = fauxProvider({ tokenSize: { min: 1, max: 1 } });
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
		streamOptions: {},
		retryPolicy: { enabled: true, maxRetries: 3, baseDelayMs: 1 },
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
	return { lane, drive, session, storage, models, faux, hooks, events, config };
}

function currentRun(lane: Lane<undefined>): OperationState {
	const operation = lane.state.operation;
	if (operation === null) throw new Error("fixture has no operation");
	return operation.state;
}

function readyGeneration(lane: Lane<undefined>): AssistantReadyOperation {
	const run = currentRun(lane);
	if (run.at !== "assistant.ready") throw new Error("fixture has no ready generation");
	return run;
}

async function startFixtureRun(fixture: Fixture) {
	const run = currentRun(fixture.lane);
	if (run.at !== "starting") throw new Error("run did not start at its initial boundary");
	return startRun(fixture.lane, fixture.drive, run);
}

async function advanceToReady(fixture: Fixture): Promise<AssistantReadyOperation> {
	await startFixtureRun(fixture);
	const run = currentRun(fixture.lane);
	if (run.at !== "checkpoint") throw new Error("run did not reach checkpoint");
	await runCheckpoint(fixture.lane, fixture.drive, run);
	return readyGeneration(fixture.lane);
}

async function expectProjectionRestores(fixture: Fixture): Promise<void> {
	expect(fixture.lane.state).toEqual(await restoreLane(fixture.session, "main", BACKGROUND_CONTEXT));
}

function writesOperationState(writes: readonly Write[], status: string): boolean {
	return writes.some(
		(write) =>
			write.kind === "value" &&
			write.op === "set" &&
			write.namespace === "pi.op.state" &&
			typeof write.value === "object" &&
			write.value !== null &&
			"at" in write.value &&
			write.value.at === `assistant.${status}`,
	);
}

afterEach(async () => {
	vi.restoreAllMocks();
	for (const session of sessions.splice(0)) await session.close(BACKGROUND_CONTEXT);
});

describe("runtime generation checkpoint", () => {
	it("consumes before_run and snapshots a ready generation", async () => {
		const fixture = await createFixture();
		fixture.hooks.on("before_run", () => ({
			messages: [{ role: "user", content: "injected", timestamp: 2 }],
		}));
		expect(await startFixtureRun(fixture)).toEqual({ kind: "continue" });
		let run = currentRun(fixture.lane);
		if (run.at !== "checkpoint") throw new Error("missing checkpoint");
		expect(run.triggerEntryId).toBe(fixture.lane.state.tipId);
		expect(fixture.events.map((event) => event.type)).toContain("entry_added");
		await expectProjectionRestores(fixture);

		expect(await runCheckpoint(fixture.lane, fixture.drive, run)).toEqual({ kind: "continue" });
		run = currentRun(fixture.lane);
		if (run.at !== "assistant.ready") {
			throw new Error("missing ready generation");
		}
		expect(run.generationContext).toMatchObject({
			configuration: fixture.lane.state.configuration,
			streamOptions: {},
			retryPolicy: { maxAttempts: 4, baseDelayMs: 1 },
			overflowRecoveryUsed: false,
		});
		await expectProjectionRestores(fixture);
	});

	it("drains mixed pending writes while separating leaf and generation trigger", async () => {
		const fixture = await createFixture();
		await startFixtureRun(fixture);
		const messageId = "01950000-0000-7000-8000-000000000010";
		const customId = "01950000-0000-7000-8000-000000000011";
		await fixture.lane.command((state) => {
			const operation = state.operation;
			if (operation === null) throw new Error("missing operation");
			const inbox = [
				...state.inbox,
				{ entryId: messageId, kind: "write" as const },
				{ entryId: customId, kind: "write" as const },
			];
			return {
				kind: "commit",
				writes: [
					storedValues.setValue(storedValues.pendingEntry(messageId), {
						type: "message",
						payload: { role: "user", content: "projecting", timestamp: 3 },
					}),
					storedValues.setValue(storedValues.pendingEntry(customId), {
						type: "custom",
						customType: "display-only",
						payload: { value: true },
					}),
					storedValues.setValue(storedValues.laneState("main"), {
						currentOperationId: operationId,
						lastOperationId: null,
						inbox,
					}),
				],
				next: { ...state, inbox },
				materialize: () => undefined,
			};
		}, BACKGROUND_CONTEXT);
		const run = currentRun(fixture.lane);
		if (run.at !== "checkpoint") throw new Error("missing checkpoint");
		fixture.storage.clearCommitAttempts();

		await runCheckpoint(fixture.lane, fixture.drive, run);

		expect(fixture.storage.getCommitAttempts()).toHaveLength(1);
		const routed = currentRun(fixture.lane);
		if (routed.at !== "assistant.ready") throw new Error("pending writes did not route to generation");
		expect(fixture.lane.state.tipId).toBe(customId);
		expect(routed.generationContext).toMatchObject({
			triggerEntryId: messageId,
			overflowRecoveryUsed: false,
		});
		expect(fixture.lane.state.inbox).toEqual([]);
		await expectProjectionRestores(fixture);
	});

	it("preserves checkpoint routing when a custom-only pending write does not project", async () => {
		const fixture = await createFixture();
		await startFixtureRun(fixture);
		const current = currentRun(fixture.lane);
		if (current.at !== "checkpoint") throw new Error("missing checkpoint");
		const customId = "01950000-0000-7000-8000-000000000012";
		const checkpoint: CheckpointOperation = {
			...current,
			continuation: { kind: "may_finish", includeFinalAssistant: false },
		};
		await fixture.lane.command((state) => {
			const operation = state.operation;
			if (operation === null) throw new Error("missing operation");
			const inbox = [...state.inbox, { entryId: customId, kind: "write" as const }];
			return {
				kind: "commit",
				writes: [
					storedValues.setValue(storedValues.pendingEntry(customId), {
						type: "custom",
						customType: "display-only",
						payload: { value: true },
					}),
					storedValues.setValue(storedValues.operationState(operationId), checkpoint),
					storedValues.setValue(storedValues.laneState("main"), {
						currentOperationId: operationId,
						lastOperationId: null,
						inbox,
					}),
				],
				next: { ...state, inbox, operation: { meta: operation.meta, state: checkpoint } },
				materialize: () => undefined,
			};
		}, BACKGROUND_CONTEXT);
		fixture.hooks.on("before_run_end", () => ({ followUp: "continue after custom write" }));

		expect(await runCheckpoint(fixture.lane, fixture.drive, checkpoint)).toEqual({ kind: "continue" });

		const ready = currentRun(fixture.lane);
		if (ready.at !== "assistant.ready") throw new Error("hook follow-up did not route to generation");
		const followUpId = ready.generationContext.triggerEntryId;
		expect(followUpId).toBe(fixture.lane.state.tipId);
		expect(await fixture.session.getEntry(customId, BACKGROUND_CONTEXT)).toMatchObject({ type: "custom" });
		expect(await fixture.session.getEntry(followUpId, BACKGROUND_CONTEXT)).toMatchObject({
			parentId: customId,
			type: "message",
			message: { role: "user", content: "continue after custom write" },
		});
		expect(fixture.lane.state.inbox).toEqual([]);
		expect(await fixture.session.getValue(storedValues.pendingEntry(customId), BACKGROUND_CONTEXT)).toBeUndefined();
		await expectProjectionRestores(fixture);
	});

	it("drops a stale finish-hook follow-up when input arrives during the hook", async () => {
		const fixture = await createFixture();
		await startFixtureRun(fixture);
		const current = currentRun(fixture.lane);
		if (current.at !== "checkpoint") throw new Error("missing checkpoint");
		const checkpoint: CheckpointOperation = {
			...current,
			continuation: { kind: "may_finish", includeFinalAssistant: false },
		};
		await fixture.lane.command((state) => {
			const operation = state.operation;
			if (operation === null) throw new Error("missing operation");
			return {
				kind: "commit",
				writes: [storedValues.setValue(storedValues.operationState(operationId), checkpoint)],
				next: { ...state, operation: { meta: operation.meta, state: checkpoint } },
				materialize: () => undefined,
			};
		}, BACKGROUND_CONTEXT);
		const hookStarted = deferred();
		const releaseHook = deferred();
		fixture.hooks.on("before_run_end", async () => {
			hookStarted.resolve();
			await releaseHook.promise;
			return { followUp: "stale hook follow-up" };
		});

		const running = runCheckpoint(fixture.lane, fixture.drive, checkpoint);
		await hookStarted.promise;
		await fixture.lane.command((state) => {
			const inbox = [...state.inbox, { entryId: "steer-during-finish", kind: "steer" as const }];
			return {
				kind: "commit",
				writes: [
					storedValues.setValue(storedValues.pendingEntry("steer-during-finish"), {
						type: "message",
						payload: { role: "user", content: "new input", timestamp: 4 },
					}),
					storedValues.setValue(storedValues.laneState("main"), {
						currentOperationId: operationId,
						lastOperationId: null,
						inbox,
					}),
				],
				next: { ...state, inbox },
				materialize: () => undefined,
			};
		}, BACKGROUND_CONTEXT);
		releaseHook.resolve();

		expect(await running).toEqual({ kind: "continue" });
		const ready = currentRun(fixture.lane);
		if (ready.at !== "assistant.ready") throw new Error("new input did not replace stale finish decision");
		expect(ready.generationContext.triggerEntryId).toBe("steer-during-finish");
		expect(fixture.lane.state.tipId).toBe("steer-during-finish");
		expect((await fixture.session.getEntry("steer-during-finish", BACKGROUND_CONTEXT))?.type).toBe("message");
	});
});

describe("runtime assistant generation", () => {
	it("commits intent before provider admission, preserves queued inbox state, and settles reserved ids", async () => {
		const fixture = await createFixture();
		const ready = await advanceToReady(fixture);
		const hookStarted = deferred();
		const releaseHook = deferred();
		fixture.hooks.on("before_request", async () => {
			hookStarted.resolve();
			await releaseHook.promise;
			return undefined;
		});
		let effectPendingAtProvider = false;
		fixture.faux.setResponses([
			async () => {
				const state = await fixture.session.getValue(storedValues.operationState(operationId), BACKGROUND_CONTEXT);
				effectPendingAtProvider = state?.value.at === "assistant.effect_pending";
				return fauxAssistantMessage("answer", { timestamp: 5 });
			},
		]);
		fixture.storage.clearCommitAttempts();
		const generating = runGeneration(fixture.lane, fixture.drive, ready);
		await hookStarted.promise;
		const steerId = "01950000-0000-7000-8000-000000000020";
		await fixture.lane.command((state) => {
			const operation = state.operation;
			if (operation === null) throw new Error("missing operation");
			const inbox = [...state.inbox, { entryId: steerId, kind: "steer" as const }];
			return {
				kind: "commit",
				writes: [
					storedValues.setValue(storedValues.pendingEntry(steerId), {
						type: "message",
						payload: { role: "user", content: "late steer", timestamp: 4 },
					}),
					storedValues.setValue(storedValues.laneState("main"), {
						currentOperationId: operationId,
						lastOperationId: null,
						inbox,
					}),
				],
				next: { ...state, inbox },
				materialize: () => undefined,
			};
		}, BACKGROUND_CONTEXT);
		releaseHook.resolve();

		expect(await generating).toEqual({ kind: "continue" });
		expect(effectPendingAtProvider).toBe(true);
		const settled = currentRun(fixture.lane);
		expect(fixture.lane.state.inbox).toEqual([{ entryId: steerId, kind: "steer" }]);
		if (settled.at !== "checkpoint") throw new Error("response did not reach checkpoint");
		const responseId = settled.latestAssistantEntryId;
		if (responseId === null) throw new Error("missing response id");
		const entry = await fixture.session.getEntry(responseId, BACKGROUND_CONTEXT);
		expect(entry).toMatchObject({ id: responseId, type: "message", message: { content: [{ text: "answer" }] } });
		expect(
			await fixture.session.readList(
				storedValues.pendingAssistantFrames(operationId, responseId),
				undefined,
				BACKGROUND_CONTEXT,
			),
		).toEqual([]);
		const attempts = fixture.storage.getCommitAttempts();
		expect(attempts.some((writes) => writesOperationState(writes, "effect_pending"))).toBe(true);
		const settlement = attempts.find((writes) => writes.some((write) => write.kind === "entry"));
		expect(
			settlement?.map((write) =>
				write.kind === "value" || write.kind === "list"
					? `${write.kind}:${write.op}:${write.namespace}`
					: write.kind,
			),
		).toEqual([
			"entry",
			"usage",
			"value:set:pi.branch.tip",
			"list:delete:pi.pending.assistant_frame",
			"value:set:pi.op.state",
		]);
		expect(fixture.events.map((event) => event.type)).toEqual(
			expect.arrayContaining([
				"turn_start",
				"message_start",
				"message_update",
				"message_end",
				"entry_added",
				"usage",
				"turn_end",
			]),
		);
		await expectProjectionRestores(fixture);
	});

	it("does not await frame storage inside the provider event loop and persists frames in order", async () => {
		const backend = new FrameBlockingMemoryStorage({ now: () => 100 });
		const fixture = await createFixture(backend);
		const ready = await advanceToReady(fixture);
		const base = fixture.faux.provider;
		const provider: Provider = {
			id: base.id,
			name: base.name,
			auth: base.auth,
			getModels: () => base.getModels(),
			stream: (model, context, options) => base.stream(model, context, options),
			streamSimple: () => {
				const stream = createAssistantMessageEventStream();
				const partial: AssistantMessage = {
					...fauxAssistantMessage([], { timestamp: 5 }),
					stopReason: "pending",
				};
				const text = { type: "text" as const, text: "" };
				queueMicrotask(() => {
					stream.push({ type: "start", partial });
					partial.content.push(text);
					stream.push({ type: "text_start", contentIndex: 0, partial });
					text.text = "ab";
					stream.push({ type: "text_delta", contentIndex: 0, delta: "ab", partial });
					stream.push({ type: "text_end", contentIndex: 0, content: "ab", partial });
					stream.push({ type: "done", reason: "stop", message: fauxAssistantMessage("ab", { timestamp: 5 }) });
				});
				return stream;
			},
		};
		fixture.models.setProvider(provider);
		backend.blockNextFrame = true;
		fixture.storage.clearCommitAttempts();

		const generating = runGeneration(fixture.lane, fixture.drive, ready);
		await backend.frameStarted.promise;
		await expect
			.poll(() => fixture.events.filter((event) => event.type === "message_update").length)
			.toBeGreaterThan(1);
		backend.releaseFrame.resolve();
		await generating;

		const frames = fixture.storage
			.getCommitAttempts()
			.flatMap((writes) =>
				writes.flatMap((write) =>
					write.kind === "list" && write.op === "append" && write.namespace === "pi.pending.assistant_frame"
						? [write.value]
						: [],
				),
			);
		expect(
			frames.map((frame) =>
				typeof frame === "object" && frame !== null && "type" in frame ? frame.type : undefined,
			),
		).toEqual(["start", "text_start", "text_end"]);
		expect(frames[0]).toMatchObject({ partial: { content: [] } });
		expect(frames[1]).toMatchObject({ content: { text: "ab" } });
	});

	it("enters configuration failure without reserving response ids or calling the provider", async () => {
		const fixture = await createFixture();
		await fixture.lane.setActiveTools(["missing"], BACKGROUND_CONTEXT);
		const ready = await advanceToReady(fixture);
		const queuedId = await fixture.lane.appendCustomEntry("after-failure", { retained: true }, BACKGROUND_CONTEXT);
		fixture.storage.clearCommitAttempts();

		expect(await runGeneration(fixture.lane, fixture.drive, ready)).toMatchObject({
			kind: "settled",
			outcome: {
				operationId,
				kind: "run",
				status: "failed",
				error: { code: "configured_tools_unavailable", details: { tools: ["missing"] } },
			},
		});
		expect(fixture.lane.state.operation).toBeNull();
		expect(fixture.lane.state.inbox).toEqual([{ entryId: queuedId, kind: "write" }]);
		expect(await fixture.session.getValue(storedValues.pendingEntry(queuedId), BACKGROUND_CONTEXT)).toBeDefined();
		expect(fixture.faux.state.callCount).toBe(0);
		expect(
			fixture.storage
				.getCommitAttempts()
				.flat()
				.some((write) => write.kind === "entry" || write.kind === "usage"),
		).toBe(false);
		await expectProjectionRestores(fixture);
	});

	it("fails a missing captured model before reserving ids", async () => {
		const fixture = await createFixture();
		const ready = await advanceToReady(fixture);
		fixture.models.deleteProvider(fixture.faux.provider.id);
		fixture.storage.clearCommitAttempts();

		expect(await runGeneration(fixture.lane, fixture.drive, ready)).toMatchObject({
			kind: "settled",
			outcome: { operationId, kind: "run", status: "failed", error: { code: "model_unavailable" } },
		});
		expect(fixture.lane.state.operation).toBeNull();
		expect(fixture.faux.state.callCount).toBe(0);
		expect(
			fixture.storage
				.getCommitAttempts()
				.flat()
				.some((write) => write.kind === "entry" || write.kind === "usage"),
		).toBe(false);
		await expectProjectionRestores(fixture);
	});

	it("declines intent when cancellation wins preparation", async () => {
		const cancelled = await createFixture();
		const cancelledReady = await advanceToReady(cancelled);
		const cancelHookStarted = deferred();
		const releaseCancelHook = deferred();
		cancelled.hooks.on("before_request", async () => {
			cancelHookStarted.resolve();
			await releaseCancelHook.promise;
			return undefined;
		});
		cancelled.storage.clearCommitAttempts();
		const cancelling = runGeneration(cancelled.lane, cancelled.drive, cancelledReady);
		await cancelHookStarted.promise;
		await cancelled.lane.command((state) => {
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
		releaseCancelHook.resolve();
		expect(await cancelling).toEqual({ kind: "continue" });
		expect(cancelled.faux.state.callCount).toBe(0);
		expect(
			cancelled.storage.getCommitAttempts().some((writes) => writesOperationState(writes, "effect_pending")),
		).toBe(false);
	});

	it("recovers an orphan with no frames into a zero-usage retry wait", async () => {
		const fixture = await createFixture();
		const ready = await advanceToReady(fixture);
		const responseEntryId = "01950000-0000-7000-8000-000000000028";
		const usageId = "01950000-0000-7000-8000-000000000029";
		const pending: AssistantEffectPendingOperation = {
			...operationScopeOf(ready),
			at: "assistant.effect_pending",
			generationContext: { ...ready.generationContext, retryPolicy: { maxAttempts: 2, baseDelayMs: 1 } },
			attempt: 1,
			responseEntryId,
			usageId,
			intendedOutputLimit: 100,
			contextWindow: 1_000,
		};
		await fixture.lane.command((state) => {
			const operation = state.operation;
			if (operation === null) throw new Error("missing operation");
			return {
				kind: "commit",
				writes: [storedValues.setValue(storedValues.operationState(operationId), pending)],
				next: { ...state, operation: { meta: operation.meta, state: pending } },
				materialize: () => undefined,
			};
		}, BACKGROUND_CONTEXT);

		await recoverAssistantGeneration(fixture.lane, fixture.drive, pending);

		const entry = (await fixture.session.getEntry(responseEntryId, BACKGROUND_CONTEXT)) as MessageEntry;
		expect(entry.message).toMatchObject({
			api: "unknown",
			provider: ready.generationContext.configuration.model.provider,
			model: ready.generationContext.configuration.model.modelId,
			content: [],
			stopReason: "error",
			usage: { totalTokens: 0 },
		});
		expect(currentRun(fixture.lane)).toMatchObject({
			at: "assistant.retry_wait",
			nextAttempt: 2,
		});
		expect(fixture.faux.state.callCount).toBe(0);
		await expectProjectionRestores(fixture);
	});

	it("recovers an orphan from committed frames without a provider or response hook", async () => {
		const fixture = await createFixture();
		const ready = await advanceToReady(fixture);
		const responseEntryId = "01950000-0000-7000-8000-000000000030";
		const usageId = "01950000-0000-7000-8000-000000000031";
		const partial: AssistantMessage = {
			...fauxAssistantMessage([], { timestamp: 6 }),
			stopReason: "pending",
		};
		const pending: AssistantEffectPendingOperation = {
			...operationScopeOf(ready),
			at: "assistant.effect_pending",
			generationContext: { ...ready.generationContext, retryPolicy: { maxAttempts: 1, baseDelayMs: 1 } },
			attempt: 1,
			responseEntryId,
			usageId,
			intendedOutputLimit: 100,
			contextWindow: 1_000,
		};
		await fixture.lane.command((state) => {
			const operation = state.operation;
			if (operation === null) throw new Error("missing operation");
			return {
				kind: "commit",
				writes: [
					storedValues.setValue(storedValues.operationState(operationId), pending),
					storedValues.appendList(storedValues.pendingAssistantFrames(operationId, responseEntryId), {
						type: "start",
						partial,
					}),
					storedValues.appendList(storedValues.pendingAssistantFrames(operationId, responseEntryId), {
						type: "text_start",
						contentIndex: 0,
						content: { type: "text", text: "" },
					}),
					storedValues.appendList(storedValues.pendingAssistantFrames(operationId, responseEntryId), {
						type: "text_delta",
						contentIndex: 0,
						delta: "draft",
					}),
					storedValues.appendList(storedValues.pendingAssistantFrames(operationId, responseEntryId), {
						type: "text_end",
						contentIndex: 0,
						content: "corrected",
					}),
				],
				next: { ...state, operation: { meta: operation.meta, state: pending } },
				materialize: () => undefined,
			};
		}, BACKGROUND_CONTEXT);
		let afterResponseCalls = 0;
		fixture.hooks.on("after_response", () => {
			afterResponseCalls++;
			return undefined;
		});

		expect(await recoverAssistantGeneration(fixture.lane, fixture.drive, pending)).toMatchObject({
			kind: "settled",
			outcome: { operationId, kind: "run", status: "failed", tipId: responseEntryId },
		});

		expect(fixture.faux.state.callCount).toBe(0);
		expect(afterResponseCalls).toBe(0);
		const entry = (await fixture.session.getEntry(responseEntryId, BACKGROUND_CONTEXT)) as MessageEntry;
		expect(entry.message).toMatchObject({
			role: "assistant",
			content: [{ type: "text", text: "corrected" }],
			stopReason: "error",
			usage: { input: 0, output: 0 },
		});
		expect(fixture.lane.state.operation).toBeNull();
		expect(
			await fixture.session.readList(
				storedValues.pendingAssistantFrames(operationId, responseEntryId),
				undefined,
				BACKGROUND_CONTEXT,
			),
		).toEqual([]);
		expect(
			fixture.events.filter((event) => "recovery" in event && event.recovery).map((event) => event.type),
		).toEqual(["message_start", "message_end", "entry_added"]);
		await expectProjectionRestores(fixture);
	});

	it("finishes the no-tool run with terminal cleanup and an immutable result record", async () => {
		const fixture = await createFixture();
		const ready = await advanceToReady(fixture);
		fixture.faux.setResponses([fauxAssistantMessage("done", { timestamp: 7 })]);
		await runGeneration(fixture.lane, fixture.drive, ready);
		const run = currentRun(fixture.lane);
		if (run.at !== "checkpoint") throw new Error("missing terminal checkpoint");

		const result = await runCheckpoint(fixture.lane, fixture.drive, run);

		expect(result).toMatchObject({
			kind: "settled",
			outcome: { operationId, kind: "run", status: "completed", tipId: fixture.lane.state.tipId },
		});
		expect(fixture.lane.state.operation).toBeNull();
		expect(fixture.lane.state.lastOperationId).toBe(operationId);
		const getEntries = vi.spyOn(fixture.storage, "getEntries");
		expect(await fixture.lane.getResult(operationId, BACKGROUND_CONTEXT)).toMatchObject({
			operationId,
			kind: "run",
			status: "completed",
			tipId: fixture.lane.state.tipId,
		});
		expect(await fixture.lane.getResult("unknown", BACKGROUND_CONTEXT)).toBeUndefined();
		expect(getEntries).not.toHaveBeenCalled();
		expect(
			await fixture.session.getValue(storedValues.operationMeta(operationId), BACKGROUND_CONTEXT),
		).toBeUndefined();
		expect(
			await fixture.session.getValue(storedValues.operationState(operationId), BACKGROUND_CONTEXT),
		).toBeUndefined();
		expect(fixture.events.filter((event) => event.type === "run_end")).toHaveLength(1);
		await expectProjectionRestores(fixture);
	});
});

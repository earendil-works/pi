import { type AssistantMessageFrame, createModels, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type HarnessEvent, HarnessFault, type WatchHandle } from "../../../src/harness/agent-harness.ts";
import { DEFAULT_COMPACTION_SETTINGS } from "../../../src/harness/compaction/compaction.ts";
import { BACKGROUND_CONTEXT, type Context, createContextKey, withContextValue } from "../../../src/harness/context.ts";
import { createAgentHarness, Harness } from "../../../src/harness/runtime/harness.ts";
import { Lane } from "../../../src/harness/runtime/lane.ts";
import * as sessionWrites from "../../../src/harness/session/commit.ts";
import { MemoryStorage } from "../../../src/harness/session/memory.ts";
import { StorageBackedSession } from "../../../src/harness/session/session.ts";
import type {
	OperationMeta,
	OperationScope,
	OperationState,
	Session,
	StorageBranchScan,
	Write,
} from "../../../src/harness/session/types.ts";
import * as storedValues from "../../../src/harness/session/values.ts";
import { deferred } from "./test-utils.ts";

const sessions: Session[] = [];
const configuration = {
	model: { provider: "configured", modelId: "model" },
	thinkingLevel: "off" as const,
	activeToolNames: [],
};

async function createSession(storage: MemoryStorage = new MemoryStorage()): Promise<Session> {
	const session = new StorageBackedSession(
		{ id: `watch-${sessions.length}`, createdAt: 1, storageVersion: 1 },
		storage,
	);
	sessions.push(session);
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
	return session;
}

async function commit(session: Session, writes: Write[]): Promise<void> {
	await session.mutate((mutator) => mutator.commit(writes, BACKGROUND_CONTEXT), BACKGROUND_CONTEXT);
}

function runScope(control: OperationScope["control"] = { status: "running" }): OperationScope {
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

async function attach(
	session: Session,
): Promise<Lane<object | undefined> & Pick<Harness<object | undefined>, "events">> {
	const provider = fauxProvider();
	const models = createModels();
	models.setProvider(provider.provider);
	const { harness } = await createAgentHarness({ session, models, model: provider.getModel() }, BACKGROUND_CONTEXT);
	if (!(harness instanceof Harness)) throw new Error("Expected runtime Harness");
	const lane = await harness.lane("main", BACKGROUND_CONTEXT);
	if (!(lane instanceof Lane)) throw new Error("Expected runtime Lane");
	return Object.assign(lane, { events: harness.events });
}

class BlockingScanStorage extends MemoryStorage {
	block = false;
	readonly started = deferred();
	readonly release = deferred();

	override async scanBranch(query: StorageBranchScan, context: Context) {
		if (this.block) {
			this.started.resolve();
			await this.release.promise;
		}
		return super.scanBranch(query, context);
	}
}

afterEach(async () => {
	for (const session of sessions.splice(0)) await session.close(BACKGROUND_CONTEXT);
});

describe("runtime lane watch", () => {
	it("captures a compaction-bounded transcript and isolates the returned snapshot", async () => {
		const session = await createSession();
		await commit(session, [
			sessionWrites.insertEntry({ id: "root", parentId: null, type: "custom", customType: "root" }),
			sessionWrites.insertEntry({
				id: "compact",
				parentId: "root",
				type: "compaction",
				summary: "summary",
				retainedTail: [],
				tokensBefore: 10,
				fromHook: false,
			}),
			sessionWrites.insertEntry({
				id: "after",
				parentId: "compact",
				type: "message",
				message: { role: "user", content: "after", timestamp: 2 },
			}),
			storedValues.setValue(storedValues.branchTip("main"), "after"),
		]);
		const harness = await attach(session);

		const first = await harness.watch(BACKGROUND_CONTEXT);
		expect(first.snapshot.transcript.map(({ id }) => id)).toEqual(["compact", "after"]);
		expect(first.snapshot).toMatchObject({
			lane: "main",
			tipId: "after",
			configuration,
			stats: { messageCount: 1 },
			operation: null,
			queues: [],
			faulted: false,
		});
		first.snapshot.transcript.length = 0;
		first.snapshot.tipId = null;
		const second = await harness.watch(BACKGROUND_CONTEXT);
		expect(second.snapshot.transcript.map(({ id }) => id)).toEqual(["compact", "after"]);
		expect(second.snapshot.tipId).toBe("after");
		first.unsubscribe();
		second.unsubscribe();
	});

	it("dereferences queues, pending writes, and deferred handles", async () => {
		const session = await createSession();
		const handle = { provider: "provider", modelId: "model", api: "test", id: "deferred" };
		const sourceMessage = fauxAssistantMessage([], { stopReason: "deferred", deferred: handle });
		const ids = {
			next: "next",
			steer: "steer",
			follow: "follow",
			write: "write",
		};
		const payload = (content: string) => ({
			type: "message" as const,
			payload: { role: "user" as const, content, timestamp: 1 },
		});
		const operationId = session.idGenerator.next();
		const state: OperationState = {
			...runScope({ status: "cancel_requested", requestedAt: 2 }),
			at: "deferred.suspended",
			stepId: "step",
			sourceEntryId: "source",
			poll: 3,
			configuration,
			streamOptions: {},
		};
		const meta: OperationMeta = {
			operationId,
			lane: "main",
			sourceTipId: null,
			startedAt: 1,
			intent: { kind: "run", promptEntryIds: [] },
		};
		await commit(session, [
			sessionWrites.insertEntry({ id: "source", parentId: null, type: "message", message: sourceMessage }),
			...Object.values(ids).map((id) =>
				storedValues.setValue(
					storedValues.pendingEntry(id),
					id === ids.write ? { type: "custom", customType: "note", payload: { id } } : payload(id),
				),
			),
			storedValues.setValue(storedValues.operationMeta(operationId), meta),
			storedValues.setValue(storedValues.operationState(operationId), state),
			storedValues.setValue(storedValues.branchTip("main"), "source"),
			storedValues.setValue(storedValues.laneState("main"), {
				currentOperationId: operationId,
				lastOperationId: null,
				inbox: [
					{ entryId: ids.next, kind: "nextRun" },
					{ entryId: ids.steer, kind: "steer" },
					{ entryId: ids.follow, kind: "followUp" },
					{ entryId: ids.write, kind: "write" },
				],
			}),
		]);
		const harness = await attach(session);

		const watch = await harness.watch(BACKGROUND_CONTEXT);

		expect(watch.snapshot.queues).toMatchObject([
			{ entryId: ids.next, kind: "nextRun", type: "message", message: { content: ids.next } },
			{ entryId: ids.steer, kind: "steer", type: "message", message: { content: ids.steer } },
			{ entryId: ids.follow, kind: "followUp", type: "message", message: { content: ids.follow } },
			{ entryId: ids.write, kind: "write", type: "custom", customType: "note", data: { id: ids.write } },
		]);
		expect(watch.snapshot.operation).toMatchObject({
			id: operationId,
			status: "aborting",
			deferred: { handle, poll: 3 },
			runningTools: [],
		});
		watch.unsubscribe();
	});

	it("omits streaming presentation when an effect-pending response has no frames", async () => {
		const session = await createSession();
		const operationId = session.idGenerator.next();
		await commit(session, [
			storedValues.setValue(storedValues.operationMeta(operationId), {
				operationId,
				lane: "main",
				sourceTipId: null,
				startedAt: 1,
				intent: { kind: "run", promptEntryIds: [] },
			}),
			storedValues.setValue(storedValues.operationState(operationId), {
				...runScope(),
				at: "assistant.effect_pending",
				generationContext: {
					stepId: "step",
					triggerEntryId: "trigger",
					configuration,
					streamOptions: {},
					retryPolicy: { maxAttempts: 2, baseDelayMs: 0 },
					overflowRecoveryUsed: false,
				},
				attempt: 1,
				responseEntryId: "response-without-frames",
				usageId: "usage",
				intendedOutputLimit: 100,
				contextWindow: 1000,
			}),
			storedValues.setValue(storedValues.laneState("main"), {
				currentOperationId: operationId,
				lastOperationId: null,
				inbox: [],
			}),
		]);
		const harness = await attach(session);

		const watch = await harness.watch(BACKGROUND_CONTEXT);

		expect(watch.snapshot.operation).not.toHaveProperty("streamingMessage");
		watch.unsubscribe();
	});

	it("reduces assistant frames and projects running and settled tools with full-content indexes", async () => {
		const frameSession = await createSession();
		const partial = fauxAssistantMessage([], { stopReason: "pending" });
		const frames: AssistantMessageFrame[] = [
			{ type: "start", partial },
			{ type: "text_start", contentIndex: 0, content: { type: "text", text: "" } },
			{ type: "text_delta", contentIndex: 0, delta: "partial" },
		];
		const frameOperationId = frameSession.idGenerator.next();
		await commit(frameSession, [
			storedValues.setValue(storedValues.operationMeta(frameOperationId), {
				operationId: frameOperationId,
				lane: "main",
				sourceTipId: null,
				startedAt: 1,
				intent: { kind: "run", promptEntryIds: [] },
			}),
			storedValues.setValue(storedValues.operationState(frameOperationId), {
				...runScope(),
				at: "assistant.effect_pending",
				generationContext: {
					stepId: "step",
					triggerEntryId: "trigger",
					configuration,
					streamOptions: {},
					retryPolicy: { maxAttempts: 2, baseDelayMs: 0 },
					overflowRecoveryUsed: false,
				},
				attempt: 1,
				responseEntryId: "response",
				usageId: "usage",
				intendedOutputLimit: 100,
				contextWindow: 1000,
			}),
			...frames.map((frame) =>
				storedValues.appendList(storedValues.pendingAssistantFrames(frameOperationId, "response"), frame),
			),
			storedValues.setValue(storedValues.laneState("main"), {
				currentOperationId: frameOperationId,
				lastOperationId: null,
				inbox: [],
			}),
		]);
		const frameHarness = await attach(frameSession);
		const frameWatch = await frameHarness.watch(BACKGROUND_CONTEXT);
		expect(frameWatch.snapshot.operation?.streamingMessage?.content).toEqual([{ type: "text", text: "partial" }]);
		frameWatch.unsubscribe();

		const toolSession = await createSession();
		const toolUsage = {
			input: 1,
			output: 2,
			cacheRead: 3,
			cacheWrite: 4,
			totalTokens: 10,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		};
		const assistant = fauxAssistantMessage([
			{ type: "text", text: "before" },
			{ type: "toolCall", id: "call-completed", name: "completed", arguments: { source: "completed" } },
			{ type: "toolCall", id: "call-running", name: "read", arguments: { source: "running" } },
			{
				type: "toolCall",
				id: "call-without-checkpoint",
				name: "write",
				arguments: { source: "without-checkpoint" },
			},
			{ type: "toolCall", id: "call-ready", name: "real", arguments: { source: "real" } },
			{ type: "toolCall", id: "call-synthetic", name: "missing", arguments: { source: "synthetic" } },
			{ type: "toolCall", id: "call-planned", name: "planned", arguments: { source: "planned" } },
		]);
		const toolOperationId = toolSession.idGenerator.next();
		await commit(toolSession, [
			sessionWrites.insertEntry({ id: "assistant", parentId: null, type: "message", message: assistant }),
			storedValues.setValue(storedValues.operationMeta(toolOperationId), {
				operationId: toolOperationId,
				lane: "main",
				sourceTipId: null,
				startedAt: 1,
				intent: { kind: "run", promptEntryIds: [] },
			}),
			storedValues.setValue(storedValues.operationState(toolOperationId), {
				...runScope(),
				at: "tools",
				batch: {
					assistantEntryId: "assistant",
					configuration,
					turnId: "turn",
					calls: [
						{ status: "completed", sourceIndex: 1, resultEntryId: "completed", terminate: false },
						{ status: "effect_pending", sourceIndex: 2, resultEntryId: "result", replay: "safe" },
						{
							status: "effect_pending",
							sourceIndex: 3,
							resultEntryId: "without-checkpoint",
							replay: "never",
						},
						{ status: "outcome_ready", sourceIndex: 4, resultEntryId: "ready", terminate: true },
						{ status: "outcome_ready", sourceIndex: 5, resultEntryId: "synthetic", terminate: false },
						{ status: "planned", sourceIndex: 6, resultEntryId: "planned" },
					],
				},
			}),
			sessionWrites.insertEntry({
				id: "completed",
				parentId: "assistant",
				type: "message",
				message: {
					role: "toolResult",
					toolCallId: "call-completed",
					toolName: "completed",
					content: [{ type: "text", text: "completed" }],
					isError: false,
					timestamp: 2,
				},
			}),
			storedValues.setValue(storedValues.operationToolArgs(toolOperationId, "turn", 2), { path: "file" }),
			storedValues.setValue(storedValues.operationToolArgs(toolOperationId, "turn", 3), { path: "output" }),
			storedValues.setValue(storedValues.operationToolArgs(toolOperationId, "turn", 4), { path: "settled" }),
			storedValues.setValue(storedValues.pendingToolOutput(toolOperationId, "result"), {
				content: [{ type: "text", text: "partial" }],
				details: { bytes: 1 },
			}),
			storedValues.setValue(storedValues.pendingEntry("ready"), {
				type: "message",
				payload: {
					role: "toolResult",
					toolCallId: "call-ready",
					toolName: "real",
					content: [{ type: "text", text: "settled" }],
					details: { kind: "real" },
					usage: toolUsage,
					addedToolNames: ["later"],
					isError: false,
					timestamp: 3,
				},
			}),
			storedValues.setValue(storedValues.pendingEntry("synthetic"), {
				type: "message",
				payload: {
					role: "toolResult",
					toolCallId: "call-synthetic",
					toolName: "missing",
					content: [{ type: "text", text: "unavailable" }],
					isError: true,
					timestamp: 4,
				},
			}),
			storedValues.setValue(storedValues.branchTip("main"), "completed"),
			storedValues.setValue(storedValues.laneState("main"), {
				currentOperationId: toolOperationId,
				lastOperationId: null,
				inbox: [],
			}),
		]);
		const toolHarness = await attach(toolSession);
		const toolWatch = await toolHarness.watch(BACKGROUND_CONTEXT);
		expect(toolWatch.snapshot.transcript.map(({ id }) => id)).toEqual(["assistant", "completed"]);
		expect(toolWatch.snapshot.operation?.runningTools).toEqual([
			{
				status: "running",
				toolCallId: "call-running",
				toolName: "read",
				args: { path: "file" },
				result: { content: [{ type: "text", text: "partial" }], details: { bytes: 1 } },
			},
			{
				status: "running",
				toolCallId: "call-without-checkpoint",
				toolName: "write",
				args: { path: "output" },
			},
			{
				status: "settled",
				toolCallId: "call-ready",
				toolName: "real",
				args: { path: "settled" },
				result: {
					content: [{ type: "text", text: "settled" }],
					details: { kind: "real" },
					usage: toolUsage,
					addedToolNames: ["later"],
					terminate: true,
				},
				isError: false,
			},
			{
				status: "settled",
				toolCallId: "call-synthetic",
				toolName: "missing",
				args: { source: "synthetic" },
				result: {
					content: [{ type: "text", text: "unavailable" }],
					details: undefined,
				},
				isError: true,
			},
		]);
		expect(toolWatch.snapshot.operation?.runningTools[1]).not.toHaveProperty("result");
		toolWatch.unsubscribe();
	});

	it("faults missing or mismatched staged outcome-ready results", async () => {
		for (const corruption of ["missing", "mismatched"] as const) {
			const session = await createSession();
			const operationId = session.idGenerator.next();
			const writes: Write[] = [
				sessionWrites.insertEntry({
					id: "assistant",
					parentId: null,
					type: "message",
					message: fauxAssistantMessage([
						{ type: "toolCall", id: "call", name: "read", arguments: { path: "file" } },
					]),
				}),
				storedValues.setValue(storedValues.operationMeta(operationId), {
					operationId,
					lane: "main",
					sourceTipId: null,
					startedAt: 1,
					intent: { kind: "run", promptEntryIds: [] },
				}),
				storedValues.setValue(storedValues.operationState(operationId), {
					...runScope(),
					at: "tools",
					batch: {
						assistantEntryId: "assistant",
						configuration,
						turnId: "turn",
						calls: [{ status: "outcome_ready", sourceIndex: 0, resultEntryId: "result", terminate: false }],
					},
				}),
				storedValues.setValue(storedValues.branchTip("main"), "assistant"),
				storedValues.setValue(storedValues.laneState("main"), {
					currentOperationId: operationId,
					lastOperationId: null,
					inbox: [],
				}),
			];
			if (corruption === "mismatched") {
				writes.push(
					storedValues.setValue(storedValues.pendingEntry("result"), {
						type: "message",
						payload: {
							role: "toolResult",
							toolCallId: "other-call",
							toolName: "read",
							content: [],
							isError: false,
							timestamp: 2,
						},
					}),
				);
			}
			await commit(session, writes);
			const harness = await attach(session);

			await expect(harness.watch(BACKGROUND_CONTEXT)).rejects.toBeInstanceOf(HarnessFault);
		}
	});

	it("faults required payload corruption and unsubscribes the incomplete watcher", async () => {
		const session = await createSession();
		await commit(session, [
			storedValues.setValue(storedValues.laneState("main"), {
				currentOperationId: null,
				lastOperationId: null,
				inbox: [{ entryId: "missing", kind: "nextRun" }],
			}),
		]);
		const harness = await attach(session);
		let unsubscribed = false;
		const originalWatch = harness.events.watch.bind(harness.events);
		vi.spyOn(harness.events, "watch").mockImplementation(
			<T>(snapshot: T, filter: (event: HarnessEvent) => boolean, context: Context): WatchHandle<T> => {
				const handle = originalWatch(snapshot, filter, context);
				return {
					...handle,
					unsubscribe: () => {
						unsubscribed = true;
						handle.unsubscribe();
					},
				};
			},
		);

		await expect(harness.watch(BACKGROUND_CONTEXT)).rejects.toBeInstanceOf(HarnessFault);
		expect(unsubscribed).toBe(true);
	});

	it("returns snapshot-before plus buffered events when watch wins the lane line", async () => {
		const storage = new BlockingScanStorage();
		const session = await createSession(storage);
		await commit(session, [
			sessionWrites.insertEntry({ id: "root", parentId: null, type: "custom", customType: "root" }),
			storedValues.setValue(storedValues.branchTip("main"), "root"),
		]);
		const harness = await attach(session);
		storage.block = true;
		const watchPromise = harness.watch(BACKGROUND_CONTEXT);
		await storage.started.promise;
		const sourceKey = createContextKey<string>("watch.event.source");
		const sourceContext = withContextValue(sourceKey, "append", BACKGROUND_CONTEXT);
		const append = harness.appendMessage({ role: "user", content: "later", timestamp: 2 }, sourceContext);
		storage.release.resolve();
		const watch = await watchPromise;
		expect(watch.snapshot.transcript.map(({ id }) => id)).toEqual(["root"]);
		const seen: Array<{ type: string; sameContext: boolean }> = [];
		watch.start((event, eventContext) => {
			seen.push({ type: event.type, sameContext: eventContext === sourceContext });
		});
		await append;
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(seen.map(({ type }) => type)).toEqual(["message_start", "message_end", "entry_added"]);
		expect(seen.every(({ sameContext }) => sameContext)).toBe(true);
		watch.unsubscribe();
	});

	it("returns snapshot-after without replay when publication wins", async () => {
		const session = await createSession();
		const harness = await attach(session);
		const entryId = await harness.appendMessage(
			{ role: "user", content: "existing", timestamp: 1 },
			BACKGROUND_CONTEXT,
		);

		const watch = await harness.watch(BACKGROUND_CONTEXT);
		const seen = vi.fn();
		watch.start(seen);
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(watch.snapshot.transcript.map(({ id }) => id)).toEqual([entryId]);
		expect(seen).not.toHaveBeenCalled();
		watch.unsubscribe();
	});
});

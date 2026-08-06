import {
	type AssistantMessage,
	createModels,
	type DeferredHandle,
	fauxProvider,
	type Usage,
	type UserMessage,
} from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { AgentHarness, type HarnessTool } from "../../src/harness/agent-harness.ts";
import type { LaneReductionResult } from "../../src/harness/reducer.ts";
import {
	InMemorySessionStorage,
	type NewRecord,
	type OperationStartedRecord,
	type RecordQuery,
	Session,
} from "../../src/harness/session/index.ts";

const usage: Usage = {
	input: 1,
	output: 1,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 2,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function createSession(id = "restore-test"): { session: Session; storage: InMemorySessionStorage } {
	const storage = new InMemorySessionStorage({ id, createdAt: 1 });
	return { session: new Session(storage), storage };
}

function createRuntime() {
	const faux = fauxProvider({ provider: "restore-provider", models: [{ id: "restore-model" }] });
	const models = createModels();
	models.setProvider(faux.provider);
	return { models, model: faux.getModel() };
}

function userMessage(text: string): UserMessage {
	return { role: "user", content: text, timestamp: 1 };
}

function operationStarted(
	id: string,
	lane: string,
	intent: OperationStartedRecord["intent"],
	sourceLeafId: string | null = null,
): NewRecord<OperationStartedRecord> {
	return { type: "operation_started", id, lane, sourceLeafId, intent };
}

function deferredMessage(handle: DeferredHandle): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: handle.api,
		provider: handle.provider,
		model: handle.modelId,
		usage,
		stopReason: "deferred",
		deferred: handle,
		timestamp: 1,
	};
}

async function createHarness(session: Session, runtime = createRuntime()) {
	return AgentHarness.create({ session, models: runtime.models, model: runtime.model });
}

describe("AgentHarness restore acceptance", () => {
	it("opens an idle session with record history without writes or provider effects", async () => {
		const { session } = createSession();
		const runtime = createRuntime();
		const started = await session.appendRecord(
			operationStarted("finished-run", "main", {
				kind: "run",
				originalPrompt: [userMessage("finished")],
				initialMessages: [],
			}),
		);
		await session.appendRecord({
			type: "operation_finished",
			id: "finished-run-result",
			lane: "main",
			runId: started.id,
			outcome: "completed",
		});
		const logBefore = await session.getLog();
		const stream = vi.spyOn(runtime.models, "streamSimple");
		const fetchDeferred = vi.spyOn(runtime.models, "fetchDeferred");

		const { harness, suspended } = await createHarness(session, runtime);

		expect(suspended).toEqual([]);
		expect(await session.getLog()).toEqual(logBefore);
		expect(stream).not.toHaveBeenCalled();
		expect(fetchDeferred).not.toHaveBeenCalled();
		await harness.close();
	});

	it("inventories suspended run, compaction, and navigation operations without resuming them", async () => {
		const { session } = createSession();
		const prompt = userMessage("continue the run");
		const run = await session.appendRecord(
			operationStarted("run", "main", { kind: "run", originalPrompt: [prompt], initialMessages: [] }),
		);
		await session.createLane("compact", null);
		const compaction = await session.appendRecord(
			operationStarted("compact", "compact", { kind: "compaction", resultEntryId: "compaction-result" }),
		);
		await session.createLane("navigate", null);
		await session.appendEntry(
			{ type: "message", id: "navigation-source", message: userMessage("navigation source") },
			"navigate",
		);
		const navigation = await session.appendRecord(
			operationStarted(
				"navigate",
				"navigate",
				{ kind: "navigation", targetId: null, summarize: false },
				"navigation-source",
			),
		);
		const logBefore = await session.getLog();
		const runtime = createRuntime();
		const stream = vi.spyOn(runtime.models, "streamSimple");
		const fetchDeferred = vi.spyOn(runtime.models, "fetchDeferred");

		const { suspended } = await createHarness(session, runtime);

		expect(suspended).toHaveLength(3);
		expect(suspended).toEqual(
			expect.arrayContaining([
				{
					lane: "main",
					kind: "run",
					id: run.id,
					startedAt: run.timestamp,
					reason: "crash",
					prompt: [prompt],
					missing: { tools: [], models: [] },
				},
				{
					lane: "compact",
					kind: "compaction",
					id: compaction.id,
					startedAt: compaction.timestamp,
					reason: "crash",
					missing: { tools: [], models: [] },
				},
				{
					lane: "navigate",
					kind: "navigation",
					id: navigation.id,
					startedAt: navigation.timestamp,
					reason: "crash",
					missing: { tools: [], models: [] },
				},
			]),
		);
		expect(await session.getLog()).toEqual(logBefore);
		expect(stream).not.toHaveBeenCalled();
		expect(fetchDeferred).not.toHaveBeenCalled();
	});

	it("reports deferred and aborting details from durable state", async () => {
		const { session } = createSession();
		const runtime = createRuntime();
		const prompt = userMessage("run in the background");
		const steer = userMessage("focus on tests");
		const followUp = userMessage("then document it");
		const started = await session.appendRecord(
			operationStarted("run", "main", { kind: "run", originalPrompt: [prompt], initialMessages: [] }),
		);
		await session.appendRecord({
			type: "queue_enqueued",
			id: "steer-record",
			lane: "main",
			queue: "steer",
			runId: started.id,
			target: { type: "message", id: "steer-message", message: steer },
		});
		await session.appendRecord({
			type: "queue_enqueued",
			id: "follow-up-record",
			lane: "main",
			queue: "followUp",
			runId: started.id,
			target: { type: "message", id: "follow-up-message", message: followUp },
		});
		const handle: DeferredHandle = {
			provider: runtime.model.provider,
			modelId: runtime.model.id,
			api: runtime.model.api,
			id: "deferred-response",
			pollAfterMs: 100,
		};
		await session.appendRecord({
			type: "step_attempt",
			id: "assistant-attempt",
			lane: "main",
			runId: started.id,
			step: "assistant",
			attempt: 1,
			resultEntryId: "assistant-deferred",
		});
		await session.appendEntry(
			{ type: "message", id: "assistant-deferred", message: deferredMessage(handle) },
			"main",
		);
		await session.appendRecord({
			type: "abort_requested",
			id: "abort",
			lane: "main",
			runId: started.id,
		});

		const { suspended } = await createHarness(session, runtime);

		expect(suspended).toEqual([
			{
				lane: "main",
				kind: "run",
				id: started.id,
				startedAt: started.timestamp,
				reason: "deferred",
				prompt: [prompt],
				deferred: handle,
				aborting: { steer: [steer], followUp: [followUp] },
				missing: { tools: [], models: [] },
			},
		]);
	});

	it.each([
		{ name: "replay-safe", replay: "safe", aborting: false, expectedTools: ["missing-tool"] },
		{ name: "replay-never", replay: "never", aborting: false, expectedTools: [] },
		{ name: "aborting", replay: "safe", aborting: true, expectedTools: [] },
	] as const)("derives required tools for an unfinished $name batch", async ({ replay, aborting, expectedTools }) => {
		const { session } = createSession();
		const runtime = createRuntime();
		const started = await session.appendRecord(
			operationStarted("run", "main", { kind: "run", originalPrompt: [], initialMessages: [] }),
		);
		await session.appendRecord({
			type: "step_attempt",
			id: "assistant-attempt",
			lane: "main",
			runId: started.id,
			step: "assistant",
			attempt: 1,
			resultEntryId: "assistant-tools",
		});
		const assistant: AssistantMessage = {
			role: "assistant",
			content: [{ type: "toolCall", id: "call-1", name: "missing-tool", arguments: {} }],
			api: runtime.model.api,
			provider: runtime.model.provider,
			model: runtime.model.id,
			usage,
			stopReason: "toolUse",
			timestamp: 1,
		};
		await session.appendEntry({ type: "message", id: "assistant-tools", message: assistant }, "main");
		await session.appendRecord({
			type: "tool_started",
			id: "tool-started",
			lane: "main",
			runId: started.id,
			assistantEntryId: "assistant-tools",
			toolIndex: 0,
			toolCallId: "call-1",
			toolName: "missing-tool",
			effectiveArgs: {},
			resultEntryId: "tool-result",
			replay,
		});
		if (aborting) {
			await session.appendRecord({
				type: "abort_requested",
				id: "abort",
				lane: "main",
				runId: started.id,
			});
		}

		const { suspended } = await createHarness(session, runtime);

		expect(suspended).toHaveLength(1);
		expect(suspended[0]?.missing).toEqual({ tools: expectedTools, models: [] });
	});

	it("reports the tool required for an unfinished X1/X2 call without a tool-started record", async () => {
		const { session } = createSession();
		const runtime = createRuntime();
		const started = await session.appendRecord(
			operationStarted("run", "main", { kind: "run", originalPrompt: [], initialMessages: [] }),
		);
		await session.appendRecord({
			type: "step_attempt",
			id: "assistant-attempt",
			lane: "main",
			runId: started.id,
			step: "assistant",
			attempt: 1,
			resultEntryId: "assistant-tools",
		});
		await session.appendEntry(
			{
				type: "message",
				id: "assistant-tools",
				message: {
					role: "assistant",
					content: [{ type: "toolCall", id: "call-1", name: "missing-x1-tool", arguments: {} }],
					api: runtime.model.api,
					provider: runtime.model.provider,
					model: runtime.model.id,
					usage,
					stopReason: "toolUse",
					timestamp: 1,
				},
			},
			"main",
		);

		const { harness, suspended } = await createHarness(session, runtime);
		const restoredLanes = Reflect.get(harness, "restoredLanes") as Map<string, LaneReductionResult>;

		expect(restoredLanes.get("main")?.laneState.operation?.toolBatch?.calls[0]).toMatchObject({
			toolCall: { id: "call-1", name: "missing-x1-tool" },
			resultExists: false,
		});
		expect(restoredLanes.get("main")?.laneState.operation?.toolBatch?.calls[0]?.started).toBeUndefined();
		expect(suspended[0]?.missing).toEqual({ tools: ["missing-x1-tool"], models: [] });
	});

	it("does not require tools for a truncated batch", async () => {
		const { session } = createSession();
		const runtime = createRuntime();
		const started = await session.appendRecord(
			operationStarted("run", "main", { kind: "run", originalPrompt: [], initialMessages: [] }),
		);
		await session.appendRecord({
			type: "step_attempt",
			id: "assistant-attempt",
			lane: "main",
			runId: started.id,
			step: "assistant",
			attempt: 1,
			resultEntryId: "assistant-truncated",
		});
		await session.appendEntry(
			{
				type: "message",
				id: "assistant-truncated",
				message: {
					role: "assistant",
					content: [{ type: "toolCall", id: "call-1", name: "missing-tool", arguments: {} }],
					api: runtime.model.api,
					provider: runtime.model.provider,
					model: runtime.model.id,
					usage,
					stopReason: "length",
					timestamp: 1,
				},
			},
			"main",
		);

		const { harness, suspended } = await createHarness(session, runtime);
		const restoredLanes = Reflect.get(harness, "restoredLanes") as Map<string, LaneReductionResult>;

		expect(restoredLanes.get("main")?.laneState.operation?.toolBatch).toMatchObject({
			truncated: true,
			unresolved: true,
		});
		expect(suspended[0]?.missing).toEqual({ tools: [], models: [] });
	});

	it("rejects multiple open operations reported for one lane as corruption", async () => {
		const { session } = createSession();
		const first = await session.appendRecord(
			operationStarted("run-1", "main", { kind: "run", originalPrompt: [], initialMessages: [] }),
		);
		const second: OperationStartedRecord = {
			...first,
			id: "run-2",
			seq: first.seq + 1,
			timestamp: first.timestamp + 1,
		};
		vi.spyOn(session, "findOpenOperations").mockResolvedValue([second, first]);

		await expect(createHarness(session)).rejects.toMatchObject({
			name: "RecordLogCorruption",
			reason: "multiple_open_operations",
		});
	});

	it("uses bounded lane-local recovery queries and never scans all entries", async () => {
		const { session, storage } = createSession();
		await session.appendEntry({ type: "message", id: "anchor", message: userMessage("anchor") }, "main");
		const main = await session.appendRecord(
			operationStarted("main-finished", "main", { kind: "run", originalPrompt: [], initialMessages: [] }, "anchor"),
		);
		await session.appendRecord({
			type: "operation_finished",
			id: "main-finish",
			lane: "main",
			runId: main.id,
			outcome: "completed",
		});
		await session.createLane("thread", "anchor");
		const thread = await session.appendRecord(
			operationStarted(
				"thread-run",
				"thread",
				{
					kind: "run",
					originalPrompt: [userMessage("thread prompt")],
					initialMessages: [{ type: "message", id: "thread-prompt", message: userMessage("thread prompt") }],
				},
				"anchor",
			),
		);
		await session.appendEntry(
			{ type: "message", id: "thread-prompt", message: userMessage("thread prompt") },
			"thread",
		);
		const findOpenOperations = vi.spyOn(storage, "findOpenOperations");
		const findRecords = vi.spyOn(storage, "findRecords");
		const findEntries = vi.spyOn(storage, "findEntries");
		const findEntriesOnBranch = vi.spyOn(storage, "findEntriesOnBranch");
		const logBefore = await session.getLog();

		const { suspended } = await createHarness(session);

		expect(suspended.map((operation) => operation.lane)).toEqual(["thread"]);
		expect(findOpenOperations.mock.calls).toEqual([
			["main", { limit: 2 }],
			["thread", { limit: 2 }],
		]);
		const recordQueries = findRecords.mock.calls.map(([query]) => query as RecordQuery | undefined);
		expect(recordQueries.length).toBeGreaterThan(0);
		expect(recordQueries.every((query) => query?.lane !== undefined)).toBe(true);
		expect(recordQueries).toContainEqual(expect.objectContaining({ lane: "thread", afterSeq: thread.seq }));
		expect(findEntries).not.toHaveBeenCalled();
		expect(findEntriesOnBranch).toHaveBeenCalledWith(
			expect.objectContaining({ start: "thread-prompt", stopAtId: "anchor", order: "newestFirst" }),
		);
		expect(findEntriesOnBranch.mock.calls.every(([query]) => query.stopAtId !== undefined || query.limit === 1)).toBe(
			true,
		);
		expect(await session.getLog()).toEqual(logBefore);
	});

	it("reports missing persisted model and active-tool identities", async () => {
		const { session } = createSession();
		const runtime = createRuntime();
		await session.appendEntry(
			{ type: "model_change", id: "missing-model", provider: "missing-provider", modelId: "missing-model" },
			"main",
		);
		await session.appendEntry(
			{ type: "active_tools_change", id: "missing-tools", activeToolNames: ["missing-tool"] },
			"main",
		);
		await session.appendEntry(
			{ type: "thinking_level_change", id: "persisted-thinking", thinkingLevel: "high" },
			"main",
		);
		const sourceLeafId = await session.getLeafId();
		await session.appendRecord(
			operationStarted("run", "main", { kind: "run", originalPrompt: [], initialMessages: [] }, sourceLeafId),
		);

		const { harness, suspended } = await createHarness(session, runtime);
		const restoredLanes = Reflect.get(harness, "restoredLanes") as Map<string, LaneReductionResult>;

		expect(suspended).toHaveLength(1);
		expect(suspended[0]?.missing).toEqual({
			tools: ["missing-tool"],
			models: ["missing-provider/missing-model"],
		});
		expect(restoredLanes.get("main")?.effectiveConfiguration).toEqual({
			model: { provider: "missing-provider", modelId: "missing-model" },
			thinkingLevel: "high",
			activeToolNames: ["missing-tool"],
		});
	});

	it("does not require inactive identities to finish a completed structural operation", async () => {
		const { session } = createSession();
		const runtime = createRuntime();
		await session.appendEntry(
			{ type: "model_change", id: "missing-model", provider: "missing-provider", modelId: "missing-model" },
			"main",
		);
		await session.appendEntry(
			{ type: "active_tools_change", id: "missing-tools", activeToolNames: ["missing-tool"] },
			"main",
		);
		const sourceLeafId = await session.getLeafId();
		await session.appendRecord(
			operationStarted(
				"compaction",
				"main",
				{ kind: "compaction", resultEntryId: "compaction-result" },
				sourceLeafId,
			),
		);
		await session.appendEntry(
			{
				type: "compaction",
				id: "compaction-result",
				summary: "summary",
				retainedTail: [],
				tokensBefore: 1,
			},
			"main",
		);

		const { suspended } = await AgentHarness.create({
			session,
			models: createModels(),
			model: runtime.model,
		});

		expect(suspended[0]?.missing).toEqual({ tools: [], models: [] });
	});

	it("reports each unavailable effective and deferred model identity once", async () => {
		const { session } = createSession();
		const runtime = createRuntime();
		await session.appendEntry(
			{ type: "model_change", id: "missing-model", provider: "missing-provider", modelId: "missing-model" },
			"main",
		);
		const sourceLeafId = await session.getLeafId();
		const started = await session.appendRecord(
			operationStarted("run", "main", { kind: "run", originalPrompt: [], initialMessages: [] }, sourceLeafId),
		);
		const handle: DeferredHandle = {
			provider: "missing-provider",
			modelId: "missing-model",
			api: runtime.model.api,
			id: "missing-deferred",
		};
		await session.appendRecord({
			type: "step_attempt",
			id: "assistant-attempt",
			lane: "main",
			runId: started.id,
			step: "assistant",
			attempt: 1,
			resultEntryId: "assistant-deferred",
		});
		await session.appendEntry(
			{ type: "message", id: "assistant-deferred", message: deferredMessage(handle) },
			"main",
		);

		const { suspended } = await createHarness(session, runtime);

		expect(suspended[0]?.missing.models).toEqual(["missing-provider/missing-model"]);
	});

	it("accepts available active tools and unfinished batch tools", async () => {
		const { session } = createSession();
		const runtime = createRuntime();
		const tool = { name: "available-tool", label: "Available tool" } as HarnessTool;
		await session.appendEntry(
			{ type: "active_tools_change", id: "available-tools", activeToolNames: [tool.name] },
			"main",
		);
		const sourceLeafId = await session.getLeafId();
		const started = await session.appendRecord(
			operationStarted("run", "main", { kind: "run", originalPrompt: [], initialMessages: [] }, sourceLeafId),
		);
		await session.appendRecord({
			type: "step_attempt",
			id: "assistant-attempt",
			lane: "main",
			runId: started.id,
			step: "assistant",
			attempt: 1,
			resultEntryId: "assistant-tools",
		});
		await session.appendEntry(
			{
				type: "message",
				id: "assistant-tools",
				message: {
					role: "assistant",
					content: [{ type: "toolCall", id: "call-1", name: tool.name, arguments: {} }],
					api: runtime.model.api,
					provider: runtime.model.provider,
					model: runtime.model.id,
					usage,
					stopReason: "toolUse",
					timestamp: 1,
				},
			},
			"main",
		);
		await session.appendRecord({
			type: "tool_started",
			id: "tool-started",
			lane: "main",
			runId: started.id,
			assistantEntryId: "assistant-tools",
			toolIndex: 0,
			toolCallId: "call-1",
			toolName: tool.name,
			effectiveArgs: {},
			resultEntryId: "tool-result",
			replay: "safe",
		});

		const { suspended } = await AgentHarness.create({
			session,
			models: runtime.models,
			model: runtime.model,
			tools: [tool],
		});

		expect(suspended[0]?.missing).toEqual({ tools: [], models: [] });
	});

	it("restores effective configuration for an idle lane", async () => {
		const { session } = createSession();
		const runtime = createRuntime();
		await session.appendEntry(
			{
				type: "model_change",
				id: "persisted-model",
				provider: runtime.model.provider,
				modelId: runtime.model.id,
			},
			"main",
		);
		await session.appendEntry(
			{ type: "thinking_level_change", id: "persisted-thinking", thinkingLevel: "high" },
			"main",
		);
		await session.appendEntry(
			{ type: "active_tools_change", id: "persisted-tools", activeToolNames: ["persisted-tool"] },
			"main",
		);

		const { harness, suspended } = await createHarness(session, runtime);
		const restoredLanes = Reflect.get(harness, "restoredLanes") as Map<string, LaneReductionResult>;

		expect(suspended).toEqual([]);
		expect(restoredLanes.get("main")?.effectiveConfiguration).toEqual({
			model: { provider: runtime.model.provider, modelId: runtime.model.id },
			thinkingLevel: "high",
			activeToolNames: ["persisted-tool"],
		});
	});

	it("reports a missing model needed to redeem a deferred response", async () => {
		const { session } = createSession();
		const runtime = createRuntime();
		const started = await session.appendRecord(
			operationStarted("run", "main", { kind: "run", originalPrompt: [], initialMessages: [] }),
		);
		const handle: DeferredHandle = {
			provider: "missing-provider",
			modelId: "missing-deferred-model",
			api: runtime.model.api,
			id: "missing-deferred",
		};
		await session.appendRecord({
			type: "step_attempt",
			id: "assistant-attempt",
			lane: "main",
			runId: started.id,
			step: "assistant",
			attempt: 1,
			resultEntryId: "assistant-deferred",
		});
		await session.appendEntry(
			{ type: "message", id: "assistant-deferred", message: deferredMessage(handle) },
			"main",
		);

		const { suspended } = await createHarness(session, runtime);

		expect(suspended[0]).toMatchObject({
			reason: "deferred",
			deferred: handle,
			missing: { tools: [], models: ["missing-provider/missing-deferred-model"] },
		});
	});

	it("point-looks up provisioned recovery targets", async () => {
		const { session, storage } = createSession();
		const runtime = createRuntime();
		const prompt = userMessage("prompt");
		const started = await session.appendRecord(
			operationStarted("run", "main", {
				kind: "run",
				originalPrompt: [prompt],
				initialMessages: [{ type: "message", id: "prompt", message: prompt }],
			}),
		);
		await session.appendEntry({ type: "message", id: "prompt", message: prompt }, "main");
		await session.appendRecord({
			type: "step_attempt",
			id: "assistant-attempt",
			lane: "main",
			runId: started.id,
			step: "assistant",
			attempt: 1,
			resultEntryId: "assistant-tools",
		});
		await session.appendEntry(
			{
				type: "message",
				id: "assistant-tools",
				message: {
					role: "assistant",
					content: [{ type: "toolCall", id: "call-1", name: "tool", arguments: {} }],
					api: runtime.model.api,
					provider: runtime.model.provider,
					model: runtime.model.id,
					usage,
					stopReason: "toolUse",
					timestamp: 1,
				},
			},
			"main",
		);
		await session.appendRecord({
			type: "tool_started",
			id: "tool-started",
			lane: "main",
			runId: started.id,
			assistantEntryId: "assistant-tools",
			toolIndex: 0,
			toolCallId: "call-1",
			toolName: "tool",
			effectiveArgs: {},
			resultEntryId: "tool-result",
			replay: "safe",
		});
		await session.appendRecord({
			type: "queue_enqueued",
			id: "follow-up-record",
			lane: "main",
			queue: "followUp",
			runId: started.id,
			target: { type: "message", id: "follow-up", message: userMessage("follow up") },
		});
		await session.appendRecord({
			type: "write_deferred",
			id: "deferred-write-record",
			lane: "main",
			runId: started.id,
			target: { type: "message", id: "deferred-write", message: userMessage("write") },
		});
		await session.createLane("compact", null);
		const compaction = await session.appendRecord(
			operationStarted("compaction", "compact", { kind: "compaction", resultEntryId: "compaction-result" }),
		);
		await session.appendRecord({
			type: "step_attempt",
			id: "compaction-attempt",
			lane: "compact",
			runId: compaction.id,
			step: "compaction",
			attempt: 1,
			resultEntryId: "compaction-result",
			compactionReason: "manual",
		});
		const getEntry = vi.spyOn(storage, "getEntry");

		await createHarness(session, runtime);

		expect(getEntry.mock.calls.map(([id]) => id)).toEqual([
			"prompt",
			"assistant-tools",
			"tool-result",
			"follow-up",
			"deferred-write",
			"compaction-result",
		]);
	});

	it("finds provisioned-id content mismatches outside the lane branch", async () => {
		const { session } = createSession();
		await session.appendEntry(
			{ type: "message", id: "shared-id", message: userMessage("different payload") },
			"main",
		);
		await session.createLane("thread", null);
		await session.appendRecord(
			operationStarted("thread-run", "thread", {
				kind: "run",
				originalPrompt: [userMessage("expected payload")],
				initialMessages: [{ type: "message", id: "shared-id", message: userMessage("expected payload") }],
			}),
		);

		await expect(createHarness(session)).rejects.toMatchObject({
			name: "RecordLogCorruption",
			reason: "provisioned_entry_mismatch",
		});
	});

	it.each(["before_move", "after_move", "after_summary"] as const)(
		"restores move-first navigation at %s",
		async (phase) => {
			const { session, storage } = createSession(`navigation-${phase}`);
			await session.appendEntry({ type: "message", id: "target", message: userMessage("target") }, "main");
			await session.appendEntry({ type: "message", id: "source", message: userMessage("source") }, "main");
			const started = await session.appendRecord(
				operationStarted(
					"navigation",
					"main",
					{
						kind: "navigation",
						targetId: "target",
						summarize: true,
						summaryEntryId: "summary",
					},
					"source",
				),
			);
			if (phase !== "before_move") await session.moveLane("main", "target");
			if (phase === "after_summary") {
				await session.appendEntry(
					{
						type: "branch_summary",
						id: "summary",
						fromId: "source",
						summary: "summary",
					},
					"main",
				);
			}
			const logBefore = await session.getLog();
			const getEntry = vi.spyOn(storage, "getEntry");
			const findEntriesOnBranch = vi.spyOn(storage, "findEntriesOnBranch");

			const { harness, suspended } = await createHarness(session);
			const restoredLanes = Reflect.get(harness, "restoredLanes") as Map<string, LaneReductionResult>;
			const restored = restoredLanes.get("main")?.laneState;

			expect(suspended).toEqual([
				{
					lane: "main",
					kind: "navigation",
					id: started.id,
					startedAt: started.timestamp,
					reason: "crash",
					missing: { tools: [], models: [] },
				},
			]);
			expect(restored?.leafId).toBe(
				phase === "before_move" ? "source" : phase === "after_move" ? "target" : "summary",
			);
			expect(restored?.operation?.targets).toEqual({ summary: phase === "after_summary" });
			expect(restored?.operation?.newestOwn).toEqual(
				phase === "after_summary" ? { entryId: "summary", type: "branch_summary" } : null,
			);
			expect(getEntry).toHaveBeenCalledWith("summary");
			expect(findEntriesOnBranch.mock.calls).not.toContainEqual([expect.objectContaining({ stopAtId: "source" })]);
			expect(await session.getLog()).toEqual(logBefore);
		},
	);

	it("rejects a non-navigation leaf outside the operation source branch as corruption", async () => {
		const { session } = createSession("invalid-operation-branch");
		await session.appendEntry({ type: "message", id: "source", message: userMessage("source") }, "main");
		await session.createLane("other", null);
		await session.appendEntry({ type: "message", id: "unrelated", message: userMessage("unrelated") }, "other");
		await session.appendRecord(
			operationStarted("run", "main", { kind: "run", originalPrompt: [], initialMessages: [] }, "source"),
		);
		await session.moveLane("main", "unrelated");

		await expect(createHarness(session)).rejects.toMatchObject({
			name: "RecordLogCorruption",
			reason: "inconsistent_step",
		});
	});

	it("rejects a pre-operation descendant as operation-owned state", async () => {
		const { session } = createSession("pre-operation-descendant");
		await session.appendEntry({ type: "message", id: "source", message: userMessage("source") }, "main");
		await session.createLane("other", "source");
		await session.appendEntry(
			{ type: "message", id: "old-descendant", message: userMessage("old descendant") },
			"other",
		);
		await session.appendRecord(
			operationStarted("run", "main", { kind: "run", originalPrompt: [], initialMessages: [] }, "source"),
		);
		await session.moveLane("main", "old-descendant");

		await expect(createHarness(session)).rejects.toMatchObject({
			name: "RecordLogCorruption",
			reason: "inconsistent_step",
		});
	});

	it("rejects navigation leaves outside the move-first durable states as corruption", async () => {
		const { session } = createSession("navigation-invalid-leaf");
		await session.appendEntry({ type: "message", id: "target", message: userMessage("target") }, "main");
		await session.appendEntry({ type: "message", id: "unrelated", message: userMessage("unrelated") }, "main");
		await session.appendEntry({ type: "message", id: "source", message: userMessage("source") }, "main");
		await session.appendRecord(
			operationStarted(
				"navigation",
				"main",
				{
					kind: "navigation",
					targetId: "target",
					summarize: true,
					summaryEntryId: "summary",
				},
				"source",
			),
		);
		await session.moveLane("main", "unrelated");

		await expect(createHarness(session)).rejects.toMatchObject({
			name: "RecordLogCorruption",
			reason: "inconsistent_step",
		});
	});

	it("bounds idle next-run recovery after the latest run start", async () => {
		const { session, storage } = createSession();
		const captured = userMessage("captured by the previous run");
		const beforeCompaction = userMessage("queued before a newer compaction");
		const afterCompaction = userMessage("queued after the compaction");
		const cancelled = userMessage("do not run");
		await session.appendRecord({
			type: "queue_enqueued",
			id: "captured-record",
			lane: "main",
			queue: "nextRun",
			target: { type: "message", id: "captured", message: captured },
		});
		const latestRun = await session.appendRecord(
			operationStarted("finished-run", "main", {
				kind: "run",
				originalPrompt: [captured],
				initialMessages: [{ type: "message", id: "captured", message: captured }],
			}),
		);
		await session.appendRecord({
			type: "operation_finished",
			id: "run-finished",
			lane: "main",
			runId: latestRun.id,
			outcome: "completed",
		});
		await session.appendRecord({
			type: "queue_enqueued",
			id: "before-compaction-record",
			lane: "main",
			queue: "nextRun",
			target: { type: "message", id: "before-compaction", message: beforeCompaction },
		});
		const compaction = await session.appendRecord(
			operationStarted("newer-compaction", "main", { kind: "compaction", resultEntryId: "unused-result" }),
		);
		await session.appendRecord({
			type: "operation_finished",
			id: "compaction-finished",
			lane: "main",
			runId: compaction.id,
			outcome: "declined",
		});
		await session.appendRecord({
			type: "queue_enqueued",
			id: "after-compaction-record",
			lane: "main",
			queue: "nextRun",
			target: { type: "message", id: "after-compaction", message: afterCompaction },
		});
		await session.appendRecord({
			type: "queue_enqueued",
			id: "cancelled-record",
			lane: "main",
			queue: "nextRun",
			target: { type: "message", id: "cancelled", message: cancelled },
		});
		await session.appendRecord({
			type: "queue_cancelled",
			id: "cancellation",
			lane: "main",
			entryId: "cancelled",
		});
		const findRecords = vi.spyOn(storage, "findRecords");
		const logBefore = await session.getLog();

		const { harness, suspended } = await createHarness(session);
		const restoredLanes = Reflect.get(harness, "restoredLanes") as Map<string, LaneReductionResult>;
		const recordQueries = findRecords.mock.calls.map(([query]) => query as RecordQuery | undefined);

		expect(suspended).toEqual([]);
		expect(restoredLanes.get("main")?.laneState.pendingNextRun).toEqual([
			{ type: "message", id: "before-compaction", message: beforeCompaction },
			{ type: "message", id: "after-compaction", message: afterCompaction },
		]);
		expect(recordQueries).toEqual([
			{
				lane: "main",
				type: "operation_started",
				operationKind: "run",
				order: "newestFirst",
				limit: 1,
			},
			{
				lane: "main",
				type: "queue_enqueued",
				afterSeq: latestRun.seq,
				order: "oldestFirst",
			},
			{
				lane: "main",
				type: "queue_cancelled",
				afterSeq: latestRun.seq,
				order: "oldestFirst",
			},
		]);
		expect(await session.getLog()).toEqual(logBefore);
	});

	it("keeps getLeafId synchronized with direct session writes", async () => {
		const { session } = createSession();
		const { harness } = await createHarness(session);

		const entryId = await harness.session.appendMessage(userMessage("appended after restore"));

		expect(await harness.getLeafId()).toBe(entryId);
	});
});

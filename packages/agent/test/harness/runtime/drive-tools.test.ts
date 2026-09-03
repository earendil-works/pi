import {
	createModels,
	fauxAssistantMessage,
	fauxProvider,
	fauxToolCall,
	type ToolResultMessage,
} from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HarnessEvent, WatchHandle } from "../../../src/harness/agent-harness.ts";
import { DEFAULT_COMPACTION_SETTINGS } from "../../../src/harness/compaction/compaction.ts";
import { BACKGROUND_CONTEXT, type Context } from "../../../src/harness/context.ts";
import { HookRegistry } from "../../../src/harness/hooks.ts";
import { runTools } from "../../../src/harness/runtime/drive/tools.ts";
import { Lane } from "../../../src/harness/runtime/lane.ts";
import { restoreLane } from "../../../src/harness/runtime/restore.ts";
import { type Config, Drive } from "../../../src/harness/runtime/types.ts";
import { insertEntry } from "../../../src/harness/session/commit.ts";
import { MemoryStorage } from "../../../src/harness/session/memory.ts";
import { StorageBackedSession } from "../../../src/harness/session/session.ts";
import type {
	LaneConfiguration,
	OperationState,
	Session,
	ToolCall,
	ToolsOperation,
	Write,
} from "../../../src/harness/session/types.ts";
import * as storedValues from "../../../src/harness/session/values.ts";
import type {
	AgentHarnessTool,
	AgentHarnessToolInvocation,
	AgentHarnessToolUpdateCallback,
} from "../../../src/harness/types.ts";

const sessions: Session[] = [];
const schema = Type.Object({ value: Type.String() });

interface Fixture {
	session: Session;
	lane: Lane<undefined>;
	drive: Drive;
	hooks: HookRegistry;
	events: HarnessEvent[];
	assistantEntryId: string;
	resultEntryIds: string[];
	operationId: string;
	observations: string[];
}

interface FixtureOptions {
	calls: Array<{ name: string; value?: string }>;
	tools?: AgentHarnessTool<undefined>[];
	mode?: "sequential" | "parallel";
	stopReason?: "toolUse" | "length";
	callStates?: (resultEntryIds: string[]) => ToolCall[];
	extraWrites?: (fixture: {
		operationId: string;
		assistantEntryId: string;
		resultEntryIds: string[];
		run: ToolsOperation;
	}) => Write[];
	toolContext?: Config<undefined>["toolContext"];
	cancelled?: boolean;
	onEmit?: (events: readonly HarnessEvent[]) => Promise<void>;
}

function unusedWatch<T>(): WatchHandle<T> {
	throw new Error("watch is not used by tool procedure tests");
}

class ObservedMemoryStorage extends MemoryStorage {
	readonly observations: string[] = [];

	override async commit(writes: Write[], context: Context) {
		const result = await super.commit(writes, context);
		if (
			writes.some((write) => write.kind === "value" && write.op === "set" && write.namespace === "pi.op.tool_args")
		) {
			this.observations.push("intent_commit");
		}
		const stagesOutcome = writes.some(
			(write) => write.kind === "value" && write.op === "set" && write.namespace === "pi.pending.entry",
		);
		if (stagesOutcome) this.observations.push("outcome_commit");
		if (
			!stagesOutcome &&
			writes.some(
				(write) => write.kind === "value" && write.op === "delete" && write.namespace === "pi.pending.tool_output",
			)
		) {
			this.observations.push("replay_commit");
		}
		return result;
	}
}

function deferred<T = void>(): { promise: Promise<T>; resolve(value: T): void } {
	let resolvePromise: ((value: T) => void) | undefined;
	const promise = new Promise<T>((resolve) => {
		resolvePromise = resolve;
	});
	return { promise, resolve: (value) => resolvePromise?.(value) };
}

async function waitFor(predicate: () => boolean): Promise<void> {
	for (let index = 0; index < 200; index += 1) {
		if (predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 0));
	}
	throw new Error("condition was not reached");
}

function tool(
	name: string,
	execute: (
		value: string,
		onUpdate: AgentHarnessToolUpdateCallback<{ progress?: string }> | undefined,
		invocation: AgentHarnessToolInvocation,
		context: Parameters<AgentHarnessTool<undefined>["execute"]>[5],
	) => Promise<{
		content: Array<{ type: "text"; text: string }>;
		details: { value?: string };
		usage?: ToolResultMessage["usage"];
		addedToolNames?: string[];
		terminate?: boolean;
	}>,
	replay: "never" | "safe" = "never",
): AgentHarnessTool<undefined, typeof schema, { progress?: string } | { value?: string }> {
	return {
		name,
		label: name,
		description: name,
		parameters: schema,
		replay,
		execute: async (_toolCallId, args, onUpdate, _toolContext, invocation, context) =>
			execute(args.value, onUpdate, invocation, context),
	};
}

async function createFixture(options: FixtureOptions): Promise<Fixture> {
	const storage = new ObservedMemoryStorage({ now: () => 100 });
	const session = new StorageBackedSession(
		{ id: `drive-tools-${sessions.length}`, createdAt: 1, storageVersion: 1 },
		storage,
	);
	sessions.push(session);
	const operationId = session.idGenerator.next(10);
	const assistantEntryId = session.idGenerator.next(20);
	const resultEntryIds = options.calls.map(() => session.idGenerator.next(20));
	const faux = fauxProvider();
	const model = faux.getModel();
	const configuration: LaneConfiguration = {
		model: { provider: model.provider, modelId: model.id },
		thinkingLevel: "off",
		activeToolNames: options.calls.map(({ name }) => name),
	};
	const assistant = fauxAssistantMessage(
		options.calls.map(({ name, value = name }, index) => fauxToolCall(name, { value }, { id: `call-${index}` })),
		{ stopReason: options.stopReason ?? "toolUse", timestamp: 20 },
	);
	const calls =
		options.callStates?.(resultEntryIds) ??
		resultEntryIds.map((resultEntryId, index) => ({
			status: "planned" as const,
			sourceIndex: index,
			resultEntryId,
		}));
	const run: ToolsOperation = {
		at: "tools",
		control: options.cancelled ? { status: "cancel_requested", requestedAt: 30 } : { status: "running" },
		settings: {
			compaction: DEFAULT_COMPACTION_SETTINGS,
			steeringMode: "all",
			followUpMode: "all",
			toolExecution: options.mode ?? "parallel",
		},
		batch: { assistantEntryId, configuration, turnId: "turn-1", calls },
		latestAssistantEntryId: assistantEntryId,
	};
	const writes: Write[] = [
		insertEntry({ id: assistantEntryId, parentId: null, type: "message", message: assistant }),
		storedValues.setValue(storedValues.branchTip("main"), assistantEntryId),
		storedValues.setValue(storedValues.laneConfig("main"), configuration),
		storedValues.setValue(storedValues.laneState("main"), {
			currentOperationId: operationId,
			lastOperationId: null,
			inbox: [],
		}),
		storedValues.setValue(storedValues.operationMeta(operationId), {
			operationId,
			lane: "main",
			sourceTipId: null,
			startedAt: 10,
			intent: { kind: "run", promptEntryIds: [] },
		}),
		storedValues.setValue(storedValues.operationState(operationId), run),
		...(options.extraWrites?.({ operationId, assistantEntryId, resultEntryIds, run }) ?? []),
	];
	await session.mutate((mutator) => mutator.commit(writes, BACKGROUND_CONTEXT), BACKGROUND_CONTEXT);

	const models = createModels();
	models.setProvider(faux.provider);
	const hooks = new HookRegistry(() => {});
	const events: HarnessEvent[] = [];
	const config: Config<undefined> = {
		tools: options.tools ?? [],
		resources: {},
		streamOptions: {},
		retryPolicy: { enabled: false, maxRetries: 0, baseDelayMs: 0 },
		compaction: DEFAULT_COMPACTION_SETTINGS,
		steeringMode: "all",
		followUpMode: "all",
		toolExecution: options.mode ?? "parallel",
		toolContext: options.toolContext,
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
		async (batch) => {
			events.push(...structuredClone(batch));
			storage.observations.push(...batch.map((event) => event.type));
			await options.onEmit?.(batch);
		},
		unusedWatch,
		() => config,
	);
	const drive = new Drive({ operationId }, BACKGROUND_CONTEXT);
	lane.activeDrive = drive;
	return {
		session,
		lane,
		drive,
		hooks,
		events,
		assistantEntryId,
		resultEntryIds,
		operationId,
		observations: storage.observations,
	};
}

function currentRun(fixture: Fixture): OperationState {
	const operation = fixture.lane.state.operation;
	if (operation === null) throw new Error("fixture has no operation");
	return operation.state;
}

function currentCalls(fixture: Fixture): ToolCall[] {
	const run = currentRun(fixture);
	if (run.at !== "tools") return [];
	return run.batch.calls;
}

async function driveTools(fixture: Fixture) {
	const run = currentRun(fixture);
	if (run.at !== "tools") throw new Error("fixture has no tool batch");
	return runTools(fixture.lane, fixture.drive, run);
}

async function expectProjectionRestores(fixture: Fixture): Promise<void> {
	expect(await restoreLane(fixture.session, "main", BACKGROUND_CONTEXT)).toEqual(fixture.lane.state);
}

afterEach(async () => {
	await Promise.all(sessions.splice(0).map((session) => session.close(BACKGROUND_CONTEXT)));
});

describe("durable tool batch", () => {
	it("executes a sequential batch with memos, checkpoints, hooks, usage, and source-order placement", async () => {
		let contextResolutions = 0;
		let lateInvocation: AgentHarnessToolInvocation | undefined;
		const usage = {
			input: 1,
			output: 2,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 3,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		};
		const first = tool("first", async (value, onUpdate, invocation) => {
			lateInvocation = invocation;
			await invocation.setMemo("step/a", { value: "memo" });
			expect(await invocation.getMemo("step/a")).toEqual({ value: "memo" });
			onUpdate?.(
				{ content: [{ type: "text", text: "partial" }], details: { progress: "partial" } },
				{ checkpoint: true },
			);
			return { content: [{ type: "text", text: value }], details: { value }, usage };
		});
		const second = tool("second", async (value) => ({
			content: [{ type: "text", text: value }],
			details: { value },
			addedToolNames: ["introduced"],
		}));
		const fixture = await createFixture({
			calls: [{ name: "first" }, { name: "second" }],
			tools: [first, second],
			mode: "sequential",
			toolContext: () => {
				contextResolutions += 1;
				return undefined;
			},
		});
		let checkpointSeenByAfterHook = false;
		fixture.hooks.on("before_tool", ({ toolName, args }) =>
			toolName === "first" ? { args: { ...args, value: "prepared" } } : undefined,
		);
		fixture.hooks.on("after_tool", async ({ toolName }) => {
			if (toolName === "first") {
				checkpointSeenByAfterHook =
					(await fixture.session.getValue(
						storedValues.pendingToolOutput(fixture.operationId, fixture.resultEntryIds[0]!),
						BACKGROUND_CONTEXT,
					)) !== undefined;
			}
			return undefined;
		});

		expect(await driveTools(fixture)).toEqual({ kind: "continue" });
		const transcript = await fixture.lane.findEntries({ order: "oldestFirst" }, BACKGROUND_CONTEXT);
		expect(transcript.map(({ id }) => id)).toEqual([fixture.assistantEntryId, ...fixture.resultEntryIds]);
		expect(transcript[1]?.type === "message" ? transcript[1].message : undefined).toMatchObject({
			role: "toolResult",
			content: [{ type: "text", text: "prepared" }],
		});
		expect(contextResolutions).toBe(1);
		expect(checkpointSeenByAfterHook).toBe(true);
		expect(currentRun(fixture)).toMatchObject({
			at: "checkpoint",
			continuation: { kind: "need_assistant" },
		});
		expect(fixture.lane.state.configuration.activeToolNames).toEqual(["first", "second", "introduced"]);
		expect(
			await fixture.session.scanValues(
				storedValues.operationToolArgsPrefix(fixture.operationId),
				BACKGROUND_CONTEXT,
			),
		).toEqual([]);
		expect(
			await fixture.session.scanValues(
				storedValues.operationToolMemoPrefix(fixture.operationId),
				BACKGROUND_CONTEXT,
			),
		).toEqual([]);
		expect(
			await fixture.session.getValue(
				storedValues.pendingToolOutput(fixture.operationId, fixture.resultEntryIds[0]!),
				BACKGROUND_CONTEXT,
			),
		).toBeUndefined();
		await expect(lateInvocation?.setMemo("late", true)).rejects.toThrow("no longer owns");
		const eventTypes = fixture.events.map(({ type }) => type);
		expect(eventTypes.indexOf("tool_update")).toBeLessThan(eventTypes.indexOf("tool_end"));
		const firstIntent = fixture.observations.indexOf("intent_commit");
		const firstStart = fixture.observations.indexOf("tool_start");
		const firstUpdate = fixture.observations.indexOf("tool_update");
		const firstCommit = fixture.observations.indexOf("outcome_commit");
		const firstEnd = fixture.observations.indexOf("tool_end");
		const firstPlacement = fixture.observations.indexOf("entry_added");
		expect(firstIntent).toBeLessThan(firstStart);
		expect(firstStart).toBeLessThan(firstUpdate);
		expect(firstUpdate).toBeLessThan(firstCommit);
		expect(firstCommit).toBeLessThan(firstEnd);
		expect(firstEnd).toBeLessThan(firstPlacement);
		expect(fixture.events.filter(({ type }) => type === "entry_added")).toHaveLength(2);
		expect(fixture.events.filter(({ type }) => type === "usage")).toHaveLength(1);
		expect(fixture.events.at(-1)?.type).toBe("turn_end");
		await expectProjectionRestores(fixture);
	});

	it("stages parallel completion order but materializes source order", async () => {
		const finishA = deferred<void>();
		const finishB = deferred<void>();
		const started: string[] = [];
		const make = (name: string, finish: ReturnType<typeof deferred<void>>) =>
			tool(name, async () => {
				started.push(name);
				await finish.promise;
				return { content: [{ type: "text", text: name }], details: { value: name } };
			});
		const fixture = await createFixture({
			calls: [{ name: "a" }, { name: "b" }],
			tools: [make("a", finishA), make("b", finishB)],
			mode: "parallel",
		});
		const running = driveTools(fixture);
		await waitFor(() => started.length === 2);
		finishB.resolve();
		await waitFor(() => currentCalls(fixture)[1]?.status === "outcome_ready");
		expect(currentCalls(fixture).map(({ status }) => status)).toEqual(["effect_pending", "outcome_ready"]);
		expect(await fixture.session.getEntry(fixture.resultEntryIds[1]!, BACKGROUND_CONTEXT)).toBeUndefined();
		expect(fixture.events.find((event) => event.type === "tool_start" && event.toolName === "b")).toMatchObject({
			args: { value: "b" },
		});
		expect(fixture.events.find((event) => event.type === "tool_end" && event.toolName === "b")).toMatchObject({
			result: { content: [{ type: "text", text: "b" }] },
		});
		finishA.resolve();
		await running;

		const transcript = await fixture.lane.findEntries({ order: "oldestFirst" }, BACKGROUND_CONTEXT);
		expect(transcript.map(({ id }) => id)).toEqual([
			fixture.assistantEntryId,
			fixture.resultEntryIds[0],
			fixture.resultEntryIds[1],
		]);
		await expectProjectionRestores(fixture);
	});

	it("safe-replays persisted arguments and memos while interrupting unsafe effects", async () => {
		const safeExecute = vi.fn(async (_value: string, _onUpdate: unknown, invocation: AgentHarnessToolInvocation) => {
			expect(invocation.invocationId).toBeDefined();
			expect(await invocation.getMemo("step/a")).toEqual({ complete: true });
			return { content: [{ type: "text" as const, text: "safe replay" }], details: { value: "safe" } };
		});
		const unsafeExecute = vi.fn(async () => ({
			content: [{ type: "text" as const, text: "must not run" }],
			details: {},
		}));
		const fixture = await createFixture({
			calls: [{ name: "safe" }, { name: "unsafe" }],
			tools: [tool("safe", safeExecute, "safe"), tool("unsafe", unsafeExecute, "never")],
			callStates: (ids) => [
				{ status: "effect_pending", sourceIndex: 0, resultEntryId: ids[0]!, replay: "safe" },
				{ status: "effect_pending", sourceIndex: 1, resultEntryId: ids[1]!, replay: "never" },
			],
			extraWrites: ({ operationId, resultEntryIds }) => [
				storedValues.setValue(storedValues.operationToolArgs(operationId, "turn-1", 0), { value: "persisted" }),
				storedValues.setValue(storedValues.operationToolArgs(operationId, "turn-1", 1), { value: "unsafe" }),
				storedValues.setValue(storedValues.operationToolMemo(operationId, resultEntryIds[0]!, "step/a"), {
					complete: true,
				}),
				storedValues.setValue(storedValues.pendingToolOutput(operationId, resultEntryIds[0]!), {
					content: [{ type: "text", text: "old progress" }],
					details: {},
				}),
				storedValues.setValue(storedValues.pendingToolOutput(operationId, resultEntryIds[1]!), {
					content: [{ type: "text", text: "durable partial" }],
					details: { progress: "kept" },
				}),
			],
		});

		await driveTools(fixture);
		expect(safeExecute).toHaveBeenCalledOnce();
		expect(safeExecute.mock.calls[0]?.[0]).toBe("persisted");
		expect(unsafeExecute).not.toHaveBeenCalled();
		expect(
			fixture.events.find((event) => event.type === "tool_start" && event.toolCallId === "call-0"),
		).toMatchObject({ recovery: true, args: { value: "persisted" } });
		expect(fixture.observations.indexOf("replay_commit")).toBeLessThan(fixture.observations.indexOf("tool_start"));
		expect(fixture.events.find((event) => event.type === "tool_end" && event.toolCallId === "call-0")).toMatchObject({
			recovery: true,
			isError: false,
		});
		const unsafeEntry = await fixture.session.getEntry(fixture.resultEntryIds[1]!, BACKGROUND_CONTEXT);
		expect(unsafeEntry?.type === "message" ? unsafeEntry.message : undefined).toMatchObject({
			role: "toolResult",
			isError: true,
			details: { progress: "kept" },
		});
		expect(
			unsafeEntry?.type === "message" && unsafeEntry.message.role === "toolResult"
				? unsafeEntry.message.content.at(-1)
				: undefined,
		).toMatchObject({ type: "text", text: expect.stringContaining("external outcome is unknown") });
		expect(fixture.events.some((event) => event.type === "tool_start" && event.toolCallId === "call-1")).toBe(false);
		expect(fixture.events.find((event) => event.type === "tool_end" && event.toolCallId === "call-1")).toMatchObject({
			recovery: true,
			isError: true,
		});
	});

	it("reconciles a restored cancelled batch without hooks, context, or effects", async () => {
		const execute = vi.fn(async () => ({ content: [], details: {} }));
		const context = vi.fn(() => undefined);
		const fixture = await createFixture({
			calls: [{ name: "planned" }, { name: "pending" }],
			tools: [tool("planned", execute), tool("pending", execute, "safe")],
			toolContext: context,
			cancelled: true,
			callStates: (ids) => [
				{ status: "planned", sourceIndex: 0, resultEntryId: ids[0]! },
				{ status: "effect_pending", sourceIndex: 1, resultEntryId: ids[1]!, replay: "safe" },
			],
			extraWrites: ({ operationId, resultEntryIds }) => [
				storedValues.setValue(storedValues.operationToolArgs(operationId, "turn-1", 1), { value: "pending" }),
				storedValues.setValue(storedValues.pendingToolOutput(operationId, resultEntryIds[1]!), {
					content: [{ type: "text", text: "checkpoint" }],
					details: {},
				}),
			],
		});
		const beforeTool = vi.fn(() => undefined);
		const afterTool = vi.fn(() => undefined);
		fixture.hooks.on("before_tool", beforeTool);
		fixture.hooks.on("after_tool", afterTool);

		await driveTools(fixture);
		expect(execute).not.toHaveBeenCalled();
		expect(context).not.toHaveBeenCalled();
		expect(beforeTool).not.toHaveBeenCalled();
		expect(afterTool).not.toHaveBeenCalled();
		expect(currentRun(fixture)).toMatchObject({
			at: "checkpoint",
			control: { status: "cancel_requested" },
			continuation: { kind: "need_assistant" },
		});
		const pending = await fixture.session.getEntry(fixture.resultEntryIds[1]!, BACKGROUND_CONTEXT);
		expect(
			pending?.type === "message" && pending.message.role === "toolResult"
				? pending.message.content.at(-1)
				: undefined,
		).toMatchObject({ type: "text", text: expect.stringContaining("external outcome is unknown") });
		const starts = fixture.events.filter((event) => event.type === "tool_start");
		const ends = fixture.events.filter((event) => event.type === "tool_end");
		expect(starts).toHaveLength(1);
		expect(starts[0]).toMatchObject({ toolName: "planned", args: { value: "planned" } });
		expect(ends).toHaveLength(2);
		expect(ends.find((event) => event.toolCallId === starts[0]?.toolCallId)).toMatchObject({ isError: true });
	});

	it("materializes outcome-ready state without resolving tools or tool context", async () => {
		const execute = vi.fn(async () => ({ content: [], details: {} }));
		const context = vi.fn(() => undefined);
		const staged: ToolResultMessage = {
			role: "toolResult",
			toolCallId: "call-0",
			toolName: "ready",
			content: [{ type: "text", text: "already done" }],
			addedToolNames: ["later"],
			isError: false,
			timestamp: 30,
		};
		const fixture = await createFixture({
			calls: [{ name: "ready" }],
			tools: [tool("ready", execute)],
			toolContext: context,
			callStates: (ids) => [{ status: "outcome_ready", sourceIndex: 0, resultEntryId: ids[0]!, terminate: true }],
			extraWrites: ({ resultEntryIds }) => [
				storedValues.setValue(storedValues.pendingEntry(resultEntryIds[0]!), {
					type: "message",
					payload: staged,
				}),
			],
		});

		await driveTools(fixture);
		expect(execute).not.toHaveBeenCalled();
		expect(context).not.toHaveBeenCalled();
		expect(currentRun(fixture)).toMatchObject({
			at: "checkpoint",
			continuation: { kind: "may_finish", includeFinalAssistant: false },
		});
		expect(fixture.lane.state.configuration.activeToolNames).toEqual(["ready", "later"]);
		expect(fixture.events[0]).toMatchObject({ type: "turn_start", turnId: "turn-1", recovery: true });
		expect(fixture.events.at(-1)).toMatchObject({ type: "turn_end", turnId: "turn-1", recovery: true });
	});

	it("never executes genuine-length or missing tool calls", async () => {
		const execute = vi.fn(async () => ({ content: [], details: {} }));
		const truncated = await createFixture({
			calls: [{ name: "present" }],
			tools: [tool("present", execute)],
			stopReason: "length",
		});
		const truncatedAfterTool = vi.fn(() => undefined);
		truncated.hooks.on("after_tool", truncatedAfterTool);
		await driveTools(truncated);
		expect(execute).not.toHaveBeenCalled();
		const truncatedEntry = await truncated.session.getEntry(truncated.resultEntryIds[0]!, BACKGROUND_CONTEXT);
		expect(
			truncatedEntry?.type === "message" && truncatedEntry.message.role === "toolResult"
				? truncatedEntry.message.content[0]
				: undefined,
		).toMatchObject({ type: "text", text: expect.stringContaining("arguments may be truncated") });
		expect(truncatedAfterTool).not.toHaveBeenCalled();
		expect(truncated.events.filter((event) => event.type === "tool_start")).toHaveLength(1);
		expect(truncated.events.filter((event) => event.type === "tool_end")).toHaveLength(1);
		expect(truncated.observations.indexOf("outcome_commit")).toBeLessThan(
			truncated.observations.indexOf("tool_start"),
		);
		expect(truncated.observations.indexOf("tool_start")).toBeLessThan(truncated.observations.indexOf("tool_end"));
		expect(truncated.observations.indexOf("tool_end")).toBeLessThan(truncated.observations.indexOf("entry_added"));

		const missing = await createFixture({ calls: [{ name: "missing" }], tools: [] });
		const missingAfterTool = vi.fn(() => undefined);
		missing.hooks.on("after_tool", missingAfterTool);
		await driveTools(missing);
		const missingEntry = await missing.session.getEntry(missing.resultEntryIds[0]!, BACKGROUND_CONTEXT);
		expect(missingEntry?.type === "message" ? missingEntry.message : undefined).toMatchObject({
			role: "toolResult",
			isError: true,
			content: [{ type: "text", text: 'Tool "missing" is unavailable' }],
		});
		expect(
			missingEntry?.type === "message" && missingEntry.message.role === "toolResult"
				? Object.hasOwn(missingEntry.message, "details")
				: true,
		).toBe(false);
		expect(missingAfterTool).not.toHaveBeenCalled();
		expect(missing.events.filter((event) => event.type === "tool_start")).toHaveLength(1);
		const missingEnds = missing.events.filter((event) => event.type === "tool_end");
		expect(missingEnds).toHaveLength(1);
		expect(missing.events.find((event) => event.type === "tool_start")).toMatchObject({
			args: { value: "missing" },
		});
		expect(missingEnds[0]).toMatchObject({
			result: { content: [{ type: "text", text: 'Tool "missing" is unavailable' }], details: undefined },
			isError: true,
		});
	});

	it("awaits update delivery and checkpoint persistence before after_tool", async () => {
		const releaseUpdate = deferred<void>();
		const updateQueued = deferred<void>();
		let afterStarted = false;
		const fixture = await createFixture({
			calls: [{ name: "updating" }],
			tools: [
				tool("updating", async (_value, onUpdate) => {
					onUpdate?.(
						{ content: [{ type: "text", text: "partial" }], details: { progress: "partial" } },
						{ checkpoint: true },
					);
					return { content: [{ type: "text", text: "done" }], details: {} };
				}),
			],
			onEmit: async (events) => {
				if (events.some(({ type }) => type === "tool_update")) {
					updateQueued.resolve();
					await releaseUpdate.promise;
				}
			},
		});
		fixture.hooks.on("after_tool", async () => {
			afterStarted = true;
			expect(
				await fixture.session.getValue(
					storedValues.pendingToolOutput(fixture.operationId, fixture.resultEntryIds[0]!),
					BACKGROUND_CONTEXT,
				),
			).toBeDefined();
			return undefined;
		});

		const running = driveTools(fixture);
		await updateQueued.promise;
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(afterStarted).toBe(false);
		releaseUpdate.resolve();
		await running;
		expect(afterStarted).toBe(true);
	});

	it("does not stage a cancelled outcome before cancellation is durable", async () => {
		const execute = vi.fn(async () => ({ content: [], details: {} }));
		const fixture = await createFixture({
			calls: [{ name: "cancel-before-admission" }],
			tools: [tool("cancel-before-admission", execute)],
			mode: "sequential",
		});
		const cancellation = deferred<void>();
		fixture.drive.beginAbort(cancellation.promise);
		const running = driveTools(fixture);
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(currentCalls(fixture)[0]?.status).toBe("planned");
		expect(
			await fixture.session.getValue(storedValues.pendingEntry(fixture.resultEntryIds[0]!), BACKGROUND_CONTEXT),
		).toBeUndefined();
		await fixture.lane.command((state) => {
			const operation = state.operation;
			if (operation === null) throw new Error("missing operation");
			const nextRun: OperationState = {
				...operation.state,
				control: { status: "cancel_requested", requestedAt: 40 },
			};
			return {
				kind: "commit",
				writes: [storedValues.setValue(storedValues.operationState(fixture.operationId), nextRun)],
				next: { ...state, operation: { meta: operation.meta, state: nextRun } },
				materialize: () => undefined,
			};
		}, BACKGROUND_CONTEXT);
		cancellation.resolve();
		fixture.drive.signalAbort();
		await running;

		expect(execute).not.toHaveBeenCalled();
		expect(await fixture.session.getEntry(fixture.resultEntryIds[0]!, BACKGROUND_CONTEXT)).toBeDefined();
	});

	it("drains live updates before after_tool and stages a non-terminating result after cancellation", async () => {
		const updateDelivery = deferred<void>();
		const started = deferred<void>();
		let updateDelivered = false;
		const afterTool = vi.fn(() => {
			expect(updateDelivered).toBe(true);
			return undefined;
		});
		const executing = tool("slow", async (_value, onUpdate, _invocation, context) => {
			onUpdate?.({ content: [{ type: "text", text: "partial" }], details: { progress: "partial" } });
			started.resolve();
			await new Promise<void>((_resolve, reject) => {
				context.abortSignal?.addEventListener("abort", () => reject(new Error("cancelled effect")), { once: true });
			});
			return { content: [], details: {}, terminate: true };
		});
		const fixture = await createFixture({
			calls: [{ name: "slow" }],
			tools: [executing],
			mode: "sequential",
			onEmit: async (events) => {
				if (events.some(({ type }) => type === "tool_update")) {
					await updateDelivery.promise;
					updateDelivered = true;
				}
			},
		});
		fixture.hooks.on("after_tool", afterTool);
		const running = driveTools(fixture);
		await started.promise;
		const cancellation = deferred<void>();
		fixture.drive.beginAbort(cancellation.promise);
		await fixture.lane.command((state) => {
			const operation = state.operation;
			if (operation === null) throw new Error("missing operation");
			const nextRun: OperationState = {
				...operation.state,
				control: { status: "cancel_requested", requestedAt: 40 },
			};
			return {
				kind: "commit",
				writes: [storedValues.setValue(storedValues.operationState(fixture.operationId), nextRun)],
				next: { ...state, operation: { meta: operation.meta, state: nextRun } },
				materialize: () => undefined,
			};
		}, BACKGROUND_CONTEXT);
		cancellation.resolve();
		fixture.drive.signalAbort();
		updateDelivery.resolve();
		await running;
		expect(afterTool).not.toHaveBeenCalled();
		const entry = await fixture.session.getEntry(fixture.resultEntryIds[0]!, BACKGROUND_CONTEXT);
		expect(entry?.type === "message" ? entry.terminate : undefined).toBeUndefined();
		expect(entry?.type === "message" ? entry.message : undefined).toMatchObject({
			role: "toolResult",
			isError: true,
		});
	});
});

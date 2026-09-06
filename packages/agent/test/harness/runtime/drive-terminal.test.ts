import { afterEach, describe, expect, it, vi } from "vitest";
import { BACKGROUND_CONTEXT } from "../../../src/harness/context.ts";
import { operationCleanupWrites, operationResultRecord } from "../../../src/harness/runtime/drive/terminal.ts";
import { MemoryStorage } from "../../../src/harness/session/memory.ts";
import { StorageBackedSession } from "../../../src/harness/session/session.ts";
import type {
	AssistantEffectPendingOperation,
	LaneConfiguration,
	NavigationReadyToCommitOperation,
	OperationMeta,
	OperationScope,
	OperationState,
	Session,
	SummaryDecidingOperation,
	ToolsOperation,
	Write,
} from "../../../src/harness/session/types.ts";
import * as storedValues from "../../../src/harness/session/values.ts";

const sessions: Session[] = [];
const configuration: LaneConfiguration = {
	model: { provider: "test", modelId: "model" },
	thinkingLevel: "off",
	activeToolNames: [],
};

function runScope(): OperationScope {
	return {
		control: { status: "running" },
		settings: {
			compaction: { enabled: true, reserveTokens: 1_000, keepRecentTokens: 2_000 },
			steeringMode: "all",
			followUpMode: "all",
			toolExecution: "parallel",
		},
		latestAssistantEntryId: null,
	};
}

function meta(operationId: string, state: OperationState): OperationMeta {
	const intent: OperationMeta["intent"] =
		state.at === "summary.deciding"
			? { kind: "compaction" }
			: state.at === "navigation.ready_to_commit"
				? { kind: "navigation", targetId: state.targetId, summarize: false }
				: { kind: "run", promptEntryIds: [] };
	return { operationId, lane: "main", sourceTipId: null, startedAt: 1, intent };
}

async function createSession(): Promise<{ session: Session; storage: MemoryStorage }> {
	const storage = new MemoryStorage();
	const session = new StorageBackedSession(
		{ id: `terminal-${sessions.length}`, createdAt: 1, storageVersion: 1 },
		storage,
	);
	sessions.push(session);
	return { session, storage };
}

async function commit(session: Session, writes: Write[]): Promise<void> {
	await session.mutate(async (mutator) => {
		await mutator.commit(writes, BACKGROUND_CONTEXT);
	}, BACKGROUND_CONTEXT);
}

function address(write: Write): string {
	if (write.kind === "entry") return `entry:${write.entry.id}`;
	if (write.kind === "usage") return `usage:${write.row.id}`;
	return `${write.kind}:${write.op}:${write.namespace}:${write.key}`;
}

async function seedLeftovers(session: Session, operationId: string, state: OperationState): Promise<void> {
	await commit(session, [
		storedValues.setValue(storedValues.operationMeta(operationId), meta(operationId, state)),
		storedValues.setValue(storedValues.operationState(operationId), state),
		storedValues.setValue(storedValues.operationToolArgs(operationId, "step", 0), { value: true }),
		storedValues.setValue(storedValues.operationToolMemo(operationId, "invocation", "memo"), { value: true }),
		storedValues.setValue(storedValues.operationPreparation(operationId, "task"), {
			kind: "branch_summary",
			messages: [],
			fileOps: { read: [], written: [], edited: [] },
			totalTokens: 0,
		}),
		storedValues.setValue(storedValues.pendingToolOutput(operationId, "invocation"), {
			content: [{ type: "text", text: "partial" }],
			details: {},
		}),
	]);
}

afterEach(async () => {
	vi.restoreAllMocks();
	for (const session of sessions.splice(0)) await session.close(BACKGROUND_CONTEXT);
});

describe("runtime terminal cleanup mechanics", () => {
	it("deletes every operation-owned family and exact live frame list but preserves the lane inbox", async () => {
		const { session } = await createSession();
		const operationId = "run";
		const responseEntryId = "response";
		const state: AssistantEffectPendingOperation = {
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
			control: { status: "cancel_requested", requestedAt: 2 },
		};
		await seedLeftovers(session, operationId, state);
		await commit(session, [
			...["steer", "follow", "write", "next"].map((id) =>
				storedValues.setValue(storedValues.pendingEntry(id), {
					type: "custom",
					customType: "test",
					payload: { id },
				}),
			),
			storedValues.appendList(storedValues.pendingAssistantFrames(operationId, responseEntryId), {
				type: "text_delta",
				contentIndex: 0,
				delta: "partial",
			}),
			storedValues.setValue(storedValues.laneState("main"), {
				currentOperationId: operationId,
				lastOperationId: null,
				inbox: [
					{ entryId: "steer", kind: "steer" },
					{ entryId: "follow", kind: "followUp" },
					{ entryId: "write", kind: "write" },
					{ entryId: "next", kind: "nextRun" },
				],
			}),
		]);

		const writes = await operationCleanupWrites(session, operationId, state, BACKGROUND_CONTEXT);

		expect(writes.map(address)).toEqual([
			"value:delete:pi.op.meta:run",
			"value:delete:pi.op.state:run",
			"value:delete:pi.op.tool_args:run:step:0",
			"value:delete:pi.op.tool_memo:run:invocation:memo",
			"value:delete:pi.op.preparation:run:task",
			"value:delete:pi.pending.tool_output:run:invocation",
			"list:delete:pi.pending.assistant_frame:run:response",
		]);
		await commit(session, writes);
		for (const id of ["steer", "follow", "write", "next"]) {
			expect(await session.getValue(storedValues.pendingEntry(id), BACKGROUND_CONTEXT)).toBeDefined();
		}
		expect((await session.getValue(storedValues.laneState("main"), BACKGROUND_CONTEXT))?.value.inbox).toEqual([
			{ entryId: "steer", kind: "steer" },
			{ entryId: "follow", kind: "followUp" },
			{ entryId: "write", kind: "write" },
			{ entryId: "next", kind: "nextRun" },
		]);
		expect(
			await session.readList(
				storedValues.pendingAssistantFrames(operationId, responseEntryId),
				undefined,
				BACKGROUND_CONTEXT,
			),
		).toEqual([]);
	});

	it("deletes staged tool outcomes and leaves completed results alone", async () => {
		const { session } = await createSession();
		const operationId = "tools";
		const state: ToolsOperation = {
			...runScope(),
			at: "tools",
			batch: {
				assistantEntryId: "assistant",
				configuration,
				turnId: "step",
				calls: [
					{ status: "outcome_ready", sourceIndex: 0, resultEntryId: "staged", terminate: false },
					{ status: "completed", sourceIndex: 1, resultEntryId: "placed", terminate: false },
				],
			},
		};
		await seedLeftovers(session, operationId, state);
		await commit(session, [
			storedValues.setValue(storedValues.pendingEntry("staged"), {
				type: "message",
				payload: {
					role: "toolResult",
					toolCallId: "call",
					toolName: "tool",
					content: [],
					isError: false,
					timestamp: 1,
				},
			}),
		]);

		const writes = await operationCleanupWrites(session, operationId, state, BACKGROUND_CONTEXT);

		expect(writes.map(address)).toContain("value:delete:pi.pending.entry:staged");
		expect(writes.map(address)).not.toContain("value:delete:pi.pending.entry:placed");
	});

	it.each([
		[
			"compaction",
			{
				...runScope(),
				at: "summary.deciding",
				task: { taskId: "task", reason: "manual", boundary: { kind: "finish" } },
			} satisfies SummaryDecidingOperation,
		],
		[
			"navigation",
			{
				...runScope(),
				at: "navigation.ready_to_commit",
				targetId: null,
			} satisfies NavigationReadyToCommitOperation,
		],
	] as const)("defensively deletes leftover %s operation families", async (operationId, state) => {
		const { session } = await createSession();
		await seedLeftovers(session, operationId, state);

		const writes = await operationCleanupWrites(session, operationId, state, BACKGROUND_CONTEXT);

		expect(writes.map(address)).toEqual([
			`value:delete:pi.op.meta:${operationId}`,
			`value:delete:pi.op.state:${operationId}`,
			`value:delete:pi.op.tool_args:${operationId}:step:0`,
			`value:delete:pi.op.tool_memo:${operationId}:invocation:memo`,
			`value:delete:pi.op.preparation:${operationId}:task`,
			`value:delete:pi.pending.tool_output:${operationId}:invocation`,
		]);
	});
});

describe("runtime operation result records", () => {
	it("constructs one flat immutable observation from terminal metadata", () => {
		vi.spyOn(Date, "now").mockReturnValue(20);
		const record = operationResultRecord(
			{
				operationId: "run",
				lane: "main",
				sourceTipId: "source",
				startedAt: 10,
				intent: { kind: "run", promptEntryIds: ["prompt"] },
			},
			"failed",
			"tip",
			{ code: "provider", message: "failed" },
		);

		expect(record).toEqual({
			operationId: "run",
			kind: "run",
			status: "failed",
			error: { code: "provider", message: "failed" },
			fromTipId: "source",
			tipId: "tip",
			startedAt: 10,
			endedAt: 20,
		});
	});

	it("rejects errors on non-failed records and missing errors on failed records", () => {
		const metadata: OperationMeta = {
			operationId: "run",
			lane: "main",
			sourceTipId: null,
			startedAt: 1,
			intent: { kind: "run", promptEntryIds: [] },
		};
		expect(() => operationResultRecord(metadata, "completed", "tip", { code: "x", message: "x" })).toThrow(
			"Only a failed operation result may carry an error",
		);
		expect(() => operationResultRecord(metadata, "failed", "tip")).toThrow(
			"Only a failed operation result may carry an error",
		);
	});
});

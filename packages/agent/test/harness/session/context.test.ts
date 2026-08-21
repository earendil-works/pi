import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, ToolResultMessage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { buildSessionContext } from "../../../src/harness/session/context.ts";
import type { Entry } from "../../../src/harness/session/types.ts";

function userMessage(text: string): AgentMessage {
	return { role: "user", content: [{ type: "text", text }], timestamp: 1 };
}

function assistantMessage(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 1,
	};
}

function toolCallMessage(callIds: string[]): AssistantMessage {
	return {
		...assistantMessage("running tools"),
		content: [
			{ type: "text", text: "running tools" },
			...callIds.map((callId) => ({ type: "toolCall" as const, id: callId, name: "bash", arguments: {} })),
		],
		stopReason: "toolUse",
	};
}

function toolResultMessage(callId: string): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: callId,
		toolName: "bash",
		content: [{ type: "text", text: "done" }],
		isError: false,
		timestamp: 1,
	};
}

type EntryWithoutStorage<TEntry extends Entry = Entry> = TEntry extends Entry
	? Omit<TEntry, "seq" | "timestamp">
	: never;

function entry<TEntry extends Entry>(value: EntryWithoutStorage<TEntry>, seq: number): TEntry {
	return { ...value, seq, timestamp: seq } as unknown as TEntry;
}

describe("v4 session context", () => {
	it("starts at the latest compaction and materializes its retained tail", () => {
		const entries: Entry[] = [
			entry({ type: "message", id: "old", parentId: null, message: userMessage("old") }, 1),
			entry(
				{
					type: "compaction",
					id: "compact",
					parentId: "old",
					summary: "summary",
					retainedTail: [userMessage("retained"), assistantMessage("answer")],
					tokensBefore: 100,
				},
				2,
			),
			entry({ type: "model_change", id: "model", parentId: "compact", provider: "openai", modelId: "gpt-5" }, 3),
			entry({ type: "thinking_level_change", id: "thinking", parentId: "model", thinkingLevel: "high" }, 4),
			entry({ type: "message", id: "tail", parentId: "thinking", message: userMessage("tail") }, 5),
		];

		const context = buildSessionContext(entries);
		expect(context.messages.map((message) => message.role)).toEqual([
			"compactionSummary",
			"user",
			"assistant",
			"user",
		]);
		expect(context.model).toEqual({ provider: "openai", modelId: "gpt-5" });
		expect(context.thinkingLevel).toBe("high");
	});

	it("applies caller transforms after the compaction boundary", () => {
		const entries: Entry[] = [
			entry({ type: "message", id: "old", parentId: null, message: userMessage("old") }, 1),
			entry(
				{
					type: "compaction",
					id: "compact",
					parentId: "old",
					summary: "summary",
					retainedTail: [],
					tokensBefore: 100,
				},
				2,
			),
			entry(
				{
					type: "branch_summary",
					id: "branch",
					parentId: "compact",
					fromId: "abandoned",
					summary: "branch summary",
				},
				3,
			),
			entry({ type: "message", id: "tail", parentId: "branch", message: userMessage("tail") }, 4),
		];

		const context = buildSessionContext(entries, {
			entryTransforms: [(contextEntries) => contextEntries.filter((candidate) => candidate.type !== "compaction")],
		});
		expect(context.messages.map((message) => message.role)).toEqual(["branchSummary", "user"]);
	});

	it("projects custom entries and omits deferred assistant handles", () => {
		const deferred: AssistantMessage = {
			...assistantMessage(""),
			content: [],
			stopReason: "deferred",
			deferred: { provider: "openai", modelId: "gpt-5", api: "openai-responses", id: "response-1" },
		};
		const entries: Entry[] = [
			entry({ type: "message", id: "user", parentId: null, message: userMessage("hello") }, 1),
			entry({ type: "message", id: "deferred", parentId: "user", message: deferred }, 2),
			entry({ type: "custom", id: "custom", parentId: "deferred", customType: "note", data: "project me" }, 3),
		];

		const context = buildSessionContext(entries, {
			entryProjectors: {
				note: (custom) => [userMessage(`note: ${String(custom.data)}`)],
			},
		});
		expect(context.messages.map((message) => message.role)).toEqual(["user", "user"]);
		expect(context.messages[1]).toMatchObject({ content: [{ type: "text", text: "note: project me" }] });
	});

	it("hoists tool results past projected custom entries", () => {
		// Extensions can append custom entries between the assistant tool-call
		// message and its results; flattening must keep the result adjacent to
		// its tool_calls message or providers reject the sequence.
		const entries: Entry[] = [
			entry({ type: "message", id: "user", parentId: null, message: userMessage("go") }, 1),
			entry({ type: "message", id: "assistant", parentId: "user", message: toolCallMessage(["call_X"]) }, 2),
			entry({ type: "custom", id: "notice", parentId: "assistant", customType: "notice", data: "attention" }, 3),
			entry({ type: "message", id: "result", parentId: "notice", message: toolResultMessage("call_X") }, 4),
			entry({ type: "message", id: "next", parentId: "result", message: userMessage("next") }, 5),
		];

		const context = buildSessionContext(entries, {
			entryProjectors: {
				notice: (custom) => [userMessage(`notice: ${String(custom.data)}`)],
			},
		});
		expect(context.messages.map((message) => message.role)).toEqual([
			"user",
			"assistant",
			"toolResult",
			"user",
			"user",
		]);
		expect(context.messages[1]).toMatchObject({
			content: expect.arrayContaining([expect.objectContaining({ type: "toolCall", id: "call_X" })]),
		});
		expect(context.messages[2]).toMatchObject({ toolCallId: "call_X" });
		expect(context.messages[3]).toMatchObject({ content: [{ type: "text", text: "notice: attention" }] });
	});

	it("drops tool results whose tool call is missing from context", () => {
		const entries: Entry[] = [
			entry({ type: "message", id: "user", parentId: null, message: userMessage("go") }, 1),
			entry({ type: "message", id: "result", parentId: "user", message: toolResultMessage("call_GONE") }, 2),
			entry({ type: "message", id: "next", parentId: "result", message: userMessage("next") }, 3),
		];

		const context = buildSessionContext(entries);
		expect(context.messages.map((message) => message.role)).toEqual(["user", "user"]);
	});
});

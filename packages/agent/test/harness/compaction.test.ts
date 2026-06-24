import {
	type AssistantMessage,
	createModels,
	type FauxProviderHandle,
	fauxAssistantMessage,
	fauxProvider,
	type Message,
	type Model,
	type Usage,
} from "@earendil-works/pi-ai";
import { beforeEach, describe, expect, it } from "vitest";
import {
	type CompactionPreparation,
	calculateContextTokens,
	compact,
	DEFAULT_COMPACTION_SETTINGS,
	estimateContextTokens,
	estimateTokens,
	findCutPoint,
	findTurnStartIndex,
	generateSummary,
	getLastAssistantUsage,
	prepareCompaction,
	serializeConversation,
	shouldCompact,
} from "../../src/harness/compaction/compaction.ts";
import { buildSessionContext } from "../../src/harness/session/session.ts";
import type {
	BranchSummaryEntry,
	CompactionEntry,
	CompactionSettings,
	CustomMessageEntry,
	MessageEntry,
	ModelChangeEntry,
	SessionTreeEntry,
	ThinkingLevelChangeEntry,
} from "../../src/harness/types.ts";
import { getOrThrow } from "../../src/harness/types.ts";
import type { AgentMessage } from "../../src/types.ts";

let nextId = 0;
function createId(): string {
	return `entry-${nextId++}`;
}

function createMockUsage(input: number, output: number, cacheRead = 0, cacheWrite = 0): Usage {
	return {
		input,
		output,
		cacheRead,
		cacheWrite,
		totalTokens: input + output + cacheRead + cacheWrite,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function createUserMessage(text: string): AgentMessage {
	return {
		role: "user",
		content: [{ type: "text", text }],
		timestamp: Date.now(),
	};
}

function createAssistantMessage(text: string, usage = createMockUsage(100, 50)): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		usage,
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function createMessageEntry(message: AgentMessage, parentId: string | null = null): MessageEntry {
	return {
		type: "message",
		id: createId(),
		parentId,
		timestamp: new Date().toISOString(),
		message,
	};
}

function createCompactionEntry(
	summary: string,
	firstKeptEntryId: string,
	parentId: string | null = null,
): CompactionEntry {
	return {
		type: "compaction",
		id: createId(),
		parentId,
		timestamp: new Date().toISOString(),
		summary,
		firstKeptEntryId,
		tokensBefore: 1234,
	};
}

function createThinkingLevelEntry(level: string, parentId: string | null = null): ThinkingLevelChangeEntry {
	return {
		type: "thinking_level_change",
		id: createId(),
		parentId,
		timestamp: new Date().toISOString(),
		thinkingLevel: level,
	};
}

function createModelChangeEntry(provider: string, modelId: string, parentId: string | null = null): ModelChangeEntry {
	return {
		type: "model_change",
		id: createId(),
		parentId,
		timestamp: new Date().toISOString(),
		provider,
		modelId,
	};
}

/** Shared collection; each faux provider gets a unique id so coexisting fakes route correctly. */
const models = createModels();
let fauxCount = 0;

function createFauxModel(reasoning: boolean, maxTokens = 8192): { faux: FauxProviderHandle; model: Model<string> } {
	const faux = fauxProvider({
		provider: `faux-${++fauxCount}`,
		models: [
			{
				id: reasoning ? "reasoning-model" : "non-reasoning-model",
				reasoning,
				contextWindow: 200000,
				maxTokens,
			},
		],
	});
	models.setProvider(faux.provider);
	return { faux, model: faux.getModel() };
}

describe("harness compaction", () => {
	beforeEach(() => {
		nextId = 0;
	});

	it("calculates total context tokens from usage", () => {
		expect(calculateContextTokens(createMockUsage(1000, 500, 200, 100))).toBe(1800);
		expect(calculateContextTokens(createMockUsage(0, 0, 0, 0))).toBe(0);
	});

	it("checks compaction threshold", () => {
		const settings: CompactionSettings = {
			enabled: true,
			reserveTokens: 10000,
			keepRecentTokens: 20000,
		};
		expect(shouldCompact(95000, 100000, settings)).toBe(true);
		expect(shouldCompact(89000, 100000, settings)).toBe(false);
		expect(shouldCompact(95000, 100000, { ...settings, enabled: false })).toBe(false);
	});

	it("finds a cut point based on token differences", () => {
		const entries: SessionTreeEntry[] = [];
		let parentId: string | null = null;
		for (let i = 0; i < 10; i++) {
			const user = createMessageEntry(createUserMessage(`User ${i}`), parentId);
			entries.push(user);
			const assistant = createMessageEntry(
				createAssistantMessage(`Assistant ${i}`, createMockUsage(0, 100, (i + 1) * 1000, 0)),
				user.id,
			);
			entries.push(assistant);
			parentId = assistant.id;
		}

		const result = findCutPoint(entries, 0, entries.length, 2500);
		expect(entries[result.firstKeptEntryIndex]?.type).toBe("message");
	});

	it("covers cut-point and turn-start edge cases", () => {
		const thinking = createThinkingLevelEntry("high");
		const modelChange = createModelChangeEntry("openai", "gpt-4", thinking.id);
		expect(findCutPoint([thinking, modelChange], 0, 2, 1)).toEqual({
			firstKeptEntryIndex: 0,
			turnStartIndex: -1,
			isSplitTurn: false,
		});

		const branchSummary: BranchSummaryEntry = {
			type: "branch_summary",
			id: createId(),
			parentId: modelChange.id,
			timestamp: new Date().toISOString(),
			fromId: "branch",
			summary: "branch summary",
		};
		const customMessage: CustomMessageEntry = {
			type: "custom_message",
			id: createId(),
			parentId: branchSummary.id,
			timestamp: new Date().toISOString(),
			customType: "note",
			content: "custom content",
			display: true,
		};
		expect(findTurnStartIndex([thinking, branchSummary], 1, 0)).toBe(1);
		expect(findTurnStartIndex([thinking, customMessage], 1, 0)).toBe(1);
		expect(findTurnStartIndex([thinking, modelChange], 1, 0)).toBe(-1);

		const result = findCutPoint([thinking, branchSummary, customMessage], 0, 3, 1);
		expect(result.firstKeptEntryIndex).toBe(0);

		const toolResult = createMessageEntry({
			role: "toolResult",
			toolCallId: "call-1",
			toolName: "read",
			content: [{ type: "text", text: "tool output" }],
			isError: false,
			timestamp: Date.now(),
		});
		expect(findCutPoint([toolResult], 0, 1, 1)).toEqual({
			firstKeptEntryIndex: 0,
			turnStartIndex: -1,
			isSplitTurn: false,
		});

		const user = createMessageEntry(createUserMessage("user"));
		const compaction = createCompactionEntry("summary", user.id, user.id);
		const assistant = createMessageEntry(createAssistantMessage("assistant"), compaction.id);
		expect(findCutPoint([user, compaction, assistant], 0, 3, 1).firstKeptEntryIndex).toBe(2);
	});

	it("estimates tokens and context usage across supported message roles", () => {
		const usage = createMockUsage(10, 5, 3, 2);
		const assistant = createAssistantMessage("assistant", usage);
		const assistantWithThinkingAndTool: AssistantMessage = {
			...assistant,
			content: [
				{ type: "thinking", thinking: "thinking" },
				{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "file.ts" } },
			],
		};
		const customString: AgentMessage = {
			role: "custom",
			customType: "note",
			content: "custom text",
			display: true,
			timestamp: Date.now(),
		};
		const toolResultWithImage: AgentMessage = {
			role: "toolResult",
			toolCallId: "call-1",
			toolName: "read",
			content: [
				{ type: "text", text: "tool text" },
				{ type: "image", mimeType: "image/png", data: "abc" },
			],
			isError: false,
			timestamp: Date.now(),
		};
		const bashExecution: AgentMessage = {
			role: "bashExecution",
			command: "npm run check",
			output: "ok",
			exitCode: 0,
			cancelled: false,
			truncated: false,
			timestamp: Date.now(),
		};
		const branchSummaryMessage: AgentMessage = {
			role: "branchSummary",
			summary: "branch",
			fromId: "x",
			timestamp: Date.now(),
		};
		const compactionSummaryMessage: AgentMessage = {
			role: "compactionSummary",
			summary: "compact",
			tokensBefore: 123,
			timestamp: Date.now(),
		};

		expect(estimateTokens({ role: "user", content: "plain user", timestamp: Date.now() })).toBeGreaterThan(0);
		expect(estimateTokens(assistantWithThinkingAndTool)).toBeGreaterThan(0);
		expect(estimateTokens(customString)).toBeGreaterThan(0);
		expect(estimateTokens(toolResultWithImage)).toBeGreaterThan(1000);
		expect(estimateTokens(bashExecution)).toBeGreaterThan(0);
		expect(estimateTokens(branchSummaryMessage)).toBeGreaterThan(0);
		expect(estimateTokens(compactionSummaryMessage)).toBeGreaterThan(0);
		expect(estimateTokens({ role: "unknown", timestamp: Date.now() } as unknown as AgentMessage)).toBe(0);
		expect(
			getLastAssistantUsage([createMessageEntry(createUserMessage("user")), createMessageEntry(assistant)]),
		).toBe(usage);
		expect(
			getLastAssistantUsage([
				createMessageEntry({ ...assistant, stopReason: "aborted" }),
				createMessageEntry({ ...assistant, stopReason: "error" }),
			]),
		).toBeUndefined();
		expect(
			getLastAssistantUsage([
				createMessageEntry(createUserMessage("user")),
				createMessageEntry(assistant),
				createMessageEntry(createAssistantMessage("partial", createMockUsage(0, 0))),
			]),
		).toBe(usage);
		expect(estimateContextTokens([createUserMessage("no usage")]).lastUsageIndex).toBeNull();
		expect(estimateContextTokens([assistant, createUserMessage("tail")])).toMatchObject({
			usageTokens: 20,
			lastUsageIndex: 0,
		});
		const estimate = estimateContextTokens([
			createUserMessage("Hello"),
			assistant,
			createUserMessage("continue"),
			createAssistantMessage("Partial thinking", createMockUsage(0, 0)),
		]);
		expect(estimate.usageTokens).toBe(20);
		expect(estimate.lastUsageIndex).toBe(1);
		expect(estimate.trailingTokens).toBeGreaterThan(0);
		expect(estimate.tokens).toBe(20 + estimate.trailingTokens);
	});

	it("builds session context with a compaction entry", () => {
		const u1 = createMessageEntry(createUserMessage("1"));
		const a1 = createMessageEntry(createAssistantMessage("a"), u1.id);
		const u2 = createMessageEntry(createUserMessage("2"), a1.id);
		const a2 = createMessageEntry(createAssistantMessage("b"), u2.id);
		const compaction = createCompactionEntry("Summary of 1,a,2,b", u2.id, a2.id);
		const u3 = createMessageEntry(createUserMessage("3"), compaction.id);
		const a3 = createMessageEntry(createAssistantMessage("c"), u3.id);
		const loaded = buildSessionContext([u1, a1, u2, a2, compaction, u3, a3]);
		expect(loaded.messages).toHaveLength(5);
		expect(loaded.messages[0]?.role).toBe("compactionSummary");
	});

	it("tracks model and thinking level changes in built context", () => {
		const user = createMessageEntry(createUserMessage("1"));
		const modelChange = createModelChangeEntry("openai", "gpt-4", user.id);
		const assistant = createMessageEntry(createAssistantMessage("a"), modelChange.id);
		const thinkingChange = createThinkingLevelEntry("high", assistant.id);
		const loaded = buildSessionContext([user, modelChange, assistant, thinkingChange]);
		expect(loaded.model).toEqual({ provider: "anthropic", modelId: "claude-sonnet-4-5" });
		expect(loaded.thinkingLevel).toBe("high");
	});

	it("prepares compaction using the latest compaction summary as previousSummary", () => {
		const u1 = createMessageEntry(createUserMessage("user msg 1"));
		const a1 = createMessageEntry(createAssistantMessage("assistant msg 1"), u1.id);
		const u2 = createMessageEntry(createUserMessage("user msg 2"), a1.id);
		const a2 = createMessageEntry(createAssistantMessage("assistant msg 2", createMockUsage(5000, 1000)), u2.id);
		const compaction1 = createCompactionEntry("First summary", u2.id, a2.id);
		const u3 = createMessageEntry(createUserMessage("user msg 3"), compaction1.id);
		const a3 = createMessageEntry(createAssistantMessage("assistant msg 3", createMockUsage(8000, 2000)), u3.id);
		const pathEntries = [u1, a1, u2, a2, compaction1, u3, a3];
		const preparation = getOrThrow(prepareCompaction(pathEntries, DEFAULT_COMPACTION_SETTINGS));
		expect(preparation).toBeDefined();
		expect(preparation?.previousSummary).toBe("First summary");
		expect(preparation?.firstKeptEntryId).toBeTruthy();
		expect(preparation?.tokensBefore).toBe(estimateContextTokens(buildSessionContext(pathEntries).messages).tokens);
	});

	it("prepares split-turn compaction with prior file-operation details", () => {
		const u1 = createMessageEntry(createUserMessage("user msg 1"));
		const assistantMessage: AssistantMessage = {
			...createAssistantMessage("assistant msg 1"),
			content: [{ type: "toolCall", id: "tool-1", name: "write", arguments: { path: "written.ts" } }],
		};
		const a1 = createMessageEntry(assistantMessage, u1.id);
		const compaction1: CompactionEntry = {
			...createCompactionEntry("First summary", u1.id, a1.id),
			details: { readFiles: ["old-read.ts"], modifiedFiles: ["old-edit.ts"] },
		};
		const u2 = createMessageEntry(createUserMessage("large turn"), compaction1.id);
		const a2 = createMessageEntry(createAssistantMessage("large assistant message"), u2.id);
		const preparation = getOrThrow(
			prepareCompaction([u1, a1, compaction1, u2, a2], {
				enabled: true,
				reserveTokens: 100,
				keepRecentTokens: 1,
			}),
		);

		expect(preparation).toMatchObject({ previousSummary: "First summary", isSplitTurn: true });
		expect(preparation?.turnPrefixMessages.map((message) => message.role)).toEqual(["user"]);
		expect([...preparation!.fileOps.read]).toContain("old-read.ts");
		expect([...preparation!.fileOps.edited]).toContain("old-edit.ts");
		expect([...preparation!.fileOps.written]).toContain("written.ts");
	});

	it("prepares custom and branch summary entries for summarization", () => {
		const branchSummary: BranchSummaryEntry = {
			type: "branch_summary",
			id: createId(),
			parentId: null,
			timestamp: new Date().toISOString(),
			fromId: "branch",
			summary: "branch summary",
		};
		const customMessage: CustomMessageEntry = {
			type: "custom_message",
			id: createId(),
			parentId: branchSummary.id,
			timestamp: new Date().toISOString(),
			customType: "note",
			content: "custom content",
			display: true,
		};
		const user = createMessageEntry(createUserMessage("keep"), customMessage.id);
		const assistant = createMessageEntry(createAssistantMessage("assistant"), user.id);
		const preparation = getOrThrow(
			prepareCompaction([branchSummary, customMessage, user, assistant], {
				enabled: true,
				reserveTokens: 100,
				keepRecentTokens: 1,
			}),
		);

		expect(preparation?.messagesToSummarize.map((message) => message.role)).toEqual(["branchSummary", "custom"]);
	});

	it("does not prepare compaction when there is nothing valid to compact", () => {
		const compaction = createCompactionEntry("already compacted", "entry-keep");
		expect(getOrThrow(prepareCompaction([compaction], DEFAULT_COMPACTION_SETTINGS))).toBeUndefined();
		expect(getOrThrow(prepareCompaction([], DEFAULT_COMPACTION_SETTINGS))).toBeUndefined();
	});

	it("serializes conversation with truncated tool results", () => {
		const longContent = "x".repeat(5000);
		const messages = convertMessages([
			{
				role: "toolResult",
				toolCallId: "tc1",
				toolName: "read",
				content: [{ type: "text", text: longContent }],
				isError: false,
				timestamp: Date.now(),
			},
		]);
		const result = serializeConversation(messages);
		expect(result).toContain("[Tool result]:");
		expect(result).toContain("[... 3000 more characters truncated]");
	});

	it("passes reasoning through generateSummary only for reasoning models with thinking enabled", async () => {
		const messages: AgentMessage[] = [createUserMessage("Summarize this.")];
		const seenOptions: Array<Record<string, unknown> | undefined> = [];
		const { faux: fauxReasoning, model: reasoningModel } = createFauxModel(true);
		fauxReasoning.setResponses([
			(_context, options) => {
				seenOptions.push(options as Record<string, unknown> | undefined);
				return fauxAssistantMessage("## Goal\nTest summary");
			},
		]);
		getOrThrow(
			await generateSummary(messages, models, reasoningModel, 2000, undefined, undefined, undefined, "medium"),
		);
		expect(seenOptions[0]).toMatchObject({ reasoning: "medium" });

		const { faux: fauxOff, model: offModel } = createFauxModel(true);
		fauxOff.setResponses([
			(_context, options) => {
				seenOptions.push(options as Record<string, unknown> | undefined);
				return fauxAssistantMessage("## Goal\nTest summary");
			},
		]);
		getOrThrow(await generateSummary(messages, models, offModel, 2000, undefined, undefined, undefined, "off"));
		expect(seenOptions[1]).not.toHaveProperty("reasoning");

		const { faux: fauxNonReasoning, model: nonReasoningModel } = createFauxModel(false);
		fauxNonReasoning.setResponses([
			(_context, options) => {
				seenOptions.push(options as Record<string, unknown> | undefined);
				return fauxAssistantMessage("## Goal\nTest summary");
			},
		]);
		getOrThrow(
			await generateSummary(messages, models, nonReasoningModel, 2000, undefined, undefined, undefined, "medium"),
		);
		expect(seenOptions[2]).not.toHaveProperty("reasoning");
	});

	it("includes previous summaries and custom instructions in generateSummary prompts", async () => {
		const messages: AgentMessage[] = [createUserMessage("Summarize this.")];
		let promptText = "";
		const { faux, model } = createFauxModel(false);
		faux.setResponses([
			(context) => {
				const message = context.messages[0];
				const content = message?.role === "user" ? message.content : [];
				promptText = Array.isArray(content) && content[0]?.type === "text" ? content[0].text : "";
				return fauxAssistantMessage("## Goal\nTest summary");
			},
		]);

		const summary = getOrThrow(
			await generateSummary(messages, models, model, 2000, undefined, "focus", "old summary"),
		);

		expect(summary).toContain("Test summary");
		expect(promptText).toContain("<previous-summary>\nold summary\n</previous-summary>");
		expect(promptText).toContain("Additional focus: focus");
	});

	it("returns error results for failed or aborted summary generations", async () => {
		const messages: AgentMessage[] = [createUserMessage("Summarize this.")];
		const { faux: errorFaux, model: errorModel } = createFauxModel(false);
		errorFaux.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: "boom" })]);
		const errorResult = await generateSummary(messages, models, errorModel, 2000);
		expect(errorResult).toMatchObject({
			ok: false,
			error: { code: "summarization_failed", message: "Summarization failed: boom" },
		});

		const { faux: abortedFaux, model: abortedModel } = createFauxModel(false);
		abortedFaux.setResponses([fauxAssistantMessage("", { stopReason: "aborted", errorMessage: "stopped" })]);
		const abortedResult = await generateSummary(messages, models, abortedModel, 2000);
		expect(abortedResult).toMatchObject({ ok: false, error: { code: "aborted", message: "stopped" } });
	});

	it("clamps compaction summary maxTokens to the model output cap", async () => {
		const messages: AgentMessage[] = [createUserMessage("Summarize this.")];
		const seenOptions: Array<Record<string, unknown> | undefined> = [];
		const { faux, model } = createFauxModel(false, 128000);
		faux.setResponses([
			(_context, options) => {
				seenOptions.push(options as Record<string, unknown> | undefined);
				return fauxAssistantMessage("## Goal\nTest summary");
			},
			(_context, options) => {
				seenOptions.push(options as Record<string, unknown> | undefined);
				return fauxAssistantMessage("## Goal\nTest summary");
			},
		]);
		const preparation: CompactionPreparation = {
			firstKeptEntryId: "entry-keep",
			messagesToSummarize: messages,
			turnPrefixMessages: messages,
			isSplitTurn: true,
			tokensBefore: 600000,
			fileOps: { read: new Set(), written: new Set(), edited: new Set() },
			settings: { enabled: true, reserveTokens: 500000, keepRecentTokens: 20000 },
		};

		getOrThrow(await compact(preparation, models, model));

		expect(seenOptions.map((options) => options?.maxTokens)).toEqual([128000, 128000]);
	});

	it("returns compaction error results without throwing", async () => {
		const messages: AgentMessage[] = [createUserMessage("Summarize this.")];
		const preparation: CompactionPreparation = {
			firstKeptEntryId: "entry-keep",
			messagesToSummarize: messages,
			turnPrefixMessages: [],
			isSplitTurn: false,
			tokensBefore: 100,
			fileOps: { read: new Set(), written: new Set(), edited: new Set() },
			settings: { enabled: true, reserveTokens: 2000, keepRecentTokens: 20 },
		};
		const { faux: historyFaux, model: historyModel } = createFauxModel(false);
		historyFaux.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: "history failed" })]);
		expect(await compact(preparation, models, historyModel)).toMatchObject({
			ok: false,
			error: { code: "summarization_failed", message: "Summarization failed: history failed" },
		});

		const { model: invalidModel } = createFauxModel(false);
		const invalidResult = await compact(
			{ ...preparation, messagesToSummarize: [], firstKeptEntryId: "" },
			models,
			invalidModel,
		);
		expect(invalidResult).toMatchObject({ ok: false, error: { code: "invalid_session" } });
	});

	it("passes reasoning through turn-prefix summaries when enabled", async () => {
		const messages: AgentMessage[] = [createUserMessage("Summarize this.")];
		const seenOptions: Array<Record<string, unknown> | undefined> = [];
		const { faux, model } = createFauxModel(true);
		faux.setResponses([
			(_context, options) => {
				seenOptions.push(options as Record<string, unknown> | undefined);
				return fauxAssistantMessage("## Original Request\nTest summary");
			},
		]);
		const preparation: CompactionPreparation = {
			firstKeptEntryId: "entry-keep",
			messagesToSummarize: [],
			turnPrefixMessages: messages,
			isSplitTurn: true,
			tokensBefore: 100,
			fileOps: { read: new Set(), written: new Set(), edited: new Set() },
			settings: { enabled: true, reserveTokens: 2000, keepRecentTokens: 20 },
		};

		getOrThrow(await compact(preparation, models, model, undefined, undefined, "high"));

		expect(seenOptions[0]).toMatchObject({ reasoning: "high" });
	});

	it("returns turn-prefix compaction errors without throwing", async () => {
		const messages: AgentMessage[] = [createUserMessage("Summarize this.")];
		const preparation: CompactionPreparation = {
			firstKeptEntryId: "entry-keep",
			messagesToSummarize: [],
			turnPrefixMessages: messages,
			isSplitTurn: true,
			tokensBefore: 100,
			fileOps: { read: new Set(), written: new Set(), edited: new Set() },
			settings: { enabled: true, reserveTokens: 2000, keepRecentTokens: 20 },
		};
		const { faux, model } = createFauxModel(false);
		faux.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: "prefix failed" })]);

		expect(await compact(preparation, models, model)).toMatchObject({
			ok: false,
			error: { code: "summarization_failed", message: "Turn prefix summarization failed: prefix failed" },
		});

		const { faux: abortedFaux, model: abortedModel } = createFauxModel(false);
		abortedFaux.setResponses([fauxAssistantMessage("", { stopReason: "aborted", errorMessage: "prefix stopped" })]);
		expect(await compact(preparation, models, abortedModel)).toMatchObject({
			ok: false,
			error: { code: "aborted", message: "prefix stopped" },
		});
	});

	it("returns a compaction result with file details", async () => {
		const u1 = createMessageEntry(createUserMessage("read a file"));
		const assistantMessage: AssistantMessage = {
			...createAssistantMessage("calling tool", createMockUsage(1000, 200)),
			content: [{ type: "toolCall", id: "tool-1", name: "read", arguments: { path: "src/index.ts" } }],
		};
		const a1 = createMessageEntry(assistantMessage, u1.id);
		const u2 = createMessageEntry(createUserMessage("continue"), a1.id);
		const a2 = createMessageEntry(createAssistantMessage("done", createMockUsage(4000, 500)), u2.id);
		const preparation = getOrThrow(prepareCompaction([u1, a1, u2, a2], DEFAULT_COMPACTION_SETTINGS));
		expect(preparation).toBeDefined();
		const { faux, model } = createFauxModel(false);
		faux.setResponses([fauxAssistantMessage("## Goal\nTest summary")]);
		const result = getOrThrow(await compact(preparation!, models, model));
		expect(result.summary.length).toBeGreaterThan(0);
		expect(result.firstKeptEntryId).toBeTruthy();
		expect(result.details).toBeDefined();
	});
});

function convertMessages(messages: Message[]): Message[] {
	return messages;
}

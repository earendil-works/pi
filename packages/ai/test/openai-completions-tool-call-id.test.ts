import { describe, expect, it } from "vitest";
import { convertMessages } from "../src/api/openai-completions.ts";
import { getModel, normalizeContext } from "../src/compat.ts";
import type {
	AssistantMessage,
	Message,
	Model,
	OpenAICompletionsCompat,
	ToolResultMessage,
	Usage,
} from "../src/types.ts";

// OpenAI rejects long tool call IDs. Through OpenRouter, a replayed ID of 83 characters reached
// OpenAI's Responses API and failed every request with "Invalid 'input[2].call_id': string too long.
// Expected a string with maximum length 64". Calling OpenAI directly worked, because only the
// `openai` provider shortened IDs.

const emptyUsage: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const compat: Omit<
	Required<OpenAICompletionsCompat>,
	"promptCacheKeyMode" | "thinkingTokenBudgetField" | "vllmPriority"
> & {
	thinkingTokenBudgetField?: OpenAICompletionsCompat["thinkingTokenBudgetField"];
} = {
	supportsStore: true,
	supportsDeveloperRole: true,
	supportsReasoningEffort: true,
	supportsUsageInStreaming: true,
	supportsFinishReason: true,
	maxTokensField: "max_completion_tokens",
	requiresToolResultName: false,
	requiresAssistantAfterToolResult: false,
	requiresNonNullAssistantContent: false,
	requiresThinkingAsText: false,
	requiresReasoningContentOnAssistantMessages: false,
	thinkingFormat: "openai",
	openRouterRouting: {},
	vercelGatewayRouting: {},
	chatTemplateKwargs: {},
	chatTemplateArgs: {},
	zaiToolStream: false,
	supportsThinkingTokenBudget: false,
	thinkingTokenBudgetField: undefined,
	supportsStrictMode: true,
	supportsOpenAIGrammarTools: false,
	supportsMidConvoSystemMessages: false,
	supportsMidConvoToolAdditions: false,
	cacheControlFormat: "anthropic",
	sendSessionAffinityHeaders: false,
	sessionAffinityFormat: "openai",
	supportsLongCacheRetention: true,
};

const LONG_ID = `toolu_${"a".repeat(77)}`;
const OTHER_LONG_ID = `toolu_${"a".repeat(76)}b`;

/** A turn from another model that called a tool, and the tool's result. */
function foreignToolTurn(ids: readonly string[]): Message[] {
	const now = Date.now();
	const assistant: AssistantMessage = {
		role: "assistant",
		content: ids.map((id) => ({ type: "toolCall", id, name: "bash", arguments: { command: "ls" } })),
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-5",
		usage: emptyUsage,
		stopReason: "toolUse",
		timestamp: now,
	};
	const results: ToolResultMessage[] = ids.map((id) => ({
		role: "toolResult",
		toolCallId: id,
		toolName: "bash",
		content: [{ type: "text", text: "ok" }],
		isError: false,
		timestamp: now,
	}));
	return [{ role: "user", content: "List files", timestamp: now }, assistant, ...results];
}

function sentIds(model: Model<"openai-completions">, ids: readonly string[]) {
	const params = convertMessages(model, normalizeContext({ messages: foreignToolTurn(ids) }), compat);
	const calls = params.flatMap((param) =>
		param.role === "assistant" ? (param.tool_calls ?? []).map((call) => call.id) : [],
	);
	const results = params.flatMap((param) => (param.role === "tool" ? [param.tool_call_id] : []));
	return { calls, results };
}

describe("openai-completions tool call IDs", () => {
	const openRouter = getModel("openrouter", "openai/gpt-5.5") as Model<"openai-completions">;

	it("shortens long IDs replayed to OpenRouter, keeping calls and results paired", () => {
		const { calls, results } = sentIds(openRouter, [LONG_ID]);

		expect(calls).toHaveLength(1);
		expect(calls[0]!.length).toBeLessThanOrEqual(40);
		expect(calls[0]!.startsWith("toolu_")).toBe(true);
		expect(results).toEqual(calls);
	});

	it("keeps IDs that share a long prefix distinct", () => {
		const { calls, results } = sentIds(openRouter, [LONG_ID, OTHER_LONG_ID]);

		expect(new Set(calls).size).toBe(2);
		expect(results).toEqual(calls);
	});

	it("leaves short IDs unchanged", () => {
		expect(sentIds(openRouter, ["call_abc123"]).calls).toEqual(["call_abc123"]);
	});

	it("shortens long IDs replayed to OpenAI the same way", () => {
		const openAI = getModel("openai", "gpt-4o-mini") as unknown as Model<"openai-completions">;
		const { calls, results } = sentIds({ ...openAI, api: "openai-completions" }, [LONG_ID, OTHER_LONG_ID]);

		expect(calls.every((id) => id.length <= 40)).toBe(true);
		expect(new Set(calls).size).toBe(2);
		expect(results).toEqual(calls);
	});
});

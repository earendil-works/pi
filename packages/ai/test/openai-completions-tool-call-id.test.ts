import { describe, expect, it } from "vitest";
import { convertMessages } from "../src/api/openai-completions.ts";
import type {
	AssistantMessage,
	Context,
	Model,
	OpenAICompletionsCompat,
	ToolResultMessage,
	Usage,
} from "../src/types.ts";

const usage: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const compat = {
	supportsStore: false,
	supportsDeveloperRole: true,
	supportsReasoningEffort: true,
	supportsUsageInStreaming: true,
	supportsFinishReason: true,
	maxTokensField: "max_completion_tokens",
	requiresToolResultName: false,
	requiresAssistantAfterToolResult: false,
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
	cacheControlFormat: undefined,
	sendSessionAffinityHeaders: false,
	sessionAffinityFormat: "openai",
	supportsLongCacheRetention: true,
} satisfies Omit<
	Required<OpenAICompletionsCompat>,
	"cacheControlFormat" | "deferredToolsMode" | "thinkingTokenBudgetField"
> & {
	cacheControlFormat?: OpenAICompletionsCompat["cacheControlFormat"];
	deferredToolsMode?: OpenAICompletionsCompat["deferredToolsMode"];
	thinkingTokenBudgetField?: OpenAICompletionsCompat["thinkingTokenBudgetField"];
};

const targetModel: Model<"openai-completions"> = {
	id: "gpt-proxy-model",
	name: "GPT Proxy Model",
	api: "openai-completions",
	provider: "custom-gateway",
	baseUrl: "https://gateway.example/v1",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128_000,
	maxTokens: 4096,
	compat,
};

function buildContext(toolCallIds: string[]): Context {
	const assistant: AssistantMessage = {
		role: "assistant",
		content: toolCallIds.map((id, index) => ({
			type: "toolCall",
			id,
			name: "read",
			arguments: { path: `file-${index}.txt` },
		})),
		api: "cursor-sdk",
		provider: "cursor",
		model: "composer",
		usage,
		stopReason: "toolUse",
		timestamp: 2,
	};
	const results: ToolResultMessage[] = toolCallIds.map((toolCallId, index) => ({
		role: "toolResult",
		toolCallId,
		toolName: "read",
		content: [{ type: "text", text: `result-${index}` }],
		isError: false,
		timestamp: 3 + index,
	}));
	return {
		messages: [{ role: "user", content: "Read the files", timestamp: 1 }, assistant, ...results],
	};
}

function getSerializedIds(context: Context): { calls: string[]; results: string[] } {
	const messages = convertMessages(targetModel, context, compat);
	const assistant = messages.find((message) => message.role === "assistant");
	if (!assistant || assistant.role !== "assistant") throw new Error("Expected assistant message");
	return {
		calls: assistant.tool_calls?.map((call) => call.id) ?? [],
		results: messages.filter((message) => message.role === "tool").map((message) => message.tool_call_id),
	};
}

describe("OpenAI-compatible Chat Completions tool call ID normalization", () => {
	it("bounds foreign IDs for custom gateways and preserves result pairing", () => {
		const ids = [
			"cursor-pi-bridge-run-c2417032-9686-40f2-bd3c-a763fbaa7693-tool-10",
			`call_246256__thought__${"A+/=".repeat(1_300)}`,
		];

		const serialized = getSerializedIds(buildContext(ids));

		expect(serialized.calls).toEqual(serialized.results);
		expect(serialized.calls).toHaveLength(ids.length);
		for (const id of serialized.calls) {
			expect(id.length).toBeLessThanOrEqual(40);
			expect(id).toMatch(/^[A-Za-z0-9_-]+$/);
		}
	});

	it("keeps distinct long IDs unique instead of truncating them to the same prefix", () => {
		const prefix = "cursor-pi-bridge-run-c2417032-9686-40f2-bd3c-a763fbaa7693-tool-";
		const serialized = getSerializedIds(buildContext([`${prefix}10`, `${prefix}11`]));

		expect(new Set(serialized.calls).size).toBe(2);
		expect(serialized.calls).toEqual(serialized.results);
	});

	it("preserves short provider-native IDs verbatim", () => {
		const serialized = getSerializedIds(buildContext(["call.native:1"]));

		expect(serialized.calls).toEqual(["call.native:1"]);
		expect(serialized.results).toEqual(serialized.calls);
	});
});

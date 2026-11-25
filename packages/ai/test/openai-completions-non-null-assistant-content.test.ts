import { describe, expect, it } from "vitest";
import { convertMessages } from "../src/api/openai-completions.ts";
import { getModel, normalizeContext, stream } from "../src/compat.ts";
import type { AssistantMessage, Model, OpenAICompletionsCompat, Usage } from "../src/types.ts";

const emptyUsage: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const baseCompat: Omit<
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
	requiresToolsWithToolHistory: false,
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

function buildModel(): Model<"openai-completions"> {
	const { compat: _compat, ...baseModel } = getModel("openai", "gpt-4o-mini");
	return { ...baseModel, api: "openai-completions", input: ["text", "image"] };
}

function buildContext(model: Model<"openai-completions">) {
	const now = Date.now();
	const assistantMessage: AssistantMessage = {
		role: "assistant",
		content: [{ type: "toolCall", id: "tool-1", name: "bash", arguments: { command: "true" } }],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: emptyUsage,
		stopReason: "toolUse",
		timestamp: now,
	};
	return normalizeContext({
		messages: [
			{ role: "user", content: "Run the command", timestamp: now - 1 },
			assistantMessage,
			{
				role: "toolResult",
				toolCallId: "tool-1",
				toolName: "bash",
				content: [{ type: "text", text: "ok" }],
				isError: false,
				timestamp: now + 1,
			},
			{ role: "user", content: "Thanks", timestamp: now + 2 },
		],
	});
}

describe("requiresNonNullAssistantContent", () => {
	// Regression for #12194: these Workers AI models reject null when replaying a tool call.
	it.each([
		["@cf/ibm-granite/granite-4.0-h-micro", ""],
		["@cf/meta/llama-3.3-70b-instruct-fp8-fast", ""],
		["@cf/openai/gpt-oss-120b", ""],
		["@cf/openai/gpt-oss-20b", ""],
		["@cf/zai-org/glm-5.3", null],
	] as const)("sends %s tool-call-only assistant content as %j", async (id, content) => {
		const model = getModel("cloudflare-workers-ai", id);
		let payload: unknown;
		await stream(model, buildContext(model), {
			apiKey: "test",
			env: { CLOUDFLARE_ACCOUNT_ID: "test" },
			onPayload: (value) => {
				payload = value;
				throw new Error("payload captured");
			},
		}).result();
		expect(payload).toMatchObject({
			messages: [
				{ role: "user" },
				{ role: "assistant", content, tool_calls: [{ id: "tool-1" }] },
				{ role: "tool" },
				{ role: "user" },
			],
		});
	});

	it("sends null content for tool-call-only assistant messages by default", () => {
		const model = buildModel();
		const messages = convertMessages(model, buildContext(model), baseCompat);
		const assistantMessages = messages.filter((message) => message.role === "assistant");
		expect(assistantMessages.length).toBe(1);
		expect(assistantMessages[0].content).toBe(null);
	});

	it("sends empty string content without inserting an assistant message after tool results", () => {
		const model = buildModel();
		const messages = convertMessages(model, buildContext(model), {
			...baseCompat,
			requiresNonNullAssistantContent: true,
		});
		const roles = messages.map((message) => message.role);
		expect(roles).toEqual(["user", "assistant", "tool", "user"]);
		const assistantMessages = messages.filter((message) => message.role === "assistant");
		expect(assistantMessages.length).toBe(1);
		expect(assistantMessages[0].content).toBe("");
	});

	it("still inserts an assistant message when requiresAssistantAfterToolResult is enabled", () => {
		const model = buildModel();
		const messages = convertMessages(model, buildContext(model), {
			...baseCompat,
			requiresAssistantAfterToolResult: true,
		});
		const roles = messages.map((message) => message.role);
		expect(roles).toEqual(["user", "assistant", "tool", "assistant", "user"]);
		const assistantMessages = messages.filter((message) => message.role === "assistant");
		expect(assistantMessages[0].content).toBe("");
		expect(assistantMessages[1].content).toBe("I have processed the tool results.");
	});
});

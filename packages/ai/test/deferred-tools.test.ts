import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { convertMessages } from "../src/api/openai-completions.ts";
import { getModel, streamSimple } from "../src/compat.ts";
import type { Api, AssistantMessage, Context, Model, Tool, ToolResultMessage, UserMessage } from "../src/types.ts";
import { estimateContextTokens } from "../src/utils/estimate.ts";

interface AnthropicToolPayload {
	name: string;
	description?: string;
	defer_loading?: boolean;
}

interface AnthropicContentBlock {
	type: string;
	text?: string;
	tool_use_id?: string;
	content?: string | Array<{ type: string; tool_name?: string }>;
	source?: {
		type: string;
		media_type: string;
		data: string;
	};
}

interface AnthropicPayload {
	tools?: AnthropicToolPayload[];
	messages: Array<{
		content: string | AnthropicContentBlock[];
	}>;
}

interface OpenAIToolSearchCall {
	type: "tool_search_call";
	call_id?: string | null;
	execution?: string;
	status?: string | null;
}

interface OpenAIToolSearchOutput {
	type: "tool_search_output";
	call_id?: string | null;
	execution?: string;
	status?: string | null;
	tools: Array<{ type: string; name: string; defer_loading?: boolean }>;
}

interface OpenAIAdditionalTools {
	type: "additional_tools";
	role: "developer";
	tools: Array<{ type: string; name: string; defer_loading?: boolean }>;
}

interface OpenAIPayload {
	tools?: Array<{ name?: string; function?: { name: string } }>;
	input?: Array<
		OpenAIAdditionalTools | OpenAIToolSearchCall | OpenAIToolSearchOutput | { type?: string; name?: string }
	>;
}

interface KimiTool {
	type: "function";
	function: {
		name: string;
		description?: string;
		parameters?: Record<string, unknown>;
	};
}

interface KimiMessage {
	role: string;
	content?: unknown;
	tools?: KimiTool[];
}

interface KimiPayload {
	tools?: KimiTool[];
	messages: KimiMessage[];
}

class PayloadCaptured extends Error {}

function makeTool(name: string): Tool {
	return {
		name,
		description: `The ${name} tool`,
		parameters: Type.Object({ value: Type.String() }),
	};
}

function makeUserMessage(timestamp: number): UserMessage {
	return { role: "user", content: "Hello", timestamp };
}

function makeAssistantToolCall(): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "toolCall", id: "call_1", name: "base_tool", arguments: {} }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-opus-4-6",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "toolUse",
		timestamp: 2,
	};
}

function makeToolResult(addedToolNames: string[]): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: "call_1",
		toolName: "base_tool",
		content: [{ type: "text", text: "done" }],
		addedToolNames,
		isError: false,
		timestamp: 3,
	};
}

function makeContext(tools: Tool[], addedToolNames = ["late_tool"]): Context {
	return {
		messages: [makeUserMessage(1), makeAssistantToolCall(), makeToolResult(addedToolNames), makeUserMessage(4)],
		tools,
	};
}

function makeKimiModel(deferredToolsMode?: "kimi"): Model<"openai-completions"> {
	return {
		id: "deferred-tools-model",
		name: "Deferred Tools Model",
		api: "openai-completions",
		provider: "moonshotai",
		baseUrl: "http://127.0.0.1:9/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 4096,
		compat: deferredToolsMode ? { deferredToolsMode } : undefined,
	};
}

async function capturePayload<T>(model: Model<Api>, context: Context, apiKey = "fake-key"): Promise<T> {
	let captured: T | undefined;
	const stream = streamSimple({ ...model, baseUrl: "http://127.0.0.1:9" }, context, {
		apiKey,
		onPayload: (payload) => {
			captured = payload as T;
			throw new PayloadCaptured();
		},
	});
	await stream.result();
	if (!captured) throw new Error("Expected payload capture");
	return captured;
}

function findAnthropicToolResultContent(payload: AnthropicPayload): AnthropicContentBlock[] {
	for (const message of payload.messages) {
		if (typeof message.content !== "string" && message.content.some((block) => block.type === "tool_result")) {
			return message.content;
		}
	}
	throw new Error("No tool result in payload");
}

function findAnthropicToolResult(payload: AnthropicPayload): AnthropicContentBlock {
	const result = findAnthropicToolResultContent(payload).find((block) => block.type === "tool_result");
	if (!result) throw new Error("No tool result in payload");
	return result;
}

function openAIToolNames(payload: OpenAIPayload): string[] {
	return (payload.tools ?? []).map((tool) => tool.name ?? tool.function?.name ?? "");
}

function makeCodexToken(): string {
	return `header.${btoa(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "account" } }))}.signature`;
}

describe("deferred tools", () => {
	it("loads an Anthropic tool at its tool-result marker", async () => {
		const context = makeContext([makeTool("base_tool"), makeTool("late_tool")]);
		const payload = await capturePayload<AnthropicPayload>(getModel("anthropic", "claude-opus-4-6"), context);

		expect(payload.tools).toMatchObject([{ name: "base_tool" }, { name: "late_tool", defer_loading: true }]);
		expect(findAnthropicToolResult(payload).content).toEqual([{ type: "tool_reference", tool_name: "late_tool" }]);
	});

	it("preserves tool output as sibling content after emitting references", async () => {
		const context = makeContext([makeTool("base_tool"), makeTool("late_tool")]);
		const assistant = context.messages[1] as AssistantMessage;
		assistant.content = [
			{ type: "toolCall", id: "call_1", name: "base_tool", arguments: {} },
			{ type: "toolCall", id: "call_2", name: "base_tool", arguments: {} },
		];
		const firstResult = context.messages[2] as ToolResultMessage;
		firstResult.content = [
			{ type: "text", text: "work completed" },
			{ type: "image", mimeType: "image/png", data: "aW1hZ2U=" },
		];
		context.messages.splice(3, 0, {
			...makeToolResult([]),
			toolCallId: "call_2",
			content: [{ type: "text", text: "second result" }],
		});

		const payload = await capturePayload<AnthropicPayload>(getModel("anthropic", "claude-opus-4-6"), context);

		expect(findAnthropicToolResultContent(payload)).toMatchObject([
			{
				type: "tool_result",
				tool_use_id: "call_1",
				content: [{ type: "tool_reference", tool_name: "late_tool" }],
			},
			{ type: "tool_result", tool_use_id: "call_2", content: "second result" },
			{ type: "text", text: "work completed" },
			{
				type: "image",
				source: { type: "base64", media_type: "image/png", data: "aW1hZ2U=" },
			},
		]);
	});

	it("loads a tool introduced by OpenAI history after switching to Anthropic", async () => {
		const context = makeContext([makeTool("base_tool"), makeTool("late_tool")]);
		const assistant = context.messages[1] as AssistantMessage;
		assistant.api = "openai-responses";
		assistant.provider = "openai";
		assistant.model = "gpt-5.4";

		const payload = await capturePayload<AnthropicPayload>(getModel("anthropic", "claude-opus-4-8"), context);

		expect(payload.tools).toMatchObject([{ name: "base_tool" }, { name: "late_tool", defer_loading: true }]);
		expect(findAnthropicToolResult(payload).content).toEqual([{ type: "tool_reference", tool_name: "late_tool" }]);
	});

	it("does not resurrect a marked tool missing from Context.tools", async () => {
		const context = makeContext([makeTool("base_tool")]);
		const payload = await capturePayload<AnthropicPayload>(getModel("anthropic", "claude-opus-4-6"), context);

		expect(payload.tools?.map((tool) => tool.name)).toEqual(["base_tool"]);
		const content = findAnthropicToolResult(payload).content;
		expect(Array.isArray(content) && content.some((block) => block.type === "tool_reference")).toBe(false);
	});

	it("keeps a tool immediate when it was used before its marker", async () => {
		const context = makeContext([makeTool("base_tool"), makeTool("late_tool")]);
		const assistant = context.messages[1] as AssistantMessage;
		assistant.content = [{ type: "toolCall", id: "call_1", name: "late_tool", arguments: {} }];
		const payload = await capturePayload<AnthropicPayload>(getModel("anthropic", "claude-opus-4-6"), context);

		expect(payload.tools?.map((tool) => tool.name)).toEqual(["base_tool", "late_tool"]);
		expect(payload.tools?.every((tool) => !tool.defer_loading)).toBe(true);
	});

	it("normalizes OAuth names before checking prior tool usage", async () => {
		const context = makeContext([makeTool("base_tool"), makeTool("read")], ["read"]);
		const assistant = context.messages[1] as AssistantMessage;
		assistant.content = [{ type: "toolCall", id: "call_1", name: "Read", arguments: {} }];
		const payload = await capturePayload<AnthropicPayload>(
			getModel("anthropic", "claude-opus-4-6"),
			context,
			"sk-ant-oat-fake",
		);

		expect(payload.tools?.map((tool) => tool.name)).toEqual(["base_tool", "Read"]);
		expect(payload.tools?.every((tool) => !tool.defer_loading)).toBe(true);
		const content = findAnthropicToolResult(payload).content;
		expect(Array.isArray(content) && content.some((block) => block.type === "tool_reference")).toBe(false);
	});

	it("matches OAuth-canonicalized markers to active tools", async () => {
		const context = makeContext([makeTool("base_tool"), makeTool("read")], ["Read"]);
		const payload = await capturePayload<AnthropicPayload>(
			getModel("anthropic", "claude-opus-4-6"),
			context,
			"sk-ant-oat-fake",
		);

		expect(payload.tools).toMatchObject([{ name: "base_tool" }, { name: "Read", defer_loading: true }]);
		const content = findAnthropicToolResult(payload).content;
		expect(
			Array.isArray(content) &&
				content.some((block) => block.type === "tool_reference" && block.tool_name === "Read"),
		).toBe(true);
	});

	it("deduplicates active tools after OAuth canonicalization", async () => {
		const context: Context = {
			messages: [makeUserMessage(1)],
			tools: [makeTool("read"), { ...makeTool("Read"), description: "Canonical definition" }],
		};
		const payload = await capturePayload<AnthropicPayload>(
			getModel("anthropic", "claude-opus-4-6"),
			context,
			"sk-ant-oat-fake",
		);

		expect(payload.tools).toMatchObject([{ name: "Read", description: "Canonical definition" }]);
	});

	it("uses the normal tool list when Anthropic tool references are unsupported", async () => {
		const context = makeContext([makeTool("base_tool"), makeTool("late_tool")]);
		const models: Model<"anthropic-messages">[] = [
			getModel("anthropic", "claude-haiku-4-5"),
			{ ...getModel("anthropic", "claude-opus-4-6"), id: "claude-sonnet-4-20250514" },
		];

		for (const model of models) {
			const payload = await capturePayload<AnthropicPayload>(model, context);
			expect(payload.tools?.map((tool) => tool.name)).toEqual(["base_tool", "late_tool"]);
			expect(payload.tools?.every((tool) => !tool.defer_loading)).toBe(true);
		}
	});

	it("keeps one immediate Anthropic tool when every current tool is marked", async () => {
		const context = makeContext([makeTool("late_tool")]);
		const payload = await capturePayload<AnthropicPayload>(getModel("anthropic", "claude-opus-4-6"), context);

		expect(payload.tools).toMatchObject([{ name: "late_tool" }]);
		expect(payload.tools?.[0]?.defer_loading).toBeUndefined();
		const content = findAnthropicToolResult(payload).content;
		expect(Array.isArray(content) && content.some((block) => block.type === "tool_reference")).toBe(false);
	});

	it("supports explicit Anthropic compatibility overrides", async () => {
		const model: Model<"anthropic-messages"> = {
			...getModel("anthropic", "claude-opus-4-6"),
			provider: "anthropic-proxy",
			compat: { supportsToolReferences: true },
		};
		const context = makeContext([makeTool("base_tool"), makeTool("late_tool")]);
		const payload = await capturePayload<AnthropicPayload>(model, context);

		expect(payload.tools?.find((tool) => tool.name === "late_tool")?.defer_loading).toBe(true);
	});

	it("serializes Kimi deferred tools as system tool definitions", async () => {
		const context = makeContext([makeTool("base_tool"), makeTool("late_tool")]);
		const payload = await capturePayload<KimiPayload>(makeKimiModel("kimi"), context);

		expect(payload.tools?.map((tool) => tool.function.name)).toEqual(["base_tool"]);
		const toolResultIndex = payload.messages.findIndex((message) => message.role === "tool");
		const systemToolIndex = payload.messages.findIndex((message) => message.tools !== undefined);
		expect(toolResultIndex).toBeGreaterThanOrEqual(0);
		expect(systemToolIndex).toBeGreaterThan(toolResultIndex);
		expect(payload.messages[systemToolIndex]?.tools?.map((tool) => tool.function.name)).toEqual(["late_tool"]);
	});

	it("emits Kimi deferred schemas after all tool results in a batch", () => {
		const context = makeContext([makeTool("base_tool"), makeTool("late_tool"), makeTool("later_tool")]);
		context.messages.splice(3, 0, {
			...makeToolResult(["later_tool"]),
			toolCallId: "call_2",
		});

		const messages = convertMessages(makeKimiModel("kimi"), context, {
			supportsStore: false,
			supportsDeveloperRole: false,
			supportsReasoningEffort: false,
			supportsUsageInStreaming: true,
			supportsFinishReason: true,
			maxTokensField: "max_tokens",
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
			supportsStrictMode: false,
			supportsOpenAIGrammarTools: false,
			cacheControlFormat: undefined,
			sendSessionAffinityHeaders: false,
			deferredToolsMode: "kimi",
			sessionAffinityFormat: "openai",
			supportsLongCacheRetention: false,
		});

		expect(messages.map((message) => message.role)).toEqual(["user", "assistant", "tool", "tool", "system", "user"]);
		expect((messages[4] as { tools?: KimiTool[] }).tools?.map((tool) => tool.function.name)).toEqual([
			"late_tool",
			"later_tool",
		]);
	});

	it("leaves OpenAI Completions tools unchanged without Kimi mode", async () => {
		const context = makeContext([makeTool("base_tool"), makeTool("late_tool")]);
		const payload = await capturePayload<KimiPayload>(makeKimiModel(), context);

		expect(payload.tools?.map((tool) => tool.function.name)).toEqual(["base_tool", "late_tool"]);
		expect(payload.messages.some((message) => message.tools !== undefined)).toBe(false);
	});

	it("loads an OpenAI Responses tool through additional_tools", async () => {
		const context = makeContext([makeTool("base_tool"), makeTool("late_tool")]);
		const payload = await capturePayload<OpenAIPayload>(getModel("openai", "gpt-5.4"), context);
		const additionalTools = payload.input?.find(
			(item): item is OpenAIAdditionalTools => item.type === "additional_tools",
		);

		expect(openAIToolNames(payload)).toEqual(["base_tool"]);
		expect(additionalTools).toMatchObject({ role: "developer" });
		expect(additionalTools?.tools).toMatchObject([{ type: "function", name: "late_tool" }]);
		expect(additionalTools?.tools.every((tool) => tool.defer_loading === undefined)).toBe(true);
		expect(payload.input?.some((item) => item.type === "tool_search_call")).toBe(false);
		expect(payload.input?.some((item) => item.type === "tool_search_output")).toBe(false);
	});

	it("preserves an additional_tools marker after the loaded tool is used", async () => {
		const context = makeContext([makeTool("base_tool"), makeTool("late_tool")]);
		const lateCall: AssistantMessage = {
			...makeAssistantToolCall(),
			content: [{ type: "toolCall", id: "call_late|fc_late", name: "late_tool", arguments: {} }],
			api: "openai-responses",
			provider: "openai",
			model: "gpt-5.4",
		};
		context.messages.splice(3, 0, lateCall, {
			...makeToolResult(["late_tool"]),
			toolCallId: "call_late|fc_late",
			toolName: "late_tool",
		});

		const payload = await capturePayload<OpenAIPayload>(getModel("openai", "gpt-5.4"), context);
		const additionalToolIndexes = (payload.input ?? []).flatMap((item, index) =>
			item.type === "additional_tools" ? [index] : [],
		);
		const lateCallIndex = (payload.input ?? []).findIndex(
			(item) => item.type === "function_call" && item.name === "late_tool",
		);

		expect(additionalToolIndexes).toHaveLength(1);
		expect(additionalToolIndexes[0]).toBeLessThan(lateCallIndex);
		expect(openAIToolNames(payload)).toEqual(["base_tool"]);
	});

	it("falls back to client tool search when additional_tools is unsupported", async () => {
		const model: Model<"openai-responses"> = {
			...getModel("openai", "gpt-5.4"),
			provider: "openai-proxy",
			compat: { supportsAdditionalTools: false, supportsToolSearch: true },
		};
		const context = makeContext([makeTool("base_tool"), makeTool("late_tool")]);
		const payload = await capturePayload<OpenAIPayload>(model, context);
		const searchCall = payload.input?.find((item): item is OpenAIToolSearchCall => item.type === "tool_search_call");
		const searchOutput = payload.input?.find(
			(item): item is OpenAIToolSearchOutput => item.type === "tool_search_output",
		);

		expect(openAIToolNames(payload)).toEqual(["base_tool"]);
		expect(searchCall).toMatchObject({ execution: "client", status: "completed" });
		expect(searchOutput?.call_id).toBe(searchCall?.call_id);
		expect(searchOutput?.tools).toMatchObject([{ type: "function", name: "late_tool", defer_loading: true }]);
		expect(payload.input?.some((item) => item.type === "additional_tools")).toBe(false);
	});

	it.each(["gpt-5.2", "gpt-5.4-nano", "gpt-5.5-pro"] as const)(
		"uses the normal tool list for unsupported OpenAI model %s",
		async (modelId) => {
			const context = makeContext([makeTool("base_tool"), makeTool("late_tool")]);
			const payload = await capturePayload<OpenAIPayload>(getModel("openai", modelId), context);

			expect(openAIToolNames(payload)).toEqual(["base_tool", "late_tool"]);
			expect(payload.input?.some((item) => item.type === "tool_search_output")).toBe(false);
		},
	);

	it("uses the normal tool list when OpenAI tool search is explicitly disabled", async () => {
		const model: Model<"openai-responses"> = {
			...getModel("openai", "gpt-5.4"),
			provider: "openai-proxy",
			compat: { supportsToolSearch: false },
		};
		const context = makeContext([makeTool("base_tool"), makeTool("late_tool")]);
		const payload = await capturePayload<OpenAIPayload>(model, context);

		expect(openAIToolNames(payload)).toEqual(["base_tool", "late_tool"]);
		expect(payload.input?.some((item) => item.type === "tool_search_output")).toBe(false);
	});

	it("selects additional tools, tool search, or top-level tools for Codex models", async () => {
		const context = makeContext([makeTool("base_tool"), makeTool("late_tool")]);
		const additionalTools = await capturePayload<OpenAIPayload>(
			getModel("openai-codex", "gpt-5.6-sol"),
			context,
			makeCodexToken(),
		);
		const toolSearch = await capturePayload<OpenAIPayload>(
			getModel("openai-codex", "gpt-5.4"),
			context,
			makeCodexToken(),
		);
		const topLevel = await capturePayload<OpenAIPayload>(
			getModel("openai-codex", "gpt-5.3-codex-spark"),
			context,
			makeCodexToken(),
		);

		expect(openAIToolNames(additionalTools)).toEqual(["base_tool"]);
		expect(additionalTools.input?.some((item) => item.type === "additional_tools")).toBe(true);
		expect(additionalTools.input?.some((item) => item.type === "tool_search_output")).toBe(false);
		expect(openAIToolNames(toolSearch)).toEqual(["base_tool"]);
		expect(toolSearch.input?.some((item) => item.type === "tool_search_output")).toBe(true);
		expect(openAIToolNames(topLevel)).toEqual(["base_tool", "late_tool"]);
		expect(topLevel.input?.some((item) => item.type === "additional_tools")).toBe(false);
		expect(topLevel.input?.some((item) => item.type === "tool_search_output")).toBe(false);
	});

	it("leaves providers without deferred loading unchanged", async () => {
		const context = makeContext([makeTool("base_tool"), makeTool("late_tool")]);
		const payload = await capturePayload<OpenAIPayload>(getModel("groq", "llama-3.3-70b-versatile"), context);
		expect(openAIToolNames(payload)).toEqual(["base_tool", "late_tool"]);
	});

	it("counts definitions marked after the latest usage checkpoint", () => {
		const assistant: AssistantMessage = {
			...makeAssistantToolCall(),
			content: [{ type: "text", text: "done" }],
			usage: {
				input: 50,
				output: 50,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 100,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
		};
		const plain = estimateContextTokens({ messages: [assistant, makeUserMessage(4)], tools: [] });
		const lateTool = { ...makeTool("late_tool"), description: "x".repeat(4000) };
		const marked = estimateContextTokens({
			messages: [assistant, makeToolResult(["late_tool"])],
			tools: [lateTool],
		});

		expect(marked.tokens).toBeGreaterThan(plain.tokens + 500);
		expect(marked.trailingTokens).toBeGreaterThan(plain.trailingTokens + 500);
	});
});

import { Type } from "typebox";
import { describe, expect, test } from "vitest";
import { getModel, streamSimple } from "../src/compat.ts";
import type { Api, AssistantMessage, Context, Message, Model, SystemMessage, Tool } from "../src/types.ts";
import { resolveTranscriptTools } from "../src/utils/transcript.ts";

class PayloadCaptured extends Error {}

function tool(name: string): Tool {
	return { name, description: `${name} tool`, parameters: Type.Object({}) };
}

async function capturePayload<T>(model: Model<Api>, context: Context): Promise<T> {
	let captured: T | undefined;
	const stream = streamSimple(model, context, {
		apiKey: "test-key",
		onPayload: (payload) => {
			captured = payload as T;
			throw new PayloadCaptured();
		},
	});
	await stream.result();
	if (!captured) throw new Error("Expected payload capture");
	return captured;
}

const modelBase = {
	baseUrl: "http://127.0.0.1:9",
	reasoning: true,
	input: ["text"] as ("text" | "image")[],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 100000,
	maxTokens: 1000,
};

const baseTool = tool("base_tool");
const lateTool = tool("late_tool");
const dropTool = tool("drop_tool");

/**
 * Capture one request after each step: initial tools, removal of drop_tool, then two loads.
 * Returns the payloads after the removal and after each load, plus the one before the removal.
 */
async function captureToolHistory<T>(model: Model<Api>): Promise<T[]> {
	const steps: Message[][] = [
		[{ role: "user", content: "first", timestamp: 1 }],
		[
			{ role: "system", content: "", toolsRemoved: [{ name: "drop_tool" }], timestamp: 2 },
			{ role: "user", content: "after removal", timestamp: 3 },
		],
		[
			{ role: "system", content: "", toolsAdded: [lateTool], timestamp: 4 },
			{ role: "user", content: "after first load", timestamp: 5 },
		],
		[
			{ role: "system", content: "", toolsAdded: [tool("later_tool")], timestamp: 6 },
			{ role: "user", content: "after second load", timestamp: 7 },
		],
	];
	const messages: Message[] = [
		{ role: "system", content: "base prompt", toolsAdded: [baseTool, dropTool], timestamp: 0 },
	];
	const payloads: T[] = [];
	for (const step of steps) {
		messages.push(...step);
		payloads.push(await capturePayload<T>(model, { messages: [...messages] }));
	}
	return payloads;
}

/** Every request's message list starts with the previous request's message list. */
function expectGrowingPrefix(inputs: readonly unknown[][]): void {
	for (let index = 1; index < inputs.length; index++) {
		const previous = inputs[index - 1] ?? [];
		expect(inputs[index]?.slice(0, previous.length)).toEqual(previous);
	}
}

type ResponsesPayload = {
	tools?: Array<{ name: string; description?: string }>;
	input: Array<{ type?: string; role?: string; content?: string; tools?: Array<{ name: string }> }>;
};

const additionalToolsModel: Model<"openai-responses"> = {
	...modelBase,
	id: "gpt-5.4",
	name: "GPT-5.4",
	api: "openai-responses",
	provider: "openai",
	compat: { supportsMidConvoSystemMessages: true, supportsAdditionalTools: true },
};
const context: Context = {
	messages: [
		{
			role: "system",
			content: "base prompt",
			sections: { rules: "<rules>\nold rules\n</rules>", docs: "<docs>\nread docs\n</docs>" },
			toolsAdded: [baseTool],
			timestamp: 0,
		},
		{ role: "user", content: "before", timestamp: 1 },
		{
			role: "system",
			content: "updated guidance",
			sections: { rules: "<rules>\nnew rules\n</rules>", docs: null },
			toolsRemoved: [{ name: "base_tool" }],
			toolsAdded: [lateTool],
			timestamp: 2,
		},
	],
};
const additionContext: Context = {
	messages: [
		{ role: "system", content: "base prompt", toolsAdded: [baseTool], timestamp: 0 },
		{ role: "user", content: "before", timestamp: 1 },
		{ role: "system", content: "updated guidance", toolsAdded: [lateTool], timestamp: 2 },
	],
};

const anthropicNativeModel: Model<"anthropic-messages"> = {
	...modelBase,
	id: "claude-opus-5",
	name: "Claude Opus 5",
	api: "anthropic-messages",
	provider: "anthropic",
	compat: { supportsMidConvoSystemMessages: true, supportsMidConvoToolChanges: true },
};

interface AnthropicToolDefinition {
	name: string;
	description?: string;
	defer_loading?: boolean;
	cache_control?: unknown;
}

interface AnthropicPayload {
	betas?: string[];
	system?: Array<{ text: string }>;
	tools?: AnthropicToolDefinition[];
	messages: Array<{
		role: string;
		content: Array<{
			type: string;
			text?: string;
			cache_control?: unknown;
			tool?: { type: string; name?: string; definition?: AnthropicToolDefinition };
		}>;
	}>;
}

describe("transcript system messages", () => {
	test("sends Anthropic updates and tool changes in native system messages", async () => {
		const payload = await capturePayload<AnthropicPayload>(anthropicNativeModel, context);

		expect(payload.betas).toContain("inline-tools-2026-09-15");
		expect(payload.betas).not.toContain("mid-conversation-tool-changes-2026-07-01");
		expect(payload.system?.map((block) => block.text)).toEqual([
			"base prompt\n\n<rules>\nold rules\n</rules>\n\n<docs>\nread docs\n</docs>",
		]);
		// The top-level list holds only the initial tools (with the cache breakpoint) and the
		// deferred placeholder; later tools never appear there.
		expect(payload.tools).toMatchObject([
			{ name: "base_tool", cache_control: { type: "ephemeral" } },
			{ name: "__pi_deferred_placeholder__", defer_loading: true },
		]);
		expect(payload.tools).toHaveLength(2);
		expect(payload.tools?.[0]?.defer_loading).toBeUndefined();
		expect(payload.tools?.[1]?.cache_control).toBeUndefined();
		const update = payload.messages.at(-1);
		expect(update).toMatchObject({
			role: "system",
			content: [
				{ type: "text" },
				{ type: "tool_removal", tool: { type: "tool_reference", name: "base_tool" } },
				{
					type: "tool_addition",
					tool: { type: "tool_definition", definition: { name: "late_tool", description: "late_tool tool" } },
					cache_control: { type: "ephemeral" },
				},
			],
		});
		// Cache control goes on the block, never on the inline definition; nothing is deferred.
		const definition = update?.content[2]?.tool?.definition;
		expect(definition?.cache_control).toBeUndefined();
		expect(definition?.defer_loading).toBeUndefined();
		expect(update?.content[0]?.text).toContain("updated guidance");
		expect(update?.content[0]?.text).toContain("<rules>\nnew rules\n</rules>");
		expect(update?.content[0]?.text).toContain('Removed system prompt section "docs"');

		// The placeholder is declared before any change so its scaffolding is cached from request one.
		const initial = await capturePayload<AnthropicPayload>(anthropicNativeModel, {
			messages: context.messages.slice(0, 2),
		});
		expect(initial.tools?.map((tool) => tool.name)).toEqual(["base_tool", "__pi_deferred_placeholder__"]);
	});

	test("redefines an Anthropic tool by value under the same name", async () => {
		const redefinedTool = { ...baseTool, description: "changed" };
		const payload = await capturePayload<AnthropicPayload>(anthropicNativeModel, {
			messages: [
				{ role: "system", content: "base prompt", toolsAdded: [baseTool], timestamp: 0 },
				{ role: "user", content: "before", timestamp: 1 },
				{
					role: "system",
					content: "",
					toolsRemoved: [{ name: "base_tool" }],
					toolsAdded: [redefinedTool],
					timestamp: 2,
				},
			],
		});

		expect(payload.betas).toContain("inline-tools-2026-09-15");
		// The top-level declaration keeps the original definition, so the cached prefix survives.
		expect(payload.tools).toMatchObject([
			{ name: "base_tool", description: "base_tool tool" },
			{ name: "__pi_deferred_placeholder__" },
		]);
		// The new definition replaces the old one in place; no removal block is sent for it.
		expect(payload.messages.at(-1)).toMatchObject({
			role: "system",
			content: [
				{
					type: "tool_addition",
					tool: { type: "tool_definition", definition: { name: "base_tool", description: "changed" } },
				},
			],
		});
		expect(payload.messages.at(-1)?.content).toHaveLength(1);
	});

	test("sends the current Anthropic tool list without an initial tool", async () => {
		// Anthropic rejects a tool list where every tool (here: the placeholder) is deferred.
		const payload = await capturePayload<AnthropicPayload>(anthropicNativeModel, {
			messages: [
				{ role: "system", content: "base prompt", timestamp: 0 },
				{ role: "user", content: "before", timestamp: 1 },
				{ role: "system", content: "updated guidance", toolsAdded: [lateTool], timestamp: 2 },
			],
		});
		expect(payload.betas ?? []).not.toContain("inline-tools-2026-09-15");
		expect(payload.tools).toMatchObject([{ name: "late_tool", cache_control: { type: "ephemeral" } }]);
		expect(payload.tools?.[0]?.defer_loading).toBeUndefined();
		expect(payload.messages.at(-1)?.content.map((block) => block.type)).toEqual(["text"]);
	});

	// #11091
	test("holds an Anthropic update past an assistant message that converts to no blocks", async () => {
		const reply = (text: string, provider: string, api: Api, model: string): AssistantMessage => ({
			role: "assistant",
			content: [{ type: "text", text }],
			api,
			provider,
			model,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: 3,
		});
		const messages: Message[] = [
			{ role: "system", content: "base prompt", timestamp: 0 },
			{ role: "user", content: "hi", timestamp: 1 },
			{ role: "system", content: "updated guidance", timestamp: 2 },
			// Another model's empty reply: Anthropic rejects empty text blocks, so it is dropped.
			reply("", "openai-codex", "openai-codex-responses", "gpt-x"),
			{ role: "user", content: "again", timestamp: 4 },
		];
		const roles = (payload: AnthropicPayload) => payload.messages.map((message) => message.role);

		// No later assistant: the update goes at the end.
		const atEnd = await capturePayload<AnthropicPayload>(anthropicNativeModel, { messages });
		expect(roles(atEnd)).toEqual(["user", "user", "system"]);

		// A later assistant that is sent: the update goes directly before it.
		const beforeAssistant = await capturePayload<AnthropicPayload>(anthropicNativeModel, {
			messages: [
				...messages,
				reply("answer", anthropicNativeModel.provider, anthropicNativeModel.api, anthropicNativeModel.id),
				{ role: "user", content: "third", timestamp: 5 },
			],
		});
		expect(roles(beforeAssistant)).toEqual(["user", "user", "system", "assistant", "user"]);
	});

	test("folds Anthropic updates into the system prompt without native support", async () => {
		const model: Model<"anthropic-messages"> = {
			...modelBase,
			id: "claude-sonnet-4-5",
			name: "Claude Sonnet 4.5",
			api: "anthropic-messages",
			provider: "anthropic",
		};
		const payload = await capturePayload<{
			betas?: string[];
			system?: Array<{ text: string }>;
			tools?: Array<{ name: string }>;
			messages: Array<{ role: string }>;
		}>(model, context);

		expect(payload.betas ?? []).not.toContain("inline-tools-2026-09-15");
		expect(payload.system?.map((block) => block.text)).toEqual([
			"base prompt\n\nupdated guidance\n\n<rules>\nnew rules\n</rules>",
		]);
		expect(payload.tools?.map((value) => value.name)).toEqual(["late_tool"]);
		expect(payload.messages.map((message) => message.role)).toEqual(["user"]);
	});

	test("requires both Anthropic capabilities for native tool changes", async () => {
		const model: Model<"anthropic-messages"> = {
			...modelBase,
			id: "claude-opus-5",
			name: "Claude Opus 5",
			api: "anthropic-messages",
			provider: "anthropic",
			compat: { supportsMidConvoToolChanges: true },
		};
		const payload = await capturePayload<{
			betas?: string[];
			tools?: Array<{ name: string }>;
			messages: Array<{ role: string }>;
		}>(model, context);

		expect(payload.betas ?? []).not.toContain("inline-tools-2026-09-15");
		expect(payload.tools?.map((value) => value.name)).toEqual(["late_tool"]);
		expect(payload.messages.map((message) => message.role)).toEqual(["user"]);
	});

	test("declares every OpenAI tool in additional_tools at its developer message", async () => {
		const payload = await capturePayload<ResponsesPayload>(additionalToolsModel, additionContext);

		// A later additional_tools item cannot replace a top-level tool, so no tool is declared there.
		expect(payload.tools).toBeUndefined();
		expect(
			payload.input.filter((item) => item.type === "additional_tools").map((item) => item.tools?.[0]?.name),
		).toEqual(["base_tool", "late_tool"]);
		// The incremental notice keeps models from reading a later item as the complete tool set.
		expect(payload.input.map((item) => item.type ?? item.content)).toEqual([
			"additional_tools",
			"base prompt",
			expect.any(Array),
			expect.stringContaining("incremental tools update"),
			"additional_tools",
			"updated guidance",
		]);
	});

	test("maps system-message additions into synthetic tool search", async () => {
		const model: Model<"openai-responses"> = {
			...modelBase,
			id: "gpt-5.4",
			name: "GPT-5.4",
			api: "openai-responses",
			provider: "openai",
			compat: { supportsMidConvoSystemMessages: true, supportsToolSearch: true },
		};
		const payload = await capturePayload<{
			tools?: Array<{ name: string }>;
			input: Array<{ type?: string; tools?: Array<{ name: string }> }>;
		}>(model, additionContext);

		expect(payload.tools?.map((value) => value.name)).toEqual(["base_tool"]);
		expect(payload.input.map((item) => item.type)).toContain("tool_search_call");
		expect(
			payload.input.find((item) => item.type === "tool_search_output")?.tools?.map((value) => value.name),
		).toEqual(["late_tool"]);
	});

	test("folds OpenAI updates into the leading developer message without native support", async () => {
		const model: Model<"openai-responses"> = {
			...modelBase,
			id: "gpt-4.1",
			name: "GPT-4.1",
			api: "openai-responses",
			provider: "openai",
			compat: { supportsAdditionalTools: true },
		};
		const payload = await capturePayload<{
			tools?: Array<{ name: string }>;
			input: Array<{ type?: string; role?: string; content?: string }>;
		}>(model, context);

		expect(payload.tools?.map((value) => value.name)).toEqual(["late_tool"]);
		expect(payload.input.map((item) => item.type ?? item.role)).toEqual(["developer", "user"]);
		expect(payload.input[0]?.content).toBe("base prompt\n\nupdated guidance\n\n<rules>\nnew rules\n</rules>");
	});

	test("announces OpenAI removals as text", async () => {
		const payload = await capturePayload<ResponsesPayload>(additionalToolsModel, context);

		expect(payload.tools).toBeUndefined();
		expect(
			payload.input.filter((item) => item.type === "additional_tools").map((item) => item.tools?.[0]?.name),
		).toEqual(["base_tool", "late_tool"]);
		const update = payload.input.at(-1)?.content;
		expect(update).toContain("updated guidance");
		expect(update).toContain("The following tools are no longer available. Do not call them:\n- base_tool");
	});

	test("redefines an OpenAI tool with additional_tools instead of announcing a removal", async () => {
		const payload = await capturePayload<ResponsesPayload>(additionalToolsModel, {
			messages: [
				{ role: "system", content: "base prompt", toolsAdded: [baseTool], timestamp: 0 },
				{ role: "user", content: "before", timestamp: 1 },
				{
					role: "system",
					content: "",
					toolsRemoved: [{ name: "base_tool" }],
					toolsAdded: [{ ...baseTool, description: "changed" }],
					timestamp: 2,
				},
			],
		});

		expect(payload.tools).toBeUndefined();
		expect(payload.input).toMatchObject([
			{ type: "additional_tools", tools: [{ name: "base_tool", description: "base_tool tool" }] },
			{ role: "developer", content: "base prompt" },
			{ role: "user" },
			{ role: "developer", content: expect.stringContaining("latest definition replaces the earlier one") },
			{ type: "additional_tools", tools: [{ name: "base_tool", description: "changed" }] },
		]);
		expect(payload.input).toHaveLength(5);
	});

	// #10940: deferred loads after a removal must not rewrite the cached prefix.
	test("keeps the OpenAI request prefix across a removal and later loads", async () => {
		const payloads = await captureToolHistory<ResponsesPayload>(additionalToolsModel);

		for (const payload of payloads) expect(payload.tools).toBeUndefined();
		expectGrowingPrefix(payloads.map((payload) => payload.input));
		const last = payloads.at(-1);
		expect(
			last?.input.filter((item) => item.type === "additional_tools").map((item) => item.tools?.map((t) => t.name)),
		).toEqual([["base_tool", "drop_tool"], ["late_tool"], ["later_tool"]]);
		expect(
			last?.input.some((item) => item.content?.includes("no longer available. Do not call them:\n- drop_tool")),
		).toBe(true);
		// Each later load restates the tools that are still unavailable.
		expect(
			last?.input.filter((item) => item.content?.includes("incremental tools update")).map((item) => item.content),
		).toEqual([
			expect.stringContaining("\nStill unavailable: drop_tool."),
			expect.stringContaining("\nStill unavailable: drop_tool."),
		]);
	});

	test("stops listing a tool as unavailable once it is declared again", async () => {
		const payload = await capturePayload<ResponsesPayload>(additionalToolsModel, {
			messages: [
				{ role: "system", content: "base prompt", toolsAdded: [baseTool, dropTool], timestamp: 0 },
				{ role: "system", content: "", toolsRemoved: [{ name: "drop_tool" }], timestamp: 1 },
				{ role: "system", content: "", toolsAdded: [dropTool], timestamp: 2 },
				{ role: "user", content: "go", timestamp: 3 },
			],
		});

		const notice = payload.input.find((item) => item.content?.includes("incremental tools update"))?.content;
		expect(notice).toBeDefined();
		expect(notice).not.toContain("Still unavailable");
		expect(payload.input.at(-2)).toMatchObject({ type: "additional_tools", tools: [{ name: "drop_tool" }] });
	});

	test("does not list a tool as still unavailable before its removal is announced", async () => {
		const payload = await capturePayload<ResponsesPayload>(additionalToolsModel, {
			messages: [
				{ role: "system", content: "base prompt", toolsAdded: [baseTool, dropTool], timestamp: 0 },
				{
					role: "system",
					content: "",
					toolsAdded: [lateTool],
					toolsRemoved: [{ name: "drop_tool" }],
					timestamp: 1,
				},
				{ role: "user", content: "go", timestamp: 2 },
			],
		});

		// Like Codex: notice, then the tools, then the removal notice.
		const [notice] = payload.input.slice(-4);
		expect(notice?.content).toContain("incremental tools update");
		expect(notice?.content).not.toContain("Still unavailable");
		expect(payload.input.slice(-3)).toMatchObject([
			{ type: "additional_tools", tools: [{ name: "late_tool" }] },
			{ content: expect.stringContaining("no longer available. Do not call them:\n- drop_tool") },
			{ role: "user" },
		]);
	});

	// #10940: synthetic tool search cannot remove tools, so a removal rewrites the prefix once.
	test("keeps the OpenAI tool search prefix across loads after a removal", async () => {
		const model: Model<"openai-responses"> = {
			...additionalToolsModel,
			compat: { supportsMidConvoSystemMessages: true, supportsToolSearch: true },
		};
		const [beforeRemoval, ...afterRemoval] = await captureToolHistory<ResponsesPayload>(model);

		expect(beforeRemoval?.tools?.map((value) => value.name)).toEqual(["base_tool", "drop_tool"]);
		for (const payload of afterRemoval) expect(payload.tools?.map((value) => value.name)).toEqual(["base_tool"]);
		expectGrowingPrefix(afterRemoval.map((payload) => payload.input));
		expect(
			afterRemoval
				.at(-1)
				?.input.filter((item) => item.type === "tool_search_output")
				.map((item) => item.tools?.[0]?.name),
		).toEqual(["late_tool", "later_tool"]);
	});

	// #10940: removals and redeclarations move the top-level boundary once; plain additions stay anchored.
	test("resolves the top-level tool boundary per transport", () => {
		const messages = [
			{ role: "system", content: "base prompt", toolsAdded: [baseTool, dropTool], timestamp: 0 },
			{ role: "system", content: "", toolsRemoved: [{ name: "drop_tool" }], timestamp: 1 },
			{ role: "system", content: "", toolsAdded: [dropTool], timestamp: 2 },
			{ role: "system", content: "", toolsAdded: [{ ...lateTool, description: "x" }], timestamp: 3 },
			{ role: "system", content: "", toolsAdded: [{ ...lateTool, description: "y" }], timestamp: 4 },
		] satisfies SystemMessage[];

		expect(resolveTranscriptTools(messages.slice(0, 2), "additions")).toEqual({
			requestTools: [baseTool],
			foldedSystemMessages: 2,
		});
		// Kimi K3 ignores a removed tool that a later tool message declares again, so the re-added
		// drop_tool moves the boundary; the new late_tool after it stays anchored.
		expect(resolveTranscriptTools(messages.slice(0, 4), "additions")).toEqual({
			requestTools: [baseTool, dropTool],
			foldedSystemMessages: 3,
		});
		// The redefinition of late_tool moves the boundary to its message.
		expect(resolveTranscriptTools(messages, "additions")).toEqual({
			requestTools: [baseTool, dropTool, { ...lateTool, description: "y" }],
			foldedSystemMessages: 5,
		});
		expect(resolveTranscriptTools(messages, "changes")).toEqual({ requestTools: [], foldedSystemMessages: 0 });
		expect(resolveTranscriptTools(messages, "none")).toEqual({
			requestTools: [baseTool, dropTool, { ...lateTool, description: "y" }],
			foldedSystemMessages: 5,
		});
	});

	test("anchors Kimi additions in tool-bearing system messages", async () => {
		const model: Model<"openai-completions"> = {
			...modelBase,
			id: "kimi-k3",
			name: "Kimi K3",
			api: "openai-completions",
			provider: "moonshotai",
			compat: { supportsMidConvoSystemMessages: true, supportsMidConvoToolAdditions: true },
		};
		const payload = await capturePayload<{
			tools?: Array<{ function?: { name: string } }>;
			messages: Array<{ role: string; content?: string; tools?: Array<{ function?: { name: string } }> }>;
		}>(model, additionContext);

		expect(payload.tools?.map((value) => value.function?.name)).toEqual(["base_tool"]);
		expect(payload.messages.find((message) => message.tools)?.tools?.map((value) => value.function?.name)).toEqual([
			"late_tool",
		]);
		expect(payload.messages.filter((message) => message.role === "system").map((message) => message.content)).toEqual(
			["base prompt", undefined, "updated guidance"],
		);
	});

	type KimiPayload = {
		tools?: Array<{ function?: { name: string } }>;
		messages: Array<{ role: string; tools?: Array<{ function?: { name: string } }> }>;
	};

	// #10940: Kimi tool messages cannot remove tools, so a removal rewrites the prefix once.
	test("keeps the Kimi prefix across loads after a removal", async () => {
		const [beforeRemoval, ...afterRemoval] = await captureToolHistory<KimiPayload>(getModel("kimi-coding", "k3"));

		expect(beforeRemoval?.tools?.map((value) => value.function?.name)).toEqual(["base_tool", "drop_tool"]);
		for (const payload of afterRemoval) {
			expect(payload.tools?.map((value) => value.function?.name)).toEqual(["base_tool"]);
		}
		expectGrowingPrefix(afterRemoval.map((payload) => payload.messages));
		expect(
			afterRemoval
				.at(-1)
				?.messages.filter((message) => message.tools)
				.map((message) => message.tools?.[0]?.function?.name),
		).toEqual(["late_tool", "later_tool"]);
	});

	// #10720: Kimi Coding uses Chat Completions so K3-style models keep added tools out of the top-level list.
	test.each(["k3", "k3-256k", "kimi-for-coding"] as const)("anchors additions for Kimi Coding %s", async (modelId) => {
		const payload = await capturePayload<KimiPayload>(getModel("kimi-coding", modelId), additionContext);

		expect(payload.tools?.map((value) => value.function?.name)).toEqual(["base_tool"]);
		expect(payload.messages.find((message) => message.tools)?.tools?.map((value) => value.function?.name)).toEqual([
			"late_tool",
		]);
	});

	// #10720: Kimi Code Highspeed rejects tool-bearing system messages.
	test("keeps Kimi Coding Highspeed additions in top-level tools", async () => {
		const payload = await capturePayload<KimiPayload>(
			getModel("kimi-coding", "kimi-for-coding-highspeed"),
			additionContext,
		);

		expect(payload.tools?.map((value) => value.function?.name)).toEqual(["base_tool", "late_tool"]);
		expect(payload.messages.some((message) => message.tools !== undefined)).toBe(false);
	});

	test("keeps Kimi K2 system text inline without dynamic tool messages", async () => {
		const model: Model<"openai-completions"> = {
			...modelBase,
			id: "kimi-k2.7-code",
			name: "Kimi K2.7 Code",
			api: "openai-completions",
			provider: "moonshotai",
			compat: { supportsMidConvoSystemMessages: true },
		};
		const payload = await capturePayload<{
			tools?: Array<{ function?: { name: string } }>;
			messages: Array<{ role: string; content?: string; tools?: Array<{ function?: { name: string } }> }>;
		}>(model, additionContext);

		expect(payload.tools?.map((value) => value.function?.name)).toEqual(["base_tool", "late_tool"]);
		expect(payload.messages.some((message) => message.tools !== undefined)).toBe(false);
		expect(payload.messages.filter((message) => message.role === "system").map((message) => message.content)).toEqual(
			["base prompt", "updated guidance"],
		);
	});

	test("folds OpenAI-compatible updates into the system prompt without native support", async () => {
		const model: Model<"openai-completions"> = {
			...modelBase,
			id: "custom-model",
			name: "Custom model",
			api: "openai-completions",
			provider: "custom-provider",
			reasoning: false,
		};
		const payload = await capturePayload<{
			tools?: Array<{ function?: { name: string } }>;
			messages: Array<{ role: string; content?: string }>;
		}>(model, context);

		expect(payload.tools?.map((value) => value.function?.name)).toEqual(["late_tool"]);
		expect(payload.messages.map((message) => message.role)).toEqual(["system", "user"]);
		expect(payload.messages[0]?.content).toBe("base prompt\n\nupdated guidance\n\n<rules>\nnew rules\n</rules>");
	});
});

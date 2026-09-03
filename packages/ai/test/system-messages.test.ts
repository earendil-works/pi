import { Type } from "typebox";
import { describe, expect, test } from "vitest";
import { getModel, streamSimple } from "../src/compat.ts";
import type { Api, AssistantMessage, Context, Model, Tool } from "../src/types.ts";
import { declaredTools, splitDeferredTools } from "../src/utils/deferred-tools.ts";
import { renderSystemMessageAsUserText, resolveMessageToolChange } from "../src/utils/system-messages.ts";

const PLACEHOLDER = "__pi_deferred_tool_placeholder__";

function makeTool(name: string, description = `The ${name} tool`): Tool {
	return { name, description, parameters: Type.Object({}) };
}

function makeAssistant(toolName?: string): AssistantMessage {
	return {
		role: "assistant",
		content: toolName
			? [{ type: "toolCall", id: "call_1", name: toolName, arguments: {} }]
			: [{ type: "text", text: "ok" }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-fable-5-1",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 2,
	};
}

class PayloadCaptured extends Error {}

interface AnthropicPayload {
	betas?: string[];
	tools?: Array<{ name: string; defer_loading?: boolean; description?: string }>;
	messages: Array<{
		role: string;
		content: string | Array<{ type: string; text?: string; tool?: { type: string; name: string } }>;
		output_config?: unknown;
	}>;
}

/** Message roles without the effort-only system entries managed effort models append. */
function contentRoles(payload: AnthropicPayload): string[] {
	return payload.messages.filter((message) => message.output_config === undefined).map((message) => message.role);
}

async function captureAnthropic(model: Model<Api>, context: Context): Promise<AnthropicPayload> {
	let captured: AnthropicPayload | undefined;
	const stream = streamSimple({ ...model, baseUrl: "http://127.0.0.1:9" }, context, {
		apiKey: "fake-key",
		onPayload: (payload) => {
			captured = payload as AnthropicPayload;
			throw new PayloadCaptured();
		},
	});
	await stream.result();
	if (!captured) throw new Error("Expected payload capture");
	return captured;
}

describe("system message helpers", () => {
	test("renders operator text as a tagged user block", () => {
		expect(renderSystemMessageAsUserText({ role: "system", content: "changed", timestamp: 1 })).toBe(
			"<system_update>\nchanged\n</system_update>",
		);
		expect(renderSystemMessageAsUserText({ role: "system", content: "", timestamp: 1 })).toBe("");
	});

	test("unifies tool-result markers and system message deltas", () => {
		const tool = makeTool("late_tool");
		expect(
			resolveMessageToolChange(
				{
					role: "toolResult",
					toolCallId: "call-1",
					toolName: "loader",
					content: [{ type: "text", text: "loaded" }],
					isError: false,
					timestamp: 2,
					addedToolNames: ["late_tool", "late_tool"],
				},
				(name) => (name === "late_tool" ? tool : undefined),
			),
		).toEqual({ added: [tool], removed: [], addedNames: ["late_tool"] });
		expect(resolveMessageToolChange({ role: "system", content: "x", toolsRemoved: [tool], timestamp: 3 })).toEqual({
			added: [],
			removed: [tool],
			addedNames: [],
		});
	});
});

describe("tool placement", () => {
	test("keeps removed tools declared and orders the immediate set by name", () => {
		const context: Context = {
			messages: [
				{ role: "user", content: "hi", timestamp: 1 },
				{ role: "system", content: "bash withdrawn", toolsRemoved: [makeTool("bash")], timestamp: 2 },
			],
			tools: [makeTool("write"), makeTool("read")],
		};
		expect(declaredTools(context).map((tool) => tool.name)).toEqual(["bash", "read", "write"]);
	});

	test("prefers the definition recorded on the message over the live one", () => {
		const recorded = makeTool("late_tool", "recorded");
		const context: Context = {
			messages: [
				{ role: "user", content: "hi", timestamp: 1 },
				{ role: "system", content: "added", toolsAdded: [recorded], timestamp: 2 },
			],
			tools: [makeTool("late_tool", "live")],
		};
		const placement = splitDeferredTools(context, { toolResultMarkers: true, systemMarkers: true });
		expect(placement.immediate).toEqual([]);
		expect(placement.deferred.get("late_tool")?.description).toBe("recorded");
	});

	test("declares a system-added tool immediately when its marker cannot anchor", () => {
		const context: Context = {
			messages: [
				{ role: "user", content: "hi", timestamp: 1 },
				{ role: "system", content: "added", toolsAdded: [makeTool("late_tool")], timestamp: 2 },
			],
			tools: [makeTool("base_tool"), makeTool("late_tool")],
		};
		const placement = splitDeferredTools(context, { toolResultMarkers: true, systemMarkers: false });
		expect(placement.immediate.map((tool) => tool.name)).toEqual(["base_tool", "late_tool"]);
		expect(placement.deferred.size).toBe(0);
	});
});

describe("Anthropic mid-conversation system messages", () => {
	const lateTool = makeTool("late_tool");
	const removedTool = makeTool("edit");

	test("generates exact model and transport gates", () => {
		for (const id of ["claude-fable-5", "claude-fable-5-1", "claude-opus-4-8", "claude-opus-5"] as const) {
			expect(getModel("anthropic", id).compat).toMatchObject({
				supportsMidConvoSystemMessages: true,
				supportsMidConvoToolChanges: true,
			});
		}
		expect(getModel("anthropic", "claude-sonnet-5").compat?.supportsMidConvoSystemMessages).toBeUndefined();
		expect(
			getModel("openrouter", "anthropic/claude-fable-5.1").compat?.supportsMidConvoSystemMessages,
		).toBeUndefined();
	});

	test("sends native system messages with tool changes on supported models", async () => {
		const context: Context = {
			systemPrompt: "base",
			messages: [
				{ role: "user", content: "hello", timestamp: 1 },
				{
					role: "system",
					content: "Plan mode is on.",
					toolsAdded: [lateTool],
					toolsRemoved: [removedTool],
					timestamp: 2,
				},
			],
			tools: [makeTool("read"), lateTool],
		};
		const payload = await captureAnthropic(getModel("anthropic", "claude-fable-5-1"), context);

		expect(payload.betas).toContain("mid-conversation-tool-changes-2026-07-01");
		expect(payload.tools?.map((tool) => `${tool.name}${tool.defer_loading ? "(d)" : ""}`)).toEqual([
			"edit",
			"read",
			`${PLACEHOLDER}(d)`,
			"late_tool(d)",
		]);
		expect(contentRoles(payload)).toEqual(["user", "system"]);
		expect(payload.messages[1]?.content).toEqual([
			{ type: "text", text: "Plan mode is on." },
			{ type: "tool_removal", tool: { type: "tool_reference", name: "edit" } },
			{
				type: "tool_addition",
				tool: { type: "tool_reference", name: "late_tool" },
				cache_control: { type: "ephemeral" },
			},
		]);
	});

	test("keeps the beta set constant without tool changes", async () => {
		const context: Context = { systemPrompt: "base", messages: [{ role: "user", content: "hello", timestamp: 1 }] };
		const payload = await captureAnthropic(getModel("anthropic", "claude-fable-5-1"), context);
		expect(payload.betas).toContain("mid-conversation-tool-changes-2026-07-01");
	});

	test("renders misplaced system messages as user text and declares their tools immediately", async () => {
		const context: Context = {
			systemPrompt: "base",
			messages: [
				{ role: "user", content: "hello", timestamp: 1 },
				makeAssistant(),
				{ role: "system", content: "after assistant", toolsAdded: [lateTool], timestamp: 3 },
				{ role: "user", content: "next", timestamp: 4 },
			],
			tools: [makeTool("read"), lateTool],
		};
		const payload = await captureAnthropic(getModel("anthropic", "claude-fable-5-1"), context);

		expect(contentRoles(payload)).toEqual(["user", "assistant", "user", "user"]);
		expect(payload.messages[2]?.content).toEqual([
			{ type: "text", text: "<system_update>\nafter assistant\n</system_update>" },
		]);
		expect(payload.tools?.map((tool) => tool.name)).toEqual(["late_tool", "read", PLACEHOLDER]);
	});

	test("falls back to user text on models without native support", async () => {
		const context: Context = {
			systemPrompt: "base",
			messages: [
				{ role: "user", content: "hello", timestamp: 1 },
				{ role: "system", content: "changed", toolsRemoved: [removedTool], timestamp: 2 },
			],
			tools: [makeTool("read")],
		};
		const payload = await captureAnthropic(getModel("anthropic", "claude-opus-4-6"), context);

		expect(payload.betas ?? []).not.toContain("mid-conversation-tool-changes-2026-07-01");
		expect(contentRoles(payload)).toEqual(["user", "user"]);
		expect(payload.messages[1]?.content).toEqual([
			{ type: "text", text: "<system_update>\nchanged\n</system_update>", cache_control: { type: "ephemeral" } },
		]);
		expect(payload.tools?.map((tool) => tool.name)).toEqual(["edit", "read", PLACEHOLDER]);
	});

	test("never folds system messages into the top-level prompt or rewrites assistant turns", async () => {
		const assistant: AssistantMessage = {
			...makeAssistant(),
			content: [{ type: "thinking", thinking: "reasoning", thinkingSignature: "signed" }],
		};
		const context: Context = {
			systemPrompt: "old",
			messages: [
				{ role: "user", content: "hello", timestamp: 1 },
				assistant,
				{ role: "user", content: "again", timestamp: 3 },
				{ role: "system", content: "changed", timestamp: 4 },
			],
		};
		const payload = await captureAnthropic(getModel("anthropic", "claude-fable-5-1"), context);
		const system = (payload as { system?: Array<{ text: string }> }).system;

		expect(system?.map((block) => block.text)).toEqual(["old"]);
		expect(payload.messages[1]?.content).toEqual([{ type: "thinking", thinking: "reasoning", signature: "signed" }]);
		expect(contentRoles(payload)).toEqual(["user", "assistant", "user", "system"]);
	});
});

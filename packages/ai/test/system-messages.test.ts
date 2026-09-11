import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { getModel, streamSimple } from "../src/compat.ts";
import type { Api, AssistantMessage, Context, Model, Tool } from "../src/types.ts";
import { getTranscriptCapabilities, supportsMidConversationToolChanges } from "../src/utils/system-messages.ts";

const PLACEHOLDER = "__pi_deferred_tool_placeholder__";

function makeTool(name: string): Tool {
	return { name, description: `The ${name} tool`, parameters: Type.Object({}) };
}

function makeAssistant(stopReason: "stop" | "aborted" = "stop"): AssistantMessage {
	return {
		role: "assistant",
		content: stopReason === "aborted" ? [] : [{ type: "text", text: "ok" }],
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
		stopReason,
		timestamp: 3,
	};
}

interface Payload {
	betas?: string[];
	tools?: Array<{ name?: string; defer_loading?: boolean }>;
	instructions?: string;
	system?: Array<{ text?: string }>;
	input?: Array<{
		type?: string;
		role?: string;
		content?: unknown;
		tools?: Array<{ name?: string }>;
	}>;
	messages?: Array<{
		role: string;
		content: string | Array<{ type: string; text?: string; tool?: { name?: string } }>;
		output_config?: unknown;
	}>;
}

async function capture(model: Model<Api>, context: Context): Promise<Payload> {
	let captured: Payload | undefined;
	await streamSimple({ ...model, baseUrl: "http://127.0.0.1:9" }, context, {
		apiKey:
			model.api === "openai-codex-responses"
				? `header.${btoa(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "test" } }))}.signature`
				: "fake-key",
		onPayload(payload) {
			captured = payload as Payload;
			throw new Error("payload captured");
		},
	}).result();
	if (!captured) throw new Error("Expected payload capture");
	return captured;
}

function snapshots(payload: Payload): string[][] {
	return (payload.input ?? [])
		.filter((item) => item.type === "additional_tools")
		.map((item) => item.tools?.map((tool) => tool.name ?? "") ?? []);
}

function contentRoles(payload: Payload): string[] {
	return (payload.messages ?? [])
		.filter((message) => message.output_config === undefined)
		.map((message) => message.role);
}

describe("transcript system messages", () => {
	it("reports the native capability matrix", () => {
		const cases = [
			[getModel("openai", "gpt-5.4"), [true, true, true]],
			[{ ...getModel("openai", "gpt-5.4"), compat: { supportsToolSearch: true } }, [true, true, false]],
			[getModel("anthropic", "claude-fable-5-1"), [true, true, true]],
			[getModel("openai", "gpt-5.3-chat-latest"), [true, false, false]],
			[getModel("moonshotai", "kimi-k3"), [true, true, false]],
			[getModel("google", "gemini-2.5-flash"), [false, false, false]],
		] as const;
		for (const [model, expected] of cases) {
			const capabilities = getTranscriptCapabilities(model);
			expect([
				capabilities.midConversationSystemMessages,
				capabilities.midConversationToolAdditions,
				capabilities.midConversationToolRemovals,
			]).toEqual(expected);
			expect(supportsMidConversationToolChanges(model)).toBe(expected[1] && expected[2]);
		}
	});

	it("replays complete tool snapshots on Responses transports", async () => {
		const read = makeTool("read");
		const edit = makeTool("edit");
		const context: Context = {
			systemPrompt: "initial instructions",
			tools: [read],
			messages: [
				{ role: "system", content: "edit available", toolsAdded: [edit], timestamp: 1 },
				{ role: "user", content: "hello", timestamp: 2 },
				{ role: "system", content: "read unavailable", toolsRemoved: [read], timestamp: 3 },
				{ role: "system", content: "edit unavailable", toolsRemoved: [edit], timestamp: 4 },
				{ role: "system", content: "read available", toolsAdded: [read], timestamp: 5 },
			],
		};
		const models: Model<Api>[] = [
			getModel("openai", "gpt-5.4"),
			getModel("openai-codex", "gpt-5.6-sol"),
			{
				...getModel("openai", "gpt-5.4"),
				api: "azure-openai-responses",
				provider: "azure-openai-responses",
			} satisfies Model<"azure-openai-responses">,
		];

		for (const model of models) {
			const payload = await capture(model, context);
			expect(payload.tools).toBeUndefined();
			expect(snapshots(payload)).toEqual([["read"], ["edit", "read"], ["edit"], [], ["read"]]);
			expect(payload.input).toContainEqual(
				expect.objectContaining({ role: "developer", content: "edit available" }),
			);
			if (model.api === "openai-codex-responses") expect(payload.instructions).toBe("initial instructions");
			if (model.api === "openai-responses") {
				const prefix = await capture(model, { ...context, messages: context.messages.slice(0, 2) });
				expect(payload.input?.slice(0, prefix.input?.length)).toEqual(prefix.input);
			}
		}
	});

	it("sends native Anthropic instructions and availability changes", async () => {
		const read = makeTool("read");
		const edit = makeTool("edit");
		const late = makeTool("late");
		const payload = await capture(getModel("anthropic", "claude-fable-5-1"), {
			systemPrompt: "base",
			tools: [read, edit],
			messages: [
				{ role: "user", content: "hello", timestamp: 1 },
				{
					role: "system",
					content: "tools changed",
					toolsAdded: [late],
					toolsRemoved: [edit],
					timestamp: 2,
				},
			],
		});

		expect(payload.betas).toContain("mid-conversation-tool-changes-2026-07-01");
		expect(payload.tools?.map((tool) => `${tool.name}${tool.defer_loading ? "(d)" : ""}`)).toEqual([
			"read",
			"edit",
			"late",
			`${PLACEHOLDER}(d)`,
		]);
		expect(contentRoles(payload)).toEqual(["user", "system"]);
		expect(payload.messages?.[1]?.content).toEqual([
			{ type: "text", text: "tools changed" },
			{ type: "tool_removal", tool: { type: "tool_reference", name: "edit" } },
			{
				type: "tool_addition",
				tool: { type: "tool_reference", name: "late" },
				cache_control: { type: "ephemeral" },
			},
		]);
	});

	it("uses the append-only fallback without duplicating a leading instruction", async () => {
		const late = makeTool("late");
		const edit = makeTool("edit");
		const payload = await capture(getModel("anthropic", "claude-haiku-4-5"), {
			tools: [makeTool("read"), edit],
			messages: [
				{ role: "system", content: "initial", toolsAdded: [late], timestamp: 1 },
				{ role: "user", content: "hello", timestamp: 2 },
				{ role: "system", content: "edit unavailable", toolsRemoved: [edit], timestamp: 3 },
			],
		});

		expect(payload.system?.map((block) => block.text)).toEqual(["initial"]);
		expect(payload.tools?.map((tool) => tool.name)).toEqual(["edit", "late", "read"]);
		expect(contentRoles(payload)).toEqual(["user", "user"]);
		expect(payload.messages?.[1]?.content).toEqual([
			{
				type: "text",
				text: "<system_update>\nedit unavailable\n</system_update>",
				cache_control: { type: "ephemeral" },
			},
		]);
	});

	it("moves a native Anthropic system message past a dropped aborted turn", async () => {
		const payload = await capture(getModel("anthropic", "claude-fable-5-1"), {
			systemPrompt: "base",
			messages: [
				{ role: "user", content: "hello", timestamp: 1 },
				{ role: "system", content: "changed", timestamp: 2 },
				makeAssistant("aborted"),
				{ role: "user", content: "next", timestamp: 4 },
				makeAssistant(),
			],
		});

		expect(contentRoles(payload)).toEqual(["user", "user", "system", "assistant"]);
	});
});

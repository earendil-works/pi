import { describe, expect, it } from "vitest";
import { normalizeToolCallId } from "../src/providers/anthropic.js";
import { transformMessages } from "../src/providers/transform-messages.js";
import type { AssistantMessage, Message, Model, ToolResultMessage } from "../src/types.js";

/**
 * Anthropic rejects tool_use.id that does not match ^[a-zA-Z0-9_-]+$ (1+ chars,
 * max 64). normalizeToolCallId replaces disallowed characters and must also
 * produce a non-empty result: orphaned or failed cross-provider tool calls can
 * carry empty IDs in the stored transcript (e.g. after a provider returned an
 * error), and an empty sanitized string still fails Anthropic's regex.
 *
 * This is a regression test for sessions that mix Anthropic with providers
 * such as Moonshot/Kimi, where tool call IDs look like `functions.bash:17`
 * and occasionally `""` for failed/orphaned calls.
 */
describe("normalizeToolCallId", () => {
	it("replaces disallowed characters with underscores", () => {
		expect(normalizeToolCallId("functions.bash:17")).toBe("functions_bash_17");
		expect(normalizeToolCallId("a.b/c")).toBe("a_b_c");
	});

	it("passes through already-valid Anthropic ids unchanged", () => {
		expect(normalizeToolCallId("toolu_01V5J7hDMMGwRsAtL4S79whb")).toBe("toolu_01V5J7hDMMGwRsAtL4S79whb");
	});

	it("truncates to 64 characters", () => {
		const longId = "a".repeat(128);
		expect(normalizeToolCallId(longId)).toHaveLength(64);
	});

	it("returns a non-empty placeholder for empty input", () => {
		const result = normalizeToolCallId("");
		expect(result.length).toBeGreaterThan(0);
		expect(result).toMatch(/^[a-zA-Z0-9_-]+$/);
	});

	it("returns a non-empty placeholder when every character is disallowed and the input was empty after trimming", () => {
		// Only happens if the upstream produces an all-disallowed id, which
		// currently doesn't occur in practice, but the guarantee must still hold.
		const allBad = ".:/";
		expect(normalizeToolCallId(allBad)).toMatch(/^[a-zA-Z0-9_-]+$/);
	});
});

/**
 * End-to-end path via transformMessages: a session that started on Moonshot/Kimi
 * (tool call IDs like `functions.bash:17` and occasional empty ids) being
 * replayed against Anthropic must never emit tool_use.id / tool_use_id values
 * that violate Anthropic's pattern.
 */
describe("transformMessages + Anthropic normalizeToolCallId (Kimi -> Anthropic handoff)", () => {
	const anthropicModel: Model<"anthropic-messages"> = {
		id: "claude-opus-4-7",
		name: "Claude Opus 4.7",
		api: "anthropic-messages",
		provider: "anthropic",
		baseUrl: "https://api.anthropic.com",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200000,
		maxTokens: 64000,
	};

	function kimiAssistantMessage(content: AssistantMessage["content"]): AssistantMessage {
		return {
			role: "assistant",
			content,
			api: "openai-completions",
			provider: "nvidia",
			model: "moonshotai/kimi-k2.5",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "toolUse",
			timestamp: Date.now(),
		};
	}

	function kimiToolResult(toolCallId: string, text: string): ToolResultMessage {
		return {
			role: "toolResult",
			toolCallId,
			toolName: "bash",
			content: [{ type: "text", text }],
			isError: false,
			timestamp: Date.now(),
		};
	}

	function allToolIdsValid(messages: Message[]): { bad: string[] } {
		const bad: string[] = [];
		for (const msg of messages) {
			if (msg.role === "assistant" && Array.isArray(msg.content)) {
				for (const block of msg.content) {
					if (block.type === "toolCall" && !/^[a-zA-Z0-9_-]+$/.test(block.id)) {
						bad.push(`tool_use.id=${JSON.stringify(block.id)}`);
					}
				}
			}
			if (msg.role === "toolResult" && !/^[a-zA-Z0-9_-]+$/.test(msg.toolCallId)) {
				bad.push(`tool_use_id=${JSON.stringify(msg.toolCallId)}`);
			}
		}
		return { bad };
	}

	it("rewrites Moonshot-style IDs so tool_use.id matches Anthropic's regex", () => {
		const messages: Message[] = [
			{ role: "user", content: "list files", timestamp: Date.now() },
			kimiAssistantMessage([
				{ type: "toolCall", id: "functions.bash:17", name: "bash", arguments: { command: "ls" } },
			]),
			kimiToolResult("functions.bash:17", "README.md\n"),
		];

		const out = transformMessages(messages, anthropicModel, normalizeToolCallId);
		const { bad } = allToolIdsValid(out);
		expect(bad).toEqual([]);

		const assistant = out.find((m) => m.role === "assistant") as AssistantMessage;
		const toolCall = assistant.content.find((b) => b.type === "toolCall");
		const toolResult = out.find((m) => m.role === "toolResult") as ToolResultMessage;

		// Both sides of the pair must use the same normalized id.
		expect(toolCall && toolCall.type === "toolCall" ? toolCall.id : null).toBe("functions_bash_17");
		expect(toolResult.toolCallId).toBe("functions_bash_17");
	});

	it("handles empty tool-call ids (orphaned/failed cross-provider calls)", () => {
		// Sessions with mid-run provider failures can store toolCall { id: "" }
		// paired with toolResult { toolCallId: "", isError: true }.
		const messages: Message[] = [
			{ role: "user", content: "do something", timestamp: Date.now() },
			kimiAssistantMessage([{ type: "toolCall", id: "", name: "", arguments: {} }]),
			{
				role: "toolResult",
				toolCallId: "",
				toolName: "",
				content: [{ type: "text", text: "Tool not found" }],
				isError: true,
				timestamp: Date.now(),
			},
		];

		const out = transformMessages(messages, anthropicModel, normalizeToolCallId);
		const { bad } = allToolIdsValid(out);
		expect(bad).toEqual([]);

		const assistant = out.find((m) => m.role === "assistant") as AssistantMessage;
		const toolCall = assistant.content.find((b) => b.type === "toolCall");
		const toolResult = out.find((m) => m.role === "toolResult") as ToolResultMessage;

		// The pair must still match after normalization.
		const normalizedId = toolCall && toolCall.type === "toolCall" ? toolCall.id : null;
		expect(normalizedId).toBeTruthy();
		expect(normalizedId).toBe(toolResult.toolCallId);
	});
});

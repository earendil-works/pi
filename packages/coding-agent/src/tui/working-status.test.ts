import type { AssistantMessage } from "@kennyfrc/mu-ai";
import { describe, expect, it } from "vitest";
import { estimateWorkingStatusTokens, formatDoneStatus, formatWorkingStatus } from "./working-status.js";

function baseAssistantMessage(): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: "openai-completions",
		provider: "openai",
		model: "test-model",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

describe("working-status", () => {
	it("formats the initial label with 0 tps", () => {
		expect(formatWorkingStatus(0, 0)).toBe("Working (0s • 0 tps • esc to interrupt)");
	});

	it("formats elapsed time and rounded tps", () => {
		expect(formatWorkingStatus(88_000, 2_112)).toBe("Working (1m 28s • 24 tps • esc to interrupt)");
	});

	it("formats the done label with elapsed time and rounded tps", () => {
		expect(formatDoneStatus(88_000, 2_112)).toBe("Done after 1m 28s - 24 tps");
	});

	it("formats the working label with average latency", () => {
		expect(formatWorkingStatus(28_000, 1_176, 3_800)).toBe(
			"Working (28s • 42 tps • 3.8s avg lat • esc to interrupt)",
		);
	});

	it("formats the done label with average latency", () => {
		expect(formatDoneStatus(28_000, 1_176, 3_800)).toBe("Done after 28s - 42 tps - 3.8s avg lat");
	});

	it("estimates tokens from visible assistant text, thinking, and tool calls", () => {
		const message: AssistantMessage = {
			...baseAssistantMessage(),
			content: [
				{ type: "thinking", thinking: "plan" },
				{ type: "text", text: "hello world" },
				{ type: "toolCall", id: "call_1", name: "bash", arguments: { command: "echo hi" } },
			],
		};

		expect(estimateWorkingStatusTokens(message)).toBeGreaterThan(0);
		expect(estimateWorkingStatusTokens(message)).toBeGreaterThan(
			estimateWorkingStatusTokens({ ...message, content: message.content.slice(0, 2) }),
		);
	});
});

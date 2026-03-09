import type { AssistantMessage } from "@kennyfrc/mu-ai";
import { describe, expect, it } from "vitest";
import {
	estimateWorkingStatusTokens,
	formatDoneStatus,
	formatWorkingStatus,
	getWorkingStatusSpinnerFrame,
} from "./working-status.js";

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
		expect(formatWorkingStatus(0, 0)).toBe("Working (0s • 0 tps • esc→stop)");
	});

	it("formats elapsed time and rounded tps", () => {
		expect(formatWorkingStatus(88_000, 2_112)).toBe("Working (1m 28s • 24 tps • esc→stop)");
	});

	it("uses subsecond elapsed time for working tps", () => {
		expect(formatWorkingStatus(500, 10)).toBe("Working (0s • 20 tps • esc→stop)");
		expect(formatWorkingStatus(1_500, 10)).toBe("Working (1s • 7 tps • esc→stop)");
	});

	it("formats the done label with elapsed time and rounded tps", () => {
		expect(formatDoneStatus(88_000, 2_112)).toBe("Done after 1m 28s - 24 tps");
	});

	it("uses subsecond elapsed time for done tps", () => {
		expect(formatDoneStatus(250, 25)).toBe("Done after 0s - 100 tps");
	});

	it("formats the working label with average latency", () => {
		expect(formatWorkingStatus(28_000, 1_176, 3_800)).toBe("Working (28s • 42 tps • 3.8s lat. • esc→stop)");
	});

	it("formats the done label with average latency", () => {
		expect(formatDoneStatus(28_000, 1_176, 3_800)).toBe("Done after 28s - 42 tps - 3.8s lat.");
	});

	it("keeps working elapsed time independent from TPS elapsed time", () => {
		expect(formatWorkingStatus(5_000, 40, undefined, 2_000)).toBe("Working (5s • 20 tps • esc→stop)");
	});

	it("keeps done elapsed time independent from TPS elapsed time", () => {
		expect(formatDoneStatus(5_000, 40, undefined, 2_000)).toBe("Done after 5s - 20 tps");
	});

	it("derives spinner frames from wall-clock time instead of update frequency", () => {
		expect(getWorkingStatusSpinnerFrame(0)).toBe("░▒▓█   ");
		expect(getWorkingStatusSpinnerFrame(119)).toBe("░▒▓█   ");
		expect(getWorkingStatusSpinnerFrame(120)).toBe(" ░▒▓█  ");
		expect(getWorkingStatusSpinnerFrame(240)).toBe("  ░▒▓█ ");
		expect(getWorkingStatusSpinnerFrame(480)).toBe("   █▓▒░");
	});

	it("estimates tokens from visible assistant text and tool calls, excluding thinking", () => {
		const message: AssistantMessage = {
			...baseAssistantMessage(),
			content: [
				{ type: "thinking", thinking: "plan" },
				{ type: "text", text: "hello world" },
				{ type: "toolCall", id: "call_1", name: "bash", arguments: { command: "echo hi" } },
			],
		};

		expect(estimateWorkingStatusTokens(message)).toBeGreaterThan(0);
		expect(estimateWorkingStatusTokens(message)).toBe(
			estimateWorkingStatusTokens({
				...message,
				content: message.content.filter((content) => content.type !== "thinking"),
			}),
		);
	});

	it("ignores thinking blocks when estimating live TPS tokens", () => {
		const thinkingOnlyMessage: AssistantMessage = {
			...baseAssistantMessage(),
			content: [{ type: "thinking", thinking: "internal summary that should not affect tps" }],
		};

		expect(estimateWorkingStatusTokens(thinkingOnlyMessage)).toBe(0);
	});
});

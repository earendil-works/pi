// Verification: Context usage calculation matches footer
import { describe, expect, it } from "vitest";

// Test the calculation logic directly (same as in TuiRenderer.getContextUsage)
function calculateContextUsage(messages: any[], contextWindow: number) {
	const lastAssistantMessage = messages
		.slice()
		.reverse()
		.find((m) => m.role === "assistant" && m.stopReason !== "aborted");

	const contextTokens = lastAssistantMessage
		? lastAssistantMessage.usage.input +
			lastAssistantMessage.usage.output +
			lastAssistantMessage.usage.cacheRead +
			lastAssistantMessage.usage.cacheWrite
		: 0;

	const ratio = contextWindow > 0 ? contextTokens / contextWindow : 0;

	return { contextTokens, contextWindow, ratio };
}

describe("Context Usage Calculation", () => {
	it("should calculate ratio correctly at various thresholds", () => {
		const contextWindow = 200000;

		// 50% usage
		const messages50 = [
			{
				role: "assistant",
				stopReason: "stop",
				usage: { input: 80000, output: 15000, cacheRead: 5000, cacheWrite: 0 },
			},
		];
		const result50 = calculateContextUsage(messages50, contextWindow);
		expect(result50.contextTokens).toBe(100000);
		expect(result50.ratio).toBe(0.5);

		// 95% usage (threshold)
		const messages95 = [
			{
				role: "assistant",
				stopReason: "stop",
				usage: { input: 150000, output: 30000, cacheRead: 10000, cacheWrite: 0 },
			},
		];
		const result95 = calculateContextUsage(messages95, contextWindow);
		expect(result95.contextTokens).toBe(190000);
		expect(result95.ratio).toBe(0.95);

		// Above 95%
		const messagesAbove = [
			{
				role: "assistant",
				stopReason: "stop",
				usage: { input: 160000, output: 35000, cacheRead: 5000, cacheWrite: 0 },
			},
		];
		const resultAbove = calculateContextUsage(messagesAbove, contextWindow);
		expect(resultAbove.ratio).toBeGreaterThan(0.95);
	});

	it("should skip aborted messages", () => {
		const contextWindow = 200000;
		const messages = [
			{
				role: "assistant",
				stopReason: "stop",
				usage: { input: 50000, output: 10000, cacheRead: 0, cacheWrite: 0 },
			},
			{
				role: "assistant",
				stopReason: "aborted", // This should be skipped
				usage: { input: 190000, output: 10000, cacheRead: 0, cacheWrite: 0 },
			},
		];

		const result = calculateContextUsage(messages, contextWindow);
		// Should use the first (non-aborted) message
		expect(result.contextTokens).toBe(60000);
		expect(result.ratio).toBe(0.3);
	});

	it("should return 0 ratio when no assistant messages", () => {
		const result = calculateContextUsage([], 200000);
		expect(result.ratio).toBe(0);
	});

	it("should handle zero context window", () => {
		const messages = [
			{
				role: "assistant",
				stopReason: "stop",
				usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0 },
			},
		];

		const result = calculateContextUsage(messages, 0);
		expect(result.ratio).toBe(0);
	});
});

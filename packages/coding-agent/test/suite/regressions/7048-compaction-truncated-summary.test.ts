import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, Model, Usage } from "@earendil-works/pi-ai";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { generateSummary, generateSummaryWithUsage } from "../../../src/core/compaction/index.ts";

// Regression for earendil-works/pi#7048:
// When summarization hits the token cap the provider returns stopReason "length"
// with a partial summary. Previously only stopReason "error" was checked, so the
// truncated text was persisted as the compaction checkpoint. It must fail loudly.

const { completeSimpleMock } = vi.hoisted(() => ({
	completeSimpleMock: vi.fn(),
}));

vi.mock("@earendil-works/pi-ai/compat", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@earendil-works/pi-ai/compat")>();
	return {
		...actual,
		completeSimple: completeSimpleMock,
	};
});

function createModel(maxTokens = 8192): Model<"anthropic-messages"> {
	return {
		id: "test-model",
		name: "Test Model",
		api: "anthropic-messages",
		provider: "anthropic",
		baseUrl: "https://api.anthropic.com",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200000,
		maxTokens,
	};
}

function createUsage(): Usage {
	return {
		input: 10,
		output: 10,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 20,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function summaryResponse(stopReason: AssistantMessage["stopReason"], text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		usage: createUsage(),
		stopReason,
		timestamp: Date.now(),
	};
}

const messages: AgentMessage[] = [{ role: "user", content: "Summarize this.", timestamp: Date.now() }];

describe("compaction summary truncation (#7048)", () => {
	beforeEach(() => {
		completeSimpleMock.mockReset();
	});

	it("throws when the summary was truncated at the token cap (stopReason length)", async () => {
		completeSimpleMock.mockResolvedValue(summaryResponse("length", "...you went fro"));

		await expect(generateSummaryWithUsage(messages, createModel(), 2000, "test-key")).rejects.toThrow(
			/token cap/,
		);
	});

	it("propagates the truncation failure through generateSummary", async () => {
		completeSimpleMock.mockResolvedValue(summaryResponse("length", "partial"));

		await expect(generateSummary(messages, createModel(), 2000, "test-key")).rejects.toThrow(
			/Summarization failed/,
		);
	});

	it("still returns a complete summary when generation stops normally", async () => {
		completeSimpleMock.mockResolvedValue(summaryResponse("stop", "## Goal\nComplete summary"));

		await expect(generateSummary(messages, createModel(), 2000, "test-key")).resolves.toBe(
			"## Goal\nComplete summary",
		);
	});

	it("still throws on an error stop reason", async () => {
		completeSimpleMock.mockResolvedValue({
			...summaryResponse("error", ""),
			errorMessage: "boom",
		});

		await expect(generateSummaryWithUsage(messages, createModel(), 2000, "test-key")).rejects.toThrow(
			/boom/,
		);
	});
});

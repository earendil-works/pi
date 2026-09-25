/**
 * Tests for plus/src/extensions/subagent/format.ts — output extraction,
 * failure detection, truncation, and usage formatting. Pure functions only.
 */

import assert from "node:assert/strict";
import type { Message } from "@earendil-works/pi-ai";
import { describe, it } from "vitest";
import {
	emptyUsage,
	formatTokens,
	formatUsageStats,
	getDisplayItems,
	getFinalOutput,
	getResultOutput,
	isFailedResult,
	type SubagentResult,
	truncateOutput,
} from "../../src/extensions/subagent/format.ts";

function assistantMessage(text: string, extra: Partial<Extract<Message, { role: "assistant" }>> = {}): Message {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-faux",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "end",
		timestamp: 0,
		...extra,
	} as Message;
}

function makeResult(overrides: Partial<SubagentResult> = {}): SubagentResult {
	return {
		agent: "worker",
		agentSource: "builtin",
		task: "do things",
		exitCode: 0,
		messages: [],
		stderr: "",
		usage: emptyUsage(),
		...overrides,
	};
}

describe("formatTokens", () => {
	it("formats token counts", () => {
		assert.equal(formatTokens(500), "500");
		assert.equal(formatTokens(1500), "1.5k");
		assert.equal(formatTokens(12345), "12k");
		assert.equal(formatTokens(2_500_000), "2.5M");
	});
});

describe("formatUsageStats", () => {
	it("joins all present parts", () => {
		const text = formatUsageStats(
			{ input: 1000, output: 500, cacheRead: 2000, cacheWrite: 0, cost: 0.0123, contextTokens: 3000, turns: 2 },
			"anthropic/claude-faux",
		);
		assert.equal(text, "2 turns ↑1.0k ↓500 R2.0k $0.0123 ctx:3.0k anthropic/claude-faux");
	});

	it("omits zero parts", () => {
		assert.equal(formatUsageStats({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 }), "");
	});
});

describe("getFinalOutput / getDisplayItems", () => {
	it("returns the last assistant text", () => {
		const messages = [assistantMessage("first"), assistantMessage("second")];
		assert.equal(getFinalOutput(messages), "second");
	});

	it("returns empty string when there is no assistant text", () => {
		assert.equal(getFinalOutput([]), "");
	});

	it("collects text and toolCall display items in order", () => {
		const msg = assistantMessage("thinking", {
			content: [
				{ type: "text", text: "planning" },
				{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "a.ts" } },
			],
		} as Partial<Extract<Message, { role: "assistant" }>>);
		const items = getDisplayItems([msg]);
		assert.deepEqual(items, [
			{ type: "text", text: "planning" },
			{ type: "toolCall", name: "read", args: { path: "a.ts" } },
		]);
	});
});

describe("isFailedResult / getResultOutput", () => {
	it("fails on non-zero exit code", () => {
		assert.equal(isFailedResult(makeResult({ exitCode: 1 })), true);
	});

	it("fails on error/aborted stop reasons", () => {
		assert.equal(isFailedResult(makeResult({ stopReason: "error" })), true);
		assert.equal(isFailedResult(makeResult({ stopReason: "aborted" })), true);
		assert.equal(isFailedResult(makeResult({ stopReason: "end" })), false);
	});

	it("prefers errorMessage, then stderr, then final output", () => {
		assert.equal(getResultOutput(makeResult({ exitCode: 1, errorMessage: "boom", stderr: "err" })), "boom");
		assert.equal(getResultOutput(makeResult({ exitCode: 1, stderr: "err" })), "err");
		assert.equal(getResultOutput(makeResult({ exitCode: 1, messages: [assistantMessage("partial")] })), "partial");
		assert.equal(getResultOutput(makeResult({ exitCode: 1 })), "(no output)");
	});

	it("successful results return the final output", () => {
		assert.equal(getResultOutput(makeResult({ messages: [assistantMessage("done!")] })), "done!");
		assert.equal(getResultOutput(makeResult()), "(no output)");
	});
});

describe("truncateOutput", () => {
	it("passes through short output", () => {
		assert.equal(truncateOutput("hello", 10), "hello");
	});

	it("truncates by byte length and reports the omitted amount", () => {
		const big = "x".repeat(100);
		const out = truncateOutput(big, 50);
		assert.equal(out.startsWith("x".repeat(50)), true);
		assert.match(out, /Output truncated: 50 bytes omitted/);
	});

	it("counts multi-byte characters", () => {
		const out = truncateOutput("é".repeat(100), 50);
		// 50 bytes = 25 é characters
		assert.equal(out.startsWith("é".repeat(25)), true);
	});
});

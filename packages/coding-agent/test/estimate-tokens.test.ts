import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { describe, expect, it } from "vitest";
import { estimateTokens } from "../src/core/compaction/index.js";

describe("estimateTokens", () => {
	it("handles user message with string content", () => {
		const msg = { role: "user", content: "hello world", timestamp: Date.now() } as AgentMessage;
		expect(estimateTokens(msg)).toBeGreaterThan(0);
	});

	it("handles user message with array content", () => {
		const msg = { role: "user", content: [{ type: "text", text: "hello" }], timestamp: Date.now() } as AgentMessage;
		expect(estimateTokens(msg)).toBeGreaterThan(0);
	});

	it("handles user message with null content without throwing", () => {
		const msg = { role: "user", content: null, timestamp: Date.now() } as unknown as AgentMessage;
		expect(() => estimateTokens(msg)).not.toThrow();
		expect(estimateTokens(msg)).toBe(0);
	});

	it("handles user message with undefined content without throwing", () => {
		const msg = { role: "user", content: undefined, timestamp: Date.now() } as unknown as AgentMessage;
		expect(() => estimateTokens(msg)).not.toThrow();
		expect(estimateTokens(msg)).toBe(0);
	});

	it("handles assistant message with null content without throwing", () => {
		const msg = { role: "assistant", content: null, usage: {}, stopReason: "end" } as unknown as AgentMessage;
		expect(() => estimateTokens(msg)).not.toThrow();
		expect(estimateTokens(msg)).toBe(0);
	});

	it("handles assistant message with undefined content without throwing", () => {
		const msg = { role: "assistant", content: undefined, usage: {}, stopReason: "end" } as unknown as AgentMessage;
		expect(() => estimateTokens(msg)).not.toThrow();
		expect(estimateTokens(msg)).toBe(0);
	});

	it("handles assistant message with valid content", () => {
		const msg = {
			role: "assistant",
			content: [{ type: "text", text: "hello world" }],
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: { input: 0, output: 0, total: 0 } },
			stopReason: "end",
		} as unknown as AgentMessage;
		expect(estimateTokens(msg)).toBeGreaterThan(0);
	});

	it("handles toolResult with null content without throwing", () => {
		const msg = { role: "toolResult", content: null, toolCallId: "1" } as unknown as AgentMessage;
		expect(() => estimateTokens(msg)).not.toThrow();
		expect(estimateTokens(msg)).toBe(0);
	});

	it("handles toolResult with undefined content without throwing", () => {
		const msg = { role: "toolResult", content: undefined, toolCallId: "1" } as unknown as AgentMessage;
		expect(() => estimateTokens(msg)).not.toThrow();
		expect(estimateTokens(msg)).toBe(0);
	});

	it("handles toolResult with string content", () => {
		const msg = { role: "toolResult", content: "result text", toolCallId: "1" } as unknown as AgentMessage;
		expect(estimateTokens(msg)).toBeGreaterThan(0);
	});

	it("handles toolResult with array content", () => {
		const msg = {
			role: "toolResult",
			content: [{ type: "text", text: "result" }],
			toolCallId: "1",
		} as unknown as AgentMessage;
		expect(estimateTokens(msg)).toBeGreaterThan(0);
	});

	it("handles custom message with null content without throwing", () => {
		const msg = { role: "custom", content: null } as unknown as AgentMessage;
		expect(() => estimateTokens(msg)).not.toThrow();
		expect(estimateTokens(msg)).toBe(0);
	});
});

import type { AssistantMessage, AssistantMessageEvent } from "@kennyfrc/mu-ai";
import stripAnsi from "strip-ansi";
import { describe, expect, it } from "vitest";
import { initTheme } from "../theme/theme.js";
import { StreamingAssistantMessageComponent } from "./streaming-assistant-message.js";

const baseAssistantMessage = (): AssistantMessage => ({
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
});

const textDelta = (delta: string): AssistantMessageEvent => ({
	type: "text_delta",
	contentIndex: 0,
	delta,
	partial: baseAssistantMessage(),
});

const thinkingDelta = (delta: string): AssistantMessageEvent => ({
	type: "thinking_delta",
	contentIndex: 0,
	delta,
	partial: baseAssistantMessage(),
});

function countOccurrences(haystack: string, needle: string): number {
	if (!needle) return 0;
	return haystack.split(needle).length - 1;
}

describe("StreamingAssistantMessageComponent", () => {
	initTheme("dark");

	it("keeps a bounded rolling buffer while streaming", () => {
		const c = new StreamingAssistantMessageComponent({ maxBufferChars: 20 });
		c.applyAssistantMessageEvent(textDelta("1234567890"));
		c.applyAssistantMessageEvent(textDelta("abcdefghij"));
		c.applyAssistantMessageEvent(textDelta("K"));

		const rendered = stripAnsi(c.render(80).join("\n")).trim();
		// We should keep only the last 20 characters.
		expect(rendered).toContain("4567890abcdefghijK");
		expect(rendered).not.toContain("123");
	});

	it("finalize swaps to full Markdown rendering", () => {
		const c = new StreamingAssistantMessageComponent({ maxBufferChars: 20 });
		c.applyAssistantMessageEvent(textDelta("hello "));

		const finalMsg: AssistantMessage = {
			...baseAssistantMessage(),
			content: [{ type: "text", text: "Hello **world**" }],
		};

		c.finalize(finalMsg);

		const rendered = stripAnsi(c.render(80).join("\n")).trim();
		expect(rendered).toContain("Hello");
		expect(rendered).toContain("world");
	});

	it("does not spill duplicated thinking prefix into the response while streaming", () => {
		const c = new StreamingAssistantMessageComponent({ maxBufferChars: 10_000 });
		c.applyAssistantMessageEvent(thinkingDelta("THINKING_TRACE"));
		c.applyAssistantMessageEvent(textDelta("THINKING_TRACE\n\nANSWER"));

		const rendered = stripAnsi(c.render(200).join("\n"));
		expect(countOccurrences(rendered, "THINKING_TRACE")).toBe(1);
		expect(rendered).toContain("ANSWER");
	});

	it("renders markdown while streaming (hr token)", () => {
		const c = new StreamingAssistantMessageComponent({ maxBufferChars: 10_000 });
		c.applyAssistantMessageEvent(textDelta("---\n"));

		const rendered = stripAnsi(c.render(80).join("\n"));
		expect(rendered).toContain("─");
		expect(rendered).not.toContain("---");
	});
});

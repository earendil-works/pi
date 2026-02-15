import type { AssistantMessage } from "@kennyfrc/mu-ai";
import stripAnsi from "strip-ansi";
import { describe, expect, it } from "vitest";
import { initTheme } from "../theme/theme.js";
import { AssistantMessageComponent } from "./assistant-message.js";

initTheme("dark");

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

function countOccurrences(haystack: string, needle: string): number {
	if (!needle) return 0;
	return haystack.split(needle).length - 1;
}

describe("AssistantMessageComponent (thinking spill guard)", () => {
	it("does not render duplicated thinking prefix inside the response", () => {
		const msg: AssistantMessage = {
			...baseAssistantMessage(),
			content: [
				{ type: "thinking", thinking: "THINKINGTRACE" },
				{ type: "text", text: "THINKINGTRACE\n\nANSWER" },
			],
		};

		const c = new AssistantMessageComponent(msg);
		const rendered = stripAnsi(c.render(200).join("\n"));

		expect(countOccurrences(rendered, "THINKINGTRACE")).toBe(1);
		expect(rendered).toContain("ANSWER");
	});

	it("handles spill even when the final message block order is text → thinking (suffix case)", () => {
		const msg: AssistantMessage = {
			...baseAssistantMessage(),
			content: [
				{ type: "text", text: "ANSWER\n\nTHINKINGTRACE" },
				{ type: "thinking", thinking: "THINKINGTRACE" },
			],
		};

		const c = new AssistantMessageComponent(msg);
		const rendered = stripAnsi(c.render(200).join("\n"));

		expect(countOccurrences(rendered, "THINKINGTRACE")).toBe(1);
		expect(rendered).toContain("ANSWER");
	});

	it("renders exact duplicates only once (keep response, drop thinking)", () => {
		const msg: AssistantMessage = {
			...baseAssistantMessage(),
			content: [
				{ type: "thinking", thinking: "DUP" },
				{ type: "text", text: "DUP" },
			],
		};

		const c = new AssistantMessageComponent(msg);
		const rendered = stripAnsi(c.render(200).join("\n"));
		expect(countOccurrences(rendered, "DUP")).toBe(1);
	});
});

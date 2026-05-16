import type { AssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, test } from "vitest";
import { setScreenReaderMode } from "../src/modes/interactive/accessibility.js";
import { AssistantMessageComponent } from "../src/modes/interactive/components/assistant-message.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";

const OSC133_ZONE_START = "\x1b]133;A\x07";
const OSC133_ZONE_END = "\x1b]133;B\x07";
const OSC133_ZONE_FINAL = "\x1b]133;C\x07";

function createAssistantMessage(content: AssistantMessage["content"]): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "openai-responses",
		provider: "openai",
		model: "gpt-4o-mini",
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

describe("AssistantMessageComponent", () => {
	afterEach(() => {
		setScreenReaderMode(undefined);
	});

	test("adds OSC 133 zone markers to assistant messages without tool calls", () => {
		initTheme("dark");

		const component = new AssistantMessageComponent(createAssistantMessage([{ type: "text", text: "hello" }]));
		const lines = component.render(40);

		expect(lines).not.toHaveLength(0);
		expect(lines[0]).toContain(OSC133_ZONE_START);
		expect(lines[lines.length - 1].startsWith(OSC133_ZONE_END + OSC133_ZONE_FINAL)).toBe(true);
	});

	test("does not add OSC 133 zone markers when assistant message contains tool calls", () => {
		initTheme("dark");

		const component = new AssistantMessageComponent(
			createAssistantMessage([
				{ type: "text", text: "calling tool" },
				{ type: "toolCall", id: "tool-1", name: "read", arguments: { path: "file.txt" } },
			]),
		);
		const rendered = component.render(60).join("\n");

		expect(rendered.includes(OSC133_ZONE_START)).toBe(false);
		expect(rendered.includes(OSC133_ZONE_END)).toBe(false);
		expect(rendered.includes(OSC133_ZONE_FINAL)).toBe(false);
	});

	test("trims leading and trailing whitespace in screen reader mode", () => {
		initTheme("dark");
		setScreenReaderMode("flat");

		const lines = new AssistantMessageComponent(
			createAssistantMessage([{ type: "text", text: "\n  hello  \n" }]),
		).render(20);

		expect(lines).toEqual([`${OSC133_ZONE_END}${OSC133_ZONE_FINAL}${OSC133_ZONE_START}Assistant: hello`]);
	});

	test("does not trim middle response lines in screen reader mode", () => {
		initTheme("dark");
		setScreenReaderMode("flat");

		const lines = new AssistantMessageComponent(
			createAssistantMessage([{ type: "text", text: "one two three four five six seven eight nine ten" }]),
		).render(20);

		expect(lines).toEqual([
			`${OSC133_ZONE_START}Assistant: one two three four `,
			" five six seven     ",
			`${OSC133_ZONE_END}${OSC133_ZONE_FINAL} eight nine ten`,
		]);
	});
});

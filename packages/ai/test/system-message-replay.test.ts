import { Type } from "typebox";
import { describe, expect, test } from "vitest";
import type { Tool, TranscriptContext } from "../src/types.ts";
import {
	collapseSystemMessages,
	getCurrentSystemMessage,
	getCurrentSystemPrompt,
	normalizeContext,
} from "../src/utils/normalize-context.ts";
import { getSystemMessageText, renderSystemMessageUpdate } from "../src/utils/text.ts";
import { getToolStateChanges, hasNonAdditiveToolChanges } from "../src/utils/transcript-state.ts";

function tool(name: string, description = `${name} tool`): Tool {
	return { name, description, parameters: Type.Object({}) };
}

const transcript = normalizeContext({
	messages: [
		{
			role: "system",
			content: "base",
			sections: { a: "<a>1</a>", b: "<b>1</b>" },
			toolsAdded: [tool("first")],
			timestamp: 10,
		},
		{ role: "user", content: "hello", timestamp: 11 },
		{ role: "system", content: "also do this", timestamp: 12 },
		{ role: "assistant", content: [{ type: "text", text: "ok" }], timestamp: 13 } as never,
		{
			role: "system",
			content: "",
			sections: { a: "<a>2</a>", b: null, c: "<c>1</c>" },
			toolsRemoved: [{ name: "first" }],
			toolsAdded: [tool("second")],
			timestamp: 14,
		},
	],
});

describe("system message replay", () => {
	test("replays content, sections, and tools into one leading message", () => {
		const current = getCurrentSystemMessage(transcript);
		expect(current).toEqual({
			role: "system",
			content: "base\n\nalso do this",
			sections: { a: "<a>2</a>", c: "<c>1</c>" },
			toolsAdded: [tool("second")],
			timestamp: 10,
		});
		expect(getCurrentSystemPrompt(transcript)).toBe("base\n\nalso do this\n\n<a>2</a>\n\n<c>1</c>");
	});

	test("collapse keeps only non-system messages after the replayed head", () => {
		const collapsed = collapseSystemMessages(transcript);
		expect(collapsed.messages.map((message) => message.role)).toEqual(["system", "user", "assistant"]);
		expect(collapseSystemMessages(collapsed)).toEqual(collapsed);
	});

	test("replay of a transcript without system messages is empty", () => {
		const context = normalizeContext({ messages: [{ role: "user", content: "hi", timestamp: 1 }] });
		expect(getCurrentSystemMessage(context)).toBeUndefined();
		expect(getCurrentSystemPrompt(context)).toBe("");
		expect(collapseSystemMessages(context).messages).toEqual(context.messages);
	});

	test("a late full patch on a transcript without a leading message replays as the prompt", () => {
		const context: TranscriptContext = normalizeContext({
			messages: [
				{ role: "user", content: "old session", timestamp: 1 },
				{
					role: "system",
					content: "",
					sections: { preamble: "You are pi." },
					toolsAdded: [tool("x")],
					timestamp: 2,
				},
			],
		});
		expect(getCurrentSystemPrompt(context)).toBe("You are pi.");
		expect(collapseSystemMessages(context).messages[0]).toMatchObject({ role: "system", toolsAdded: [tool("x")] });
	});

	test("renders complete prompts and framed updates", () => {
		const leading = transcript.messages[0];
		const update = transcript.messages[4];
		if (leading?.role !== "system" || update?.role !== "system") throw new Error("expected system messages");
		expect(getSystemMessageText(leading)).toBe("base\n\n<a>1</a>\n\n<b>1</b>");
		expect(renderSystemMessageUpdate(update)).toBe(
			[
				'Updated system prompt section "a":\n\n<a>2</a>',
				'Removed system prompt section "b".',
				'Updated system prompt section "c":\n\n<c>1</c>',
			].join("\n\n"),
		);
	});

	test("tool state changes treat changed definitions as removal plus addition", () => {
		const changes = getToolStateChanges([tool("a"), tool("b")], [tool("b", "changed"), tool("c")]);
		expect(changes).toEqual({
			toolsAdded: [tool("b", "changed"), tool("c")],
			toolsRemoved: [{ name: "a" }, { name: "b" }],
		});
		expect(getToolStateChanges([tool("a")], [tool("a")])).toEqual({ toolsAdded: [], toolsRemoved: [] });
	});

	test("detects non-additive tool history", () => {
		expect(hasNonAdditiveToolChanges(transcript)).toBe(true);
		const additive = normalizeContext({
			messages: [
				{ role: "system", content: "", toolsAdded: [tool("a")], timestamp: 1 },
				{ role: "system", content: "", toolsAdded: [tool("b")], timestamp: 2 },
			],
		});
		expect(hasNonAdditiveToolChanges(additive)).toBe(false);
		const redeclared = normalizeContext({
			messages: [
				{ role: "system", content: "", toolsAdded: [tool("a")], timestamp: 1 },
				{ role: "system", content: "", toolsAdded: [tool("a", "changed")], timestamp: 2 },
			],
		});
		expect(hasNonAdditiveToolChanges(redeclared)).toBe(true);
	});
});

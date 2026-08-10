import { describe, expect, test } from "vitest";
import type { MarkdownTransformContext } from "../src/core/extensions/types.ts";
import { UserMessageComponent } from "../src/modes/interactive/components/user-message.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

const OSC133_ZONE_START = "\x1b]133;A\x07";
const OSC133_ZONE_END = "\x1b]133;B\x07";
const OSC133_ZONE_FINAL = "\x1b]133;C\x07";
const BG_RESET = "\x1b[49m";

describe("UserMessageComponent", () => {
	test("keeps user message height stable while moving closing OSC markers off line end", () => {
		initTheme("dark");

		const component = new UserMessageComponent("hello");
		const lines = component.render(20);

		expect(lines).toHaveLength(3);
		expect(lines[0]).toContain(OSC133_ZONE_START);
		expect(lines[0].endsWith(BG_RESET)).toBe(true);
		expect(lines[0]).not.toContain(OSC133_ZONE_END);
		expect(lines[1]).toContain("hello");
		expect(lines[2].startsWith(OSC133_ZONE_END + OSC133_ZONE_FINAL)).toBe(true);
		expect(lines[2].endsWith(BG_RESET)).toBe(true);
	});

	test("chains Markdown transformers with user message context", () => {
		initTheme("dark");
		const calls: string[] = [];
		const component = new UserMessageComponent("The input is $x^2$.", undefined, 1, [
			(markdown, context) => {
				calls.push("formula");
				expect(context).toMatchObject({ messageType: "user", isStreaming: false, availableWidth: 78 });
				return markdown.replace("$x^2$", "x²");
			},
			(markdown) => {
				calls.push("suffix");
				return `${markdown} Done.`;
			},
		]);

		expect(stripAnsi(component.render(80).join("\n"))).toContain("The input is x². Done.");
		expect(calls).toEqual(["formula", "suffix"]);
	});

	test("reapplies Markdown transformers when invalidated", () => {
		initTheme("dark");
		let suffix = "before";
		const component = new UserMessageComponent("Message", undefined, 1, [(markdown) => `${markdown} ${suffix}`]);

		expect(stripAnsi(component.render(80).join("\n"))).toContain("Message before");

		suffix = "after";
		component.invalidate();

		expect(stripAnsi(component.render(80).join("\n"))).toContain("Message after");
	});

	test("passes persisted entry identity to Markdown transformer context", () => {
		initTheme("dark");
		let capturedContext: MarkdownTransformContext | undefined;
		const component = new UserMessageComponent(
			"hello",
			undefined,
			1,
			[
				(markdown, context) => {
					capturedContext = context;
					return markdown;
				},
			],
			{ messageId: "entry-abc123", timestamp: "2025-01-15T10:30:00.000Z" },
		);

		component.render(80);

		expect(capturedContext).toMatchObject({
			messageType: "user",
			isStreaming: false,
			messageId: "entry-abc123",
			timestamp: "2025-01-15T10:30:00.000Z",
		});
	});

	test("live user message keeps messageId undefined until persisted; setMessageMeta attaches it", () => {
		initTheme("dark");
		const capturedContexts: MarkdownTransformContext[] = [];
		const component = new UserMessageComponent("hello", undefined, 1, [
			(markdown, context) => {
				capturedContexts.push(context);
				return markdown;
			},
		]);

		component.render(80);
		expect(capturedContexts[0].messageId).toBeUndefined();

		component.setMessageMeta({ messageId: "entry-live2", timestamp: "2025-01-15T10:30:00.000Z" });
		component.render(80);

		expect(capturedContexts.at(-1)).toMatchObject({
			messageId: "entry-live2",
			timestamp: "2025-01-15T10:30:00.000Z",
		});
	});
});

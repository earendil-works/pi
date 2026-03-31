import { beforeAll, describe, expect, test } from "vitest";
import { renderDiff } from "../src/modes/interactive/components/diff.js";
import { setThemeInstance } from "../src/modes/interactive/theme/theme.js";

describe("renderDiff", () => {
	beforeAll(() => {
		setThemeInstance({
			fg: (_name: string, text: string) => text,
			inverse: (text: string) => `<inv>${text}</inv>`,
		} as never);
	});

	test("does not start inverse highlighting before the changed identifier in aligned replacements", () => {
		const rendered = renderDiff('-240 "content":             content,\n+239 "text":                text,');
		const lines = rendered.split("\n");

		expect(lines).toHaveLength(2);
		expect(lines[0]).toBe('-240 "<inv>content</inv>":             <inv>content</inv>,');
		expect(lines[1]).toBe('+239 "<inv>text</inv>":                <inv>text</inv>,');
		expect(lines[1]).not.toMatch(/<inv>\s+text<\/inv>/);
	});

	test("keeps whitespace-only changes visible", () => {
		const rendered = renderDiff("-10 \tindented\n+10   indented");
		const lines = rendered.split("\n");

		expect(lines).toHaveLength(2);
		expect(lines[0]).toBe("-10 <inv>   </inv>indented");
		expect(lines[1]).toBe("+10 <inv>  </inv>indented");
	});
});

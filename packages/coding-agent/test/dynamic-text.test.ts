import { describe, expect, it } from "vitest";
import { DynamicText, DynamicTruncatedText, ExpandableText } from "../src/modes/interactive/components/dynamic-text.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

describe("DynamicText", () => {
	it("reformats its source when invalidated", () => {
		let marker = "old:";
		const text = new DynamicText("message", (source) => `${marker}${source}`, 0, 0);

		expect(text.render(80)[0] ?? "").toMatch(/^old:message/);
		marker = "new:";
		text.invalidate();
		const output = text.render(80)[0] ?? "";

		expect(output).toMatch(/^new:message/);
		expect(output).not.toMatch(/^old:/);
	});

	it("updates its semantic source", () => {
		const text = new DynamicText("before", (source) => `value:${source}`, 0, 0);

		text.setSource("after");

		expect(text.render(80)[0] ?? "").toMatch(/^value:after/);
	});
});

describe("DynamicTruncatedText", () => {
	it("reformats its source when invalidated", () => {
		let marker = "old:";
		const text = new DynamicTruncatedText("message", (source) => `${marker}${source}`);

		expect(text.render(80)[0] ?? "").toMatch(/^old:message/);
		marker = "new:";
		text.invalidate();
		const output = text.render(80)[0] ?? "";

		expect(output).toMatch(/^new:message/);
		expect(output).not.toMatch(/^old:/);
	});

	it("updates its semantic source and preserves truncation", () => {
		const text = new DynamicTruncatedText("before", (source) => `value:${source}`);

		text.setSource("after");

		expect(stripAnsi(text.render(8)[0] ?? "")).toBe("value...");
	});
});

describe("ExpandableText", () => {
	it("reformats the current expansion state when invalidated", () => {
		let marker = "old:";
		const text = new ExpandableText(
			() => `${marker}collapsed`,
			() => `${marker}expanded`,
			false,
		);

		text.setExpanded(true);
		marker = "new:";
		text.invalidate();

		expect(text.render(80)[0] ?? "").toMatch(/^new:expanded/);
	});

	it("preserves a manual collapse after starting expanded", () => {
		let marker = "old:";
		const text = new ExpandableText(
			() => `${marker}collapsed`,
			() => `${marker}expanded`,
			true,
		);

		text.setExpanded(false);
		marker = "new:";
		text.invalidate();
		const output = text.render(80)[0] ?? "";

		expect(output).toMatch(/^new:collapsed/);
		expect(output).not.toContain("expanded");
	});
});

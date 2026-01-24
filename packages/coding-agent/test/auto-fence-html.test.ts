import { describe, expect, it } from "vitest";

import { autoFenceHtmlInMarkdown } from "../src/utils/auto-fence-html.js";

describe("autoFenceHtmlInMarkdown", () => {
	it("wraps simple HTML blocks", () => {
		const raw = "<div>hi</div>";
		const fenced = autoFenceHtmlInMarkdown(raw);

		expect(fenced).toContain(raw);
		expect(fenced.startsWith("```\n")).toBe(true);
		expect(fenced.endsWith("\n```")).toBe(true);
	});

	it("does not wrap autolinks", () => {
		const raw = "<https://example.com>";
		expect(autoFenceHtmlInMarkdown(raw)).toBe(raw);
	});

	it("does not wrap already-fenced markdown", () => {
		const raw = "```\n<div>hi</div>\n```";
		expect(autoFenceHtmlInMarkdown(raw)).toBe(raw);
	});

	it("uses a longer fence when content contains triple backticks", () => {
		const raw = "<div>\n```\nhello\n```\n</div>";
		const fenced = autoFenceHtmlInMarkdown(raw);

		expect(fenced).toContain(raw);
		// Fence should be 4 backticks (since content contains a run of 3)
		expect(fenced.startsWith("````\n")).toBe(true);
		expect(fenced.endsWith("\n````")).toBe(true);
	});
});

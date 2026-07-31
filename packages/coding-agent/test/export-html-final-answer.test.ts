import { readFileSync } from "fs";
import { describe, expect, it } from "vitest";

describe("export HTML final answer rendering", () => {
	const templateJs = readFileSync(new URL("../src/core/export-html/template.js", import.meta.url), "utf-8");
	const templateCss = readFileSync(new URL("../src/core/export-html/template.css", import.meta.url), "utf-8");

	it("includes final answers in text extraction for search and tree display", () => {
		expect(templateJs).toContain("c.type === 'text' || c.type === 'block'");
		expect(templateJs).toContain("formatAssistantBlockLabel");
	});

	it("renders final answer blocks with a label and markdown content", () => {
		expect(templateJs).toContain("block.type === 'block' && block.text.trim()");
		expect(templateJs).toContain("block.name === 'final_answer'");
		expect(templateJs).toContain("final-answer-label");
		expect(templateJs).toContain("Final answer");
		expect(templateJs).toContain("final-answer-text");
		expect(templateJs).toContain("markdown-content");
	});

	it("styles final answer blocks separately from trace text", () => {
		expect(templateCss).toContain(".final-answer-block");
		expect(templateCss).toContain(".final-answer-label");
		expect(templateCss).toContain(".final-answer-text");
	});
});

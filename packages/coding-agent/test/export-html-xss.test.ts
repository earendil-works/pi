import { readFileSync } from "fs";
import { describe, expect, it } from "vitest";

describe("export HTML markdown link sanitization", () => {
	const templateJs = readFileSync(new URL("../src/core/export-html/template.js", import.meta.url), "utf-8");

	it("overrides the marked link renderer to block javascript: protocol", () => {
		// The custom link renderer must check for dangerous protocols
		expect(templateJs).toMatch(/link\s*\(\s*token\s*\)/);
		expect(templateJs).toMatch(/javascript/i);
		expect(templateJs).toMatch(/vbscript/i);
	});

	it("overrides the marked image renderer to block javascript: protocol", () => {
		expect(templateJs).toMatch(/image\s*\(\s*token\s*\)/);
	});

	it("escapes href attributes in the custom link renderer", () => {
		// The link renderer must escape href values to prevent attribute breakout
		expect(templateJs).toMatch(/escapeHtml\(href\)/);
	});

	it("escapes image mimeType attributes", () => {
		// Image mimeType must be escaped to prevent attribute breakout
		expect(templateJs).not.toMatch(/\$\{img\.mimeType\}/);
		expect(templateJs).toMatch(/escapeHtml\(img\.mimeType/);
	});

	it("escapes image data attributes", () => {
		// Image data is embedded in src attributes and must not allow attribute breakout.
		expect(templateJs).not.toMatch(/;base64,\$\{img\.data\}"/);
		expect(templateJs).toMatch(/;base64,\$\{escapeHtml\(img\.data \|\| (?:''|"")\)\}"/);
	});
});

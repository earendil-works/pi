import { describe, expect, it } from "vitest";
import { highlight, renderHighlightedHtml, supportsLanguage } from "../src/utils/syntax-highlight.js";

describe("syntax highlight renderer", () => {
	it("renders highlighted spans with the provided theme", () => {
		const rendered = renderHighlightedHtml('<span class="hljs-keyword">const</span> value', {
			keyword: (text) => `[keyword:${text}]`,
		});
		expect(rendered).toBe("[keyword:const] value");
	});

	it("decodes HTML entities emitted by highlight.js", () => {
		const rendered = renderHighlightedHtml("&lt;tag attr=&quot;value&quot;&gt;&amp;#x41;&#65;&lt;/tag&gt;");
		expect(rendered).toBe('<tag attr="value">&#x41;A</tag>');
	});

	it("inherits parent formatting for unmapped nested scopes", () => {
		const interpolation = "$" + "{x}";
		const rendered = renderHighlightedHtml(
			`<span class="hljs-string">a<span class="hljs-subst">${interpolation}</span>b</span>`,
			{
				string: (text) => `[string:${text}]`,
			},
		);
		expect(rendered).toBe(`[string:a][string:${interpolation}][string:b]`);
	});

	it("keeps parent formatting across unscoped nested spans", () => {
		const rendered = renderHighlightedHtml('<span class="hljs-string">a<span class="language-xml">b</span>c</span>', {
			string: (text) => `[string:${text}]`,
		});
		expect(rendered).toBe("[string:a][string:b][string:c]");
	});

	it("highlights code through highlight.js", () => {
		expect(supportsLanguage("typescript")).toBe(true);
		const rendered = highlight("const value = 1", {
			language: "typescript",
			ignoreIllegals: true,
			theme: {
				keyword: (text) => `[keyword:${text}]`,
				number: (text) => `[number:${text}]`,
			},
		});
		expect(rendered).toContain("[keyword:const]");
		expect(rendered).toContain("[number:1]");
	});
});

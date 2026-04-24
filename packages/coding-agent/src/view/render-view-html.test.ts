/**
 * Red test for renderViewHtml module.
 *
 * Verification: npx tsx packages/coding-agent/src/view/render-view-html.test.ts
 * Expected: all assertions pass (tables, syntax highlighting, bold, inline CSS, no external refs)
 */

import { describe, expect, it } from "vitest";
import { renderViewHtml } from "./render-view-html.js";

const sampleMarkdown = `| Name | Type | Default |
|------|------|---------|
| id | string | uuid() |
| count | number | 0 |

Here is some code:

\`\`\`typescript
function greet(name: string): string {
  return \`Hello, \${name}!\`;
}
\`\`\`

And a **bold** paragraph with \`inline code\`.
`;

describe("renderViewHtml", () => {
	it("renders markdown into self-contained styled HTML", () => {
		const html = renderViewHtml(sampleMarkdown);

		expect(html).toContain("<table>");
		expect(html).toContain("<thead>");
		expect(html).toContain("<tbody>");

		const hasHljsClass =
			html.includes("hljs-keyword") ||
			html.includes("hljs-title") ||
			html.includes("hljs-function") ||
			html.includes("hljs-built_in");
		expect(hasHljsClass).toBe(true);

		expect(html).toContain("<strong>bold</strong>");
		expect(html).toContain("<code>inline code</code>");
		expect(html).not.toContain('href="http');
		expect(html).not.toContain('src="http');
		expect(html).toContain("<style>");
		expect(html).toContain("background");
		expect(html.startsWith("<!DOCTYPE html>")).toBe(true);
		expect(html).toContain("</html>");
		expect(html).toContain('id="input-bar"');
		expect(html).toContain('id="msg-input"');
		expect(html).toContain('id="msg-submit"');
		expect(html).toContain("glimpse.send");
		expect(html).toContain("e.key === 'Enter'");
		expect(html).toContain("!e.shiftKey");

		const css = html.match(/<style>([\s\S]*?)<\/style>/)?.[1] ?? "";
		expect(css).toMatch(/#content\s+ul[^{]*\{[^}]*padding-left/);
		expect(css).toMatch(/#content\s+ol[^{]*\{[^}]*padding-left/);
		expect(css).toMatch(/#content\s+li[^{]*\{[^}]*margin/);
		expect(css).toMatch(/#content\s+li\s*>\s*(ul|ol)[^{]*\{[^}]*margin/);
		expect(css).toMatch(/#content\s+p[^{]*\{[^}]*margin/);
		expect(css).toMatch(/#content\s+h[1-6][^{]*\{[^}]*margin-top/);
		expect(css).toMatch(/#content\s+h[1-6][^{]*\{[^}]*margin-bottom/);
		expect(css).not.toMatch(/#content\s+h[1-6][^{]*\{[^}]*font-size/);
		expect(css).toMatch(/#content\s+blockquote[^{]*\{[^}]*margin/);

		const hrRule = css.match(/#content\s+hr[^{]*\{[^}]*\}/)?.[0] ?? "";
		const hrMarginEm = hrRule.match(/margin:\s*([\d.]+)\s*em/);
		expect(hrMarginEm).not.toBeNull();
		expect(parseFloat(hrMarginEm?.[1] ?? "0")).toBeGreaterThanOrEqual(2);
	});
});

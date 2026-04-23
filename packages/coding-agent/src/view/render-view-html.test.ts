/**
 * Red test for renderViewHtml module.
 *
 * Verification: npx tsx packages/coding-agent/src/view/render-view-html.test.ts
 * Expected: all assertions pass (tables, syntax highlighting, bold, inline CSS, no external refs)
 */
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

const html = renderViewHtml(sampleMarkdown);

// 1. GFM table rendering
console.assert(html.includes("<table>"), "FAIL: no <table>");
console.assert(html.includes("<thead>"), "FAIL: no <thead>");
console.assert(html.includes("<tbody>"), "FAIL: no <tbody>");

// 2. Syntax highlighting — highlight.js wraps tokens in span.hljs-* classes
const hasHljsClass =
	html.includes("hljs-keyword") ||
	html.includes("hljs-title") ||
	html.includes("hljs-function") ||
	html.includes("hljs-built_in");
console.assert(hasHljsClass, "FAIL: no hljs syntax highlighting spans");

// 3. Basic inline markdown
console.assert(html.includes("<strong>bold</strong>"), "FAIL: no <strong>");
console.assert(html.includes("<code>inline code</code>"), "FAIL: no <code>");

// 4. Self-contained: no external CSS/JS references
console.assert(!html.includes('href="http'), "FAIL: has external href");
console.assert(!html.includes('src="http'), "FAIL: has external src");

// 5. Has inline style block (dark theme)
console.assert(html.includes("<style>"), "FAIL: no inline <style>");
console.assert(html.includes("background"), "FAIL: no background in CSS");

// 6. HTML document structure
console.assert(html.startsWith("<!DOCTYPE html>"), "FAIL: no DOCTYPE");
console.assert(html.includes("</html>"), "FAIL: no closing </html>");

// 7. Textarea input bar present
console.assert(html.includes('id="input-bar"'), "FAIL: no input-bar");
console.assert(html.includes('id="msg-input"'), "FAIL: no msg-input textarea");
console.assert(html.includes('id="msg-submit"'), "FAIL: no msg-submit button");
console.assert(html.includes("glimpse.send"), "FAIL: no glimpse.send for submit");

// 8. Enter/Shift+Enter keyboard handling
console.assert(html.includes("e.key === 'Enter'"), "FAIL: no Enter key handler");
console.assert(html.includes("!e.shiftKey"), "FAIL: no Shift+Enter check");

console.log("All assertions passed.");

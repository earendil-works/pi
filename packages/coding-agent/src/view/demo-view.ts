/**
 * Demo script for /view command.
 * Renders sample markdown with tables + syntax highlighting and opens in Glimpse/browser.
 *
 * Usage: npx tsx packages/coding-agent/src/view/demo-view.ts
 */

import { openView } from "./open-view.js";
import { renderViewHtml } from "./render-view-html.js";

const sampleMarkdown = `# /view Demo

Here is a **table** that's hard to read in the terminal:

| Property | Type | Default | Description |
|----------|------|---------|-------------|
| id | string | uuid() | Unique identifier |
| name | string | - | Display name |
| count | number | 0 | Item count |
| enabled | boolean | true | Active flag |
| tags | string[] | [] | Label list |

## Code with Syntax Highlighting

\`\`\`typescript
interface Config {
  id: string;
  name: string;
  count: number;
  enabled: boolean;
  tags: string[];
}

function createConfig(overrides?: Partial<Config>): Config {
  return {
    id: crypto.randomUUID(),
    name: "untitled",
    count: 0,
    enabled: true,
    tags: [],
    ...overrides,
  };
}
\`\`\`

## More Markdown Features

- **Bold text** and *italic text*
- \`Inline code\` looks like this
- [Links](https://example.com) work too

> Blockquotes are rendered with a left border.

---

### A Smaller Table

| Status | Color |
|--------|-------|
| Active | Green |
| Paused | Yellow |
| Stopped | Red |
`;

const html = renderViewHtml(sampleMarkdown);

const result = await openView(html, {
	sessionId: "demo",
	title: "mu /view demo",
});

console.log(`Opened via: ${result.method}`);
console.log(`File: ${result.path}`);

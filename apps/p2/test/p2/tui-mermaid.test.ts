// pi's Mermaid Markdown transformer in p2 (p2-tui-port.md P12): modes from the visitor's `markdown.mermaid` setting,
// the instance theme, and the fallbacks (too wide, invalid, thinking).
import assert from "node:assert/strict";
import { test } from "node:test";
import { stripVTControlCharacters } from "node:util";
import type { MarkdownTransformContext } from "../../src/runtime/tui-renderers.ts";
import { mermaidMarkdownTransformer } from "../../src/tui/components/mermaid.ts";
import { BUILTIN_THEMES, createTheme } from "../../src/tui/theme/theme.ts";

const DIAGRAM = "Before\n\n```mermaid\ngraph TD\nA-->B\n```\n\nAfter\n";
const theme = createTheme(BUILTIN_THEMES.dark!, "truecolor");
const context = (patch: Partial<MarkdownTransformContext> = {}): MarkdownTransformContext => ({
	messageType: "assistant",
	isStreaming: false,
	availableWidth: 80,
	theme,
	settings: undefined,
	...patch,
});
const plain = (text: string) => stripVTControlCharacters(text);

test("renders top-level Mermaid blocks as diagrams by default (pi's streaming mode)", () => {
	const out = mermaidMarkdownTransformer(DIAGRAM, context());
	assert.doesNotMatch(out, /```mermaid/);
	assert.match(plain(out), /│ A │[\s\S]*▼[\s\S]*│ B │/);
	assert.match(out, /^Before/);
	assert.match(out, /After\n$/);
	// Themed: the boxes carry the instance theme's colors.
	assert.notEqual(out, plain(out));
	// While streaming too, in the default mode.
	assert.match(plain(mermaidMarkdownTransformer(DIAGRAM, context({ isStreaming: true }))), /│ A │/);
});

test("modes: off never, final only once the message is complete; thinking blocks stay code", () => {
	const settings = (mermaid: "off" | "final" | "streaming") => ({ markdown: { mermaid } });
	assert.equal(mermaidMarkdownTransformer(DIAGRAM, context({ settings: settings("off") })), DIAGRAM);
	assert.equal(
		mermaidMarkdownTransformer(DIAGRAM, context({ settings: settings("final"), isStreaming: true })),
		DIAGRAM,
	);
	assert.match(plain(mermaidMarkdownTransformer(DIAGRAM, context({ settings: settings("final") }))), /│ A │/);
	assert.equal(mermaidMarkdownTransformer(DIAGRAM, context({ messageType: "assistant-thinking" })), DIAGRAM);
});

test("too wide or invalid diagrams keep their source; invalid ones say why once complete", () => {
	assert.equal(mermaidMarkdownTransformer(DIAGRAM, context({ availableWidth: 4 })), DIAGRAM);
	const invalid = "```mermaid\ngraph TD\nA-->\n```\n";
	const out = mermaidMarkdownTransformer(invalid, context());
	assert.match(out, /```mermaid\ngraph TD\nA-->\n```/);
	assert.match(plain(out), /Mermaid diagram not rendered: dropped, link has no target/);
	// While streaming, an unfinished diagram is not reported.
	assert.doesNotMatch(mermaidMarkdownTransformer(invalid, context({ isStreaming: true })), /not rendered/);
});

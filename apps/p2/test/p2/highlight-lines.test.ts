// Highlighting a file or patch in context (src/web/highlight-lines.ts): a block comment spanning lines keeps its class on
// every line, in a file and across a patch's added line; hunk lines stay plain; spans split at line breaks reopen.
import assert from "node:assert/strict";
import { test } from "node:test";
import { common, createLowlight } from "lowlight";
import type { CodeLine } from "../../src/web/Code.tsx";
import { type HastNode, highlightLines, splitLines } from "../../src/web/highlight-lines.ts";

const lowlight = createLowlight(common);
const typescript = (text: string) => lowlight.highlight("typescript", text).children as unknown as HastNode[];

/** A line's text with the classes around each piece: `[class1 class2]text`, pieces joined by `|`. */
function shown(line: readonly HastNode[] | string): string {
	if (typeof line === "string") return line;
	const pieces: string[] = [];
	const walk = (nodes: readonly HastNode[], classes: string[]) => {
		for (const node of nodes) {
			if (node.type === "text") pieces.push(`[${classes.join(" ")}]${node.value}`);
			else walk(node.children ?? [], [...classes, ...(node.properties?.className as string[])]);
		}
	};
	walk(line, []);
	return pieces.join("|");
}

const context = (text: string): CodeLine => ({ kind: "", text });

test("a block comment's later lines keep the comment class in a file", () => {
	const lines = ["/** Answers once", " * of it answered. */", "const x = 1;"].map(context);
	const [first, second, third] = highlightLines(lines, typescript).map(shown);
	assert.equal(first, "[hljs-comment]/** Answers once");
	assert.equal(second, "[hljs-comment] * of it answered. */");
	assert.match(third!, /\[hljs-keyword\]const/);
});

test("a patch: each side in context, the comment spanning an added line; hunk lines stay plain", () => {
	const lines: CodeLine[] = [
		{ kind: "hunk", text: "@@ -1,3 +1,4 @@" },
		{ kind: "", number: 1, text: "/* start" },
		{ kind: "add", number: 2, text: "   if it returns */" },
		{ kind: "del", number: 2, text: "   const old = 1; */" },
		{ kind: "", number: 3, text: "const y = 2;" },
	];
	const [hunk, start, added, deleted, after] = highlightLines(lines, typescript).map(shown);
	assert.equal(hunk, "@@ -1,3 +1,4 @@");
	assert.equal(start, "[hljs-comment]/* start");
	assert.equal(added, "[hljs-comment]   if it returns */");
	// The old side: the comment opened on the context line covers the deleted line too.
	assert.equal(deleted, "[hljs-comment]   const old = 1; */");
	assert.match(after!, /\[hljs-keyword\]const/);
});

test("spans open at a line break are opened again on the next line, nested ones too", () => {
	const tree: HastNode[] = [
		{
			type: "element",
			properties: { className: ["outer"] },
			children: [
				{ type: "text", value: "a\nb" },
				{ type: "element", properties: { className: ["inner"] }, children: [{ type: "text", value: "c\nd" }] },
			],
		},
		{ type: "text", value: "\ne" },
	];
	assert.deepEqual(splitLines(tree).map(shown), ["[outer]a", "[outer]b|[outer inner]c", "[outer inner]d", "[]e"]);
});

test("without a highlighter's tree, lines stay plain", () => {
	assert.deepEqual(
		highlightLines([context("/* a"), context("b */")], () => undefined),
		["/* a", "b */"],
	);
});

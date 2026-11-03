import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Markdown } from "../src/components/markdown.ts";
import { Text } from "../src/components/text.ts";
import { visibleWidth } from "../src/utils.ts";
import { defaultMarkdownTheme } from "./test-themes.ts";

const stripAnsi = (line: string) => line.replace(/\x1b\[[0-9;]*m/g, "");
const bgColor = (line: string) => `\x1b[44m${line}\x1b[49m`;

describe("copyable TUI lines", () => {
	it("does not append trailing spaces to plain text or blank lines", () => {
		assert.deepEqual(new Text("Hello\nWorld", 1, 1).render(40), ["", " Hello", " World", ""]);
	});

	it("does not append trailing spaces to Markdown text or code blocks", () => {
		const lines = new Markdown("Hello\n\n```sh\nprintf hi\n```", 1, 1, defaultMarkdownTheme)
			.render(40)
			.map(stripAnsi);
		assert.deepEqual(lines, ["", " Hello", "", " ```sh", "   printf hi", " ```", ""]);
		assert.ok(lines.every((line) => !/ +$/.test(line)));
	});

	it("still fills the width for lines with a background", () => {
		const text = new Text("Hello", 1, 1, bgColor).render(40);
		const markdown = new Markdown("Hello", 1, 1, defaultMarkdownTheme, { bgColor }).render(40);
		for (const lines of [text, markdown]) {
			assert.equal(lines.length, 3);
			assert.ok(lines.every((line) => visibleWidth(line) === 40 && line.includes("\x1b[44m")));
		}
	});
});

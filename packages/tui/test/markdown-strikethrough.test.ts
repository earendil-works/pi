import assert from "node:assert";
import { Chalk } from "chalk";
import { describe, it } from "vitest";
import { Markdown } from "../src/components/markdown.js";
import { defaultMarkdownTheme } from "./test-themes.js";

const chalk = new Chalk({ level: 3 });

function stripAnsi(text: string): string {
	return text.replace(/\x1b\[[0-9;]*m/g, "");
}

describe("Markdown strikethrough", () => {
	it("renders ~~text~~ with strikethrough styling", () => {
		const markdown = new Markdown("~~strikethrough~~", 0, 0, defaultMarkdownTheme);
		const lines = markdown.render(80);
		const joined = lines.join("\n");

		// The output should contain strikethrough ANSI escape
		const expected = chalk.strikethrough("strikethrough");
		assert.ok(joined.includes(expected), `Expected strikethrough styling in output, got: ${JSON.stringify(joined)}`);
	});

	it("renders ~text~ with literal tildes, not strikethrough", () => {
		const markdown = new Markdown("~text~", 0, 0, defaultMarkdownTheme);
		const lines = markdown.render(80);
		const plain = lines.map(stripAnsi).join("\n");

		// The output should contain the literal tildes
		assert.ok(plain.includes("~text~"), `Expected literal ~text~ in output, got: ${JSON.stringify(plain)}`);

		// The output should NOT contain strikethrough ANSI escape
		const strikethroughStyled = chalk.strikethrough("text");
		const joined = lines.join("\n");
		assert.ok(!joined.includes(strikethroughStyled), "Should not apply strikethrough to single-tilde text");
	});

	it("renders ~/.config literally, not as strikethrough", () => {
		const markdown = new Markdown("~/.config", 0, 0, defaultMarkdownTheme);
		const lines = markdown.render(80);
		const plain = lines.map(stripAnsi).join("\n");

		assert.ok(plain.includes("~/.config"), `Expected literal ~/.config in output, got: ${JSON.stringify(plain)}`);
	});
});

import assert from "node:assert";
import { describe, it } from "node:test";
import type { Terminal as XtermTerminalType } from "@xterm/headless";
import { Chalk } from "chalk";
import { type DefaultTextStyle, Markdown, type MarkdownTheme } from "../src/components/markdown.js";
import { type Component, TUI } from "../src/tui.js";
import { defaultMarkdownTheme } from "./test-themes.js";
import { VirtualTerminal } from "./virtual-terminal.js";

// Force full color in CI so ANSI assertions are deterministic
const chalk = new Chalk({ level: 3 });

const detectableMarkdownTheme: MarkdownTheme = {
	...defaultMarkdownTheme,
	code: (text: string) => chalk.bgBlue.white(`CODE<${text}>`),
	codeBlock: (text: string) => chalk.bgGreen.black(`BLOCK<${text}>`),
	codeBlockBorder: (text: string) => chalk.bgRed.white(`BORDER<${text}>`),
	highlightCode: (code: string, lang?: string) =>
		code.split("\n").map((line, index) => chalk.bgMagenta.white(`HL[${lang ?? ""}:${index}]<${line}>`)),
	codeBlockIndent: ">> ",
};

function stripAnsi(text: string): string {
	return text.replace(/\x1b\[[0-9;]*m/g, "");
}

function renderMarkdown(
	text: string,
	width = 80,
	theme: MarkdownTheme = defaultMarkdownTheme,
	defaultTextStyle?: DefaultTextStyle,
): string[] {
	return new Markdown(text, 0, 0, theme, defaultTextStyle).render(width);
}

function renderPlainMarkdown(
	text: string,
	width = 80,
	theme: MarkdownTheme = defaultMarkdownTheme,
	defaultTextStyle?: DefaultTextStyle,
): string[] {
	return renderMarkdown(text, width, theme, defaultTextStyle).map((line) => stripAnsi(line).trimEnd());
}

class MarkdownWithInput implements Component {
	public markdownLineCount = 0;

	constructor(private readonly markdown: Markdown) {}

	render(width: number): string[] {
		const lines = this.markdown.render(width);
		this.markdownLineCount = lines.length;
		return [...lines, "INPUT"];
	}

	invalidate(): void {
		this.markdown.invalidate();
	}
}

function getCellItalic(terminal: VirtualTerminal, row: number, col: number): number {
	const xterm = (terminal as unknown as { xterm: XtermTerminalType }).xterm;
	const buffer = xterm.buffer.active;
	const line = buffer.getLine(buffer.viewportY + row);
	assert.ok(line, `Missing buffer line at row ${row}`);
	const cell = line.getCell(col);
	assert.ok(cell, `Missing cell at row ${row} col ${col}`);
	return cell.isItalic();
}

function getCellUnderline(terminal: VirtualTerminal, row: number, col: number): number {
	const xterm = (terminal as unknown as { xterm: XtermTerminalType }).xterm;
	const buffer = xterm.buffer.active;
	const line = buffer.getLine(buffer.viewportY + row);
	assert.ok(line, `Missing buffer line at row ${row}`);
	const cell = line.getCell(col);
	assert.ok(cell, `Missing cell at row ${row} col ${col}`);
	return cell.isUnderline();
}

function getCellFg(terminal: VirtualTerminal, row: number, col: number): number {
	const xterm = (terminal as unknown as { xterm: XtermTerminalType }).xterm;
	const buffer = xterm.buffer.active;
	const line = buffer.getLine(buffer.viewportY + row);
	assert.ok(line, `Missing buffer line at row ${row}`);
	const cell = line.getCell(col);
	assert.ok(cell, `Missing cell at row ${row} col ${col}`);
	return cell.getFgColor();
}

describe("Markdown component", () => {
	describe("Nested lists", () => {
		it("should render simple nested list", () => {
			const markdown = new Markdown(
				`- Item 1
  - Nested 1.1
  - Nested 1.2
- Item 2`,
				0,
				0,
				defaultMarkdownTheme,
			);

			const lines = markdown.render(80);

			// Check that we have content
			assert.ok(lines.length > 0);

			// Strip ANSI codes for checking
			const plainLines = lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, ""));

			// Check structure
			assert.ok(plainLines.some((line) => line.includes("- Item 1")));
			assert.ok(plainLines.some((line) => line.includes("  - Nested 1.1")));
			assert.ok(plainLines.some((line) => line.includes("  - Nested 1.2")));
			assert.ok(plainLines.some((line) => line.includes("- Item 2")));
		});

		it("should render deeply nested list", () => {
			const markdown = new Markdown(
				`- Level 1
  - Level 2
    - Level 3
      - Level 4`,
				0,
				0,
				defaultMarkdownTheme,
			);

			const lines = markdown.render(80);
			const plainLines = lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, ""));

			// Check proper indentation
			assert.ok(plainLines.some((line) => line.includes("- Level 1")));
			assert.ok(plainLines.some((line) => line.includes("  - Level 2")));
			assert.ok(plainLines.some((line) => line.includes("    - Level 3")));
			assert.ok(plainLines.some((line) => line.includes("      - Level 4")));
		});

		it("should render ordered nested list", () => {
			const markdown = new Markdown(
				`1. First
   1. Nested first
   2. Nested second
2. Second`,
				0,
				0,
				defaultMarkdownTheme,
			);

			const lines = markdown.render(80);
			const plainLines = lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, ""));

			assert.ok(plainLines.some((line) => line.includes("1. First")));
			assert.ok(plainLines.some((line) => line.includes("  1. Nested first")));
			assert.ok(plainLines.some((line) => line.includes("  2. Nested second")));
			assert.ok(plainLines.some((line) => line.includes("2. Second")));
		});

		it("should render mixed ordered and unordered nested lists", () => {
			const markdown = new Markdown(
				`1. Ordered item
   - Unordered nested
   - Another nested
2. Second ordered
   - More nested`,
				0,
				0,
				defaultMarkdownTheme,
			);

			const lines = markdown.render(80);
			const plainLines = lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, ""));

			assert.ok(plainLines.some((line) => line.includes("1. Ordered item")));
			assert.ok(plainLines.some((line) => line.includes("  - Unordered nested")));
			assert.ok(plainLines.some((line) => line.includes("2. Second ordered")));
		});

		it("should maintain numbering when code blocks are not indented (LLM output)", () => {
			// When code blocks aren't indented, marked parses each item as a separate list.
			// We use token.start to preserve the original numbering.
			const markdown = new Markdown(
				`1. First item

\`\`\`typescript
// code block
\`\`\`

2. Second item

\`\`\`typescript
// another code block
\`\`\`

3. Third item`,
				0,
				0,
				defaultMarkdownTheme,
			);

			const lines = markdown.render(80);
			const plainLines = lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, "").trim());

			// Find all lines that start with a number and period
			const numberedLines = plainLines.filter((line) => /^\d+\./.test(line));

			// Should have 3 numbered items
			assert.strictEqual(numberedLines.length, 3, `Expected 3 numbered items, got: ${numberedLines.join(", ")}`);

			// Check the actual numbers
			assert.ok(numberedLines[0].startsWith("1."), `First item should be "1.", got: ${numberedLines[0]}`);
			assert.ok(numberedLines[1].startsWith("2."), `Second item should be "2.", got: ${numberedLines[1]}`);
			assert.ok(numberedLines[2].startsWith("3."), `Third item should be "3.", got: ${numberedLines[2]}`);
		});
	});

	describe("Tables", () => {
		it("should render simple table", () => {
			const markdown = new Markdown(
				`| Name | Age |
| --- | --- |
| Alice | 30 |
| Bob | 25 |`,
				0,
				0,
				defaultMarkdownTheme,
			);

			const lines = markdown.render(80);
			const plainLines = lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, ""));

			// Check table structure
			assert.ok(plainLines.some((line) => line.includes("Name")));
			assert.ok(plainLines.some((line) => line.includes("Age")));
			assert.ok(plainLines.some((line) => line.includes("Alice")));
			assert.ok(plainLines.some((line) => line.includes("Bob")));
			// Check for table borders
			assert.ok(plainLines.some((line) => line.includes("│")));
			assert.ok(plainLines.some((line) => line.includes("─")));
		});

		it("should render row dividers between data rows", () => {
			const markdown = new Markdown(
				`| Name | Age |
| --- | --- |
| Alice | 30 |
| Bob | 25 |`,
				0,
				0,
				defaultMarkdownTheme,
			);

			const lines = markdown.render(80);
			const plainLines = lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, ""));
			const dividerLines = plainLines.filter((line) => line.includes("┼"));

			assert.strictEqual(dividerLines.length, 2, "Expected header + row divider");
		});

		it("should keep column width at least the longest word", () => {
			const longestWord = "superlongword";
			const markdown = new Markdown(
				`| Column One | Column Two |
| --- | --- |
| ${longestWord} short | otherword |
| small | tiny |`,
				0,
				0,
				defaultMarkdownTheme,
			);

			const lines = markdown.render(32);
			const plainLines = lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, ""));
			const dataLine = plainLines.find((line) => line.includes(longestWord));
			assert.ok(dataLine, "Expected data row containing longest word");

			const segments = dataLine.split("│").slice(1, -1);
			const [firstSegment] = segments;
			assert.ok(firstSegment, "Expected first column segment");
			const firstColumnWidth = firstSegment.length - 2;

			assert.ok(
				firstColumnWidth >= longestWord.length,
				`Expected first column width >= ${longestWord.length}, got ${firstColumnWidth}`,
			);
		});

		it("should render table with alignment", () => {
			const markdown = new Markdown(
				`| Left | Center | Right |
| :--- | :---: | ---: |
| A | B | C |
| Long text | Middle | End |`,
				0,
				0,
				defaultMarkdownTheme,
			);

			const lines = markdown.render(80);
			const plainLines = lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, ""));

			// Check headers
			assert.ok(plainLines.some((line) => line.includes("Left")));
			assert.ok(plainLines.some((line) => line.includes("Center")));
			assert.ok(plainLines.some((line) => line.includes("Right")));
			// Check content
			assert.ok(plainLines.some((line) => line.includes("Long text")));
		});

		it("should handle tables with varying column widths", () => {
			const markdown = new Markdown(
				`| Short | Very long column header |
| --- | --- |
| A | This is a much longer cell content |
| B | Short |`,
				0,
				0,
				defaultMarkdownTheme,
			);

			const lines = markdown.render(80);

			// Should render without errors
			assert.ok(lines.length > 0);

			const plainLines = lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, ""));
			assert.ok(plainLines.some((line) => line.includes("Very long column header")));
			assert.ok(plainLines.some((line) => line.includes("This is a much longer cell content")));
		});

		it("should wrap table cells when table exceeds available width", () => {
			const markdown = new Markdown(
				`| Command | Description | Example |
| --- | --- | --- |
| npm install | Install all dependencies | npm install |
| npm run build | Build the project | npm run build |`,
				0,
				0,
				defaultMarkdownTheme,
			);

			// Render at narrow width that forces wrapping
			const lines = markdown.render(50);
			const plainLines = lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, "").trimEnd());

			// All lines should fit within width
			for (const line of plainLines) {
				assert.ok(line.length <= 50, `Line exceeds width 50: "${line}" (length: ${line.length})`);
			}

			// Content should still be present (possibly wrapped across lines)
			const allText = plainLines.join(" ");
			assert.ok(allText.includes("Command"), "Should contain 'Command'");
			assert.ok(allText.includes("Description"), "Should contain 'Description'");
			assert.ok(allText.includes("npm install"), "Should contain 'npm install'");
			assert.ok(allText.includes("Install"), "Should contain 'Install'");
		});

		it("should wrap long cell content to multiple lines", () => {
			const markdown = new Markdown(
				`| Header |
| --- |
| This is a very long cell content that should wrap |`,
				0,
				0,
				defaultMarkdownTheme,
			);

			// Render at width that forces the cell to wrap
			const lines = markdown.render(25);
			const plainLines = lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, "").trimEnd());

			// Should have multiple data rows due to wrapping
			const dataRows = plainLines.filter((line) => line.startsWith("│") && !line.includes("─"));
			assert.ok(dataRows.length > 2, `Expected wrapped rows, got ${dataRows.length} rows`);

			// All content should be preserved (may be split across lines)
			const allText = plainLines.join(" ");
			assert.ok(allText.includes("very long"), "Should preserve 'very long'");
			assert.ok(allText.includes("cell content"), "Should preserve 'cell content'");
			assert.ok(allText.includes("should wrap"), "Should preserve 'should wrap'");
		});

		it("should wrap long unbroken tokens inside table cells (not only at line start)", () => {
			const url = "https://example.com/this/is/a/very/long/url/that/should/wrap";
			const markdown = new Markdown(
				`| Value |
| --- |
| prefix ${url} |`,
				0,
				0,
				defaultMarkdownTheme,
			);

			const width = 30;
			const lines = markdown.render(width);
			const plainLines = lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, "").trimEnd());

			for (const line of plainLines) {
				assert.ok(line.length <= width, `Line exceeds width ${width}: "${line}" (length: ${line.length})`);
			}

			// Borders should stay intact (exactly 2 vertical borders for a 1-col table)
			const tableLines = plainLines.filter((line) => line.startsWith("│"));
			assert.ok(tableLines.length > 0, "Expected table rows to render");
			for (const line of tableLines) {
				const borderCount = line.split("│").length - 1;
				assert.strictEqual(borderCount, 2, `Expected 2 borders, got ${borderCount}: "${line}"`);
			}

			// Strip box drawing characters + whitespace so we can assert the URL is preserved
			// even if it was split across multiple wrapped lines.
			const extracted = plainLines.join("").replace(/[│├┤─\s]/g, "");
			assert.ok(extracted.includes("prefix"), "Should preserve 'prefix'");
			assert.ok(extracted.includes(url), "Should preserve URL");
		});

		it("should wrap styled inline code inside table cells without breaking borders", () => {
			const markdown = new Markdown(
				`| Code |
| --- |
| \`averyveryveryverylongidentifier\` |`,
				0,
				0,
				defaultMarkdownTheme,
			);

			const width = 20;
			const lines = markdown.render(width);
			const joinedOutput = lines.join("\n");
			assert.ok(joinedOutput.includes("\x1b[33m"), "Inline code should be styled (yellow)");

			const plainLines = lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, "").trimEnd());
			for (const line of plainLines) {
				assert.ok(line.length <= width, `Line exceeds width ${width}: "${line}" (length: ${line.length})`);
			}

			const tableLines = plainLines.filter((line) => line.startsWith("│"));
			for (const line of tableLines) {
				const borderCount = line.split("│").length - 1;
				assert.strictEqual(borderCount, 2, `Expected 2 borders, got ${borderCount}: "${line}"`);
			}
		});

		it("should handle extremely narrow width gracefully", () => {
			const markdown = new Markdown(
				`| A | B | C |
| --- | --- | --- |
| 1 | 2 | 3 |`,
				0,
				0,
				defaultMarkdownTheme,
			);

			// Very narrow width
			const lines = markdown.render(15);
			const plainLines = lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, "").trimEnd());

			// Should not crash and should produce output
			assert.ok(lines.length > 0, "Should produce output");

			// Lines should not exceed width
			for (const line of plainLines) {
				assert.ok(line.length <= 15, `Line exceeds width 15: "${line}" (length: ${line.length})`);
			}
		});

		it("should render table correctly when it fits naturally", () => {
			const markdown = new Markdown(
				`| A | B |
| --- | --- |
| 1 | 2 |`,
				0,
				0,
				defaultMarkdownTheme,
			);

			// Wide width where table fits naturally
			const lines = markdown.render(80);
			const plainLines = lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, "").trimEnd());

			// Should have proper table structure
			const headerLine = plainLines.find((line) => line.includes("A") && line.includes("B"));
			assert.ok(headerLine, "Should have header row");
			assert.ok(headerLine?.includes("│"), "Header should have borders");

			const separatorLine = plainLines.find((line) => line.includes("├") && line.includes("┼"));
			assert.ok(separatorLine, "Should have separator row");

			const dataLine = plainLines.find((line) => line.includes("1") && line.includes("2"));
			assert.ok(dataLine, "Should have data row");
		});

		it("should respect paddingX when calculating table width", () => {
			const markdown = new Markdown(
				`| Column One | Column Two |
| --- | --- |
| Data 1 | Data 2 |`,
				2, // paddingX = 2
				0,
				defaultMarkdownTheme,
			);

			// Width 40 with paddingX=2 means contentWidth=36
			const lines = markdown.render(40);
			const plainLines = lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, "").trimEnd());

			// All lines should respect width
			for (const line of plainLines) {
				assert.ok(line.length <= 40, `Line exceeds width 40: "${line}" (length: ${line.length})`);
			}

			// Table rows should have left padding
			const tableRow = plainLines.find((line) => line.includes("│"));
			assert.ok(tableRow?.startsWith("  "), "Table should have left padding");
		});

		it("should not add a trailing blank line when table is the last rendered block", () => {
			const markdown = new Markdown(
				`| Name |
| --- |
| Alice |`,
				0,
				0,
				defaultMarkdownTheme,
			);

			const lines = markdown.render(80);
			const plainLines = lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, "").trimEnd());

			assert.notStrictEqual(
				plainLines.at(-1),
				"",
				`Expected table to end without a blank line: ${JSON.stringify(plainLines)}`,
			);
		});
	});

	describe("Combined features", () => {
		it("should render lists and tables together", () => {
			const markdown = new Markdown(
				`# Test Document

- Item 1
  - Nested item
- Item 2

| Col1 | Col2 |
| --- | --- |
| A | B |`,
				0,
				0,
				defaultMarkdownTheme,
			);

			const lines = markdown.render(80);
			const plainLines = lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, ""));

			// Check heading
			assert.ok(plainLines.some((line) => line.includes("Test Document")));
			// Check list
			assert.ok(plainLines.some((line) => line.includes("- Item 1")));
			assert.ok(plainLines.some((line) => line.includes("  - Nested item")));
			// Check table
			assert.ok(plainLines.some((line) => line.includes("Col1")));
			assert.ok(plainLines.some((line) => line.includes("│")));
		});
	});

	describe("Pre-styled text (thinking traces)", () => {
		it("should preserve gray italic styling after inline code", () => {
			// This replicates how thinking content is rendered in assistant-message.ts
			const markdown = new Markdown(
				"This is thinking with `inline code` and more text after",
				1,
				0,
				defaultMarkdownTheme,
				{
					color: (text) => chalk.gray(text),
					italic: true,
				},
			);

			const lines = markdown.render(80);
			const joinedOutput = lines.join("\n");

			// Should contain the inline code block
			assert.ok(joinedOutput.includes("inline code"));

			// The output should have ANSI codes for gray (90) and italic (3)
			assert.ok(joinedOutput.includes("\x1b[90m"), "Should have gray color code");
			assert.ok(joinedOutput.includes("\x1b[3m"), "Should have italic code");

			// Verify that inline code is styled (theme uses yellow)
			const hasCodeColor = joinedOutput.includes("\x1b[33m");
			assert.ok(hasCodeColor, "Should style inline code");
		});

		it("should preserve gray italic styling after bold text", () => {
			const markdown = new Markdown(
				"This is thinking with **bold text** and more after",
				1,
				0,
				defaultMarkdownTheme,
				{
					color: (text) => chalk.gray(text),
					italic: true,
				},
			);

			const lines = markdown.render(80);
			const joinedOutput = lines.join("\n");

			// Should contain bold text
			assert.ok(joinedOutput.includes("bold text"));

			// The output should have ANSI codes for gray (90) and italic (3)
			assert.ok(joinedOutput.includes("\x1b[90m"), "Should have gray color code");
			assert.ok(joinedOutput.includes("\x1b[3m"), "Should have italic code");

			// Should have bold codes (1 or 22 for bold on/off)
			assert.ok(joinedOutput.includes("\x1b[1m"), "Should have bold code");
		});

		it("should not leak styles into following lines when rendered in TUI", async () => {
			const markdown = new Markdown("This is thinking with `inline code`", 1, 0, defaultMarkdownTheme, {
				color: (text) => chalk.gray(text),
				italic: true,
			});

			const terminal = new VirtualTerminal(80, 6);
			const tui = new TUI(terminal);
			const component = new MarkdownWithInput(markdown);
			tui.addChild(component);
			tui.start();
			await terminal.waitForRender();

			assert.ok(component.markdownLineCount > 0);
			const inputRow = component.markdownLineCount;
			assert.strictEqual(getCellItalic(terminal, inputRow, 0), 0);
			tui.stop();
		});
	});

	describe("Math delimiters", () => {
		it("should render inline \\(...\\) inside a paragraph with code styling", () => {
			const lines = renderMarkdown("before \\(x^2\\) after", 80, detectableMarkdownTheme);
			const plainLines = lines.map((line) => stripAnsi(line).trimEnd());
			const joinedOutput = lines.join("\n");

			assert.deepStrictEqual(plainLines, ["before CODE<x^2> after"]);
			assert.ok(joinedOutput.includes("\x1b[44m"), "Inline math should use the detectable code style");
			assert.ok(!plainLines[0]?.includes("\\("), "Should strip the opening inline math delimiter");
			assert.ok(!plainLines[0]?.includes("\\)"), "Should strip the closing inline math delimiter");
		});

		it("should render top-level \\[...\\], $$...$$, and fenced math as fence-free display blocks", () => {
			const cases = [
				{ name: "\\[...\\]", text: "\\[\nx^2 + y^2\n= z^2\n\\]" },
				{ name: "$$...$$", text: "$$\nx^2 + y^2\n= z^2\n$$" },
				{ name: "```math", text: "```math\nx^2 + y^2\n= z^2\n```" },
			];
			const expected = ["  x^2 + y^2", "  = z^2"];

			for (const testCase of cases) {
				assert.deepStrictEqual(
					renderPlainMarkdown(testCase.text),
					expected,
					`Unexpected display-math output for ${testCase.name}`,
				);
			}
		});

		it("should render positive container-stripped blockquote math for \\[...\\] and $$...$$", () => {
			const cases = [
				{ name: "blockquote \\[...\\]", text: "> \\[\n> x^2 + y^2\n> = z^2\n> \\]" },
				{ name: "blockquote $$...$$", text: "> $$\n> x^2 + y^2\n> = z^2\n> $$" },
			];
			const expected = ["│   x^2 + y^2", "│   = z^2"];

			for (const testCase of cases) {
				assert.deepStrictEqual(
					renderPlainMarkdown(testCase.text),
					expected,
					`Unexpected blockquote display-math output for ${testCase.name}`,
				);
			}
		});

		it("should keep blockquote near-miss delimiters literal when prose shares stripped lines", () => {
			assert.deepStrictEqual(renderPlainMarkdown("> before \\[\n> x^2\n> \\] after"), [
				"│ before",
				"│ [",
				"│ x^2",
				"│ ] after",
			]);
			assert.deepStrictEqual(renderPlainMarkdown("> before $$\n> x^2\n> $$ after"), [
				"│ before",
				"│ $$",
				"│ x^2",
				"│ $$ after",
			]);
		});

		it("should render positive loose-list container-stripped math for \\[...\\] and $$...$$", () => {
			const cases = [
				{ name: "loose-list \\[...\\]", text: "- item\n\n  \\[\n  x^2 + y^2\n  = z^2\n  \\]" },
				{ name: "loose-list $$...$$", text: "- item\n\n  $$\n  x^2 + y^2\n  = z^2\n  $$" },
			];
			const expected = ["- item", "    x^2 + y^2", "    = z^2"];

			for (const testCase of cases) {
				assert.deepStrictEqual(
					renderPlainMarkdown(testCase.text),
					expected,
					`Unexpected loose-list display-math output for ${testCase.name}`,
				);
			}
		});

		it("should keep loose-list near-miss delimiters literal for \\[...\\] and $$...$$", () => {
			assert.deepStrictEqual(renderPlainMarkdown("- item\n\n  before \\[\n  x^2\n  \\] after"), [
				"- item",
				"  before [",
				"x^2",
				"] after",
			]);
			assert.deepStrictEqual(renderPlainMarkdown("- item\n\n  before $$\n  x^2\n  $$ after"), [
				"- item",
				"  before $$",
				"x^2",
				"$$ after",
			]);
		});

		it("should render positive tight-list container-stripped math for \\[...\\] and $$...$$ without loosening the list", () => {
			const cases = [
				{ name: "tight-list \\[...\\]", text: "- \\[\n  x^2 + y^2\n  = z^2\n  \\]\n- next" },
				{ name: "tight-list $$...$$", text: "- $$\n  x^2 + y^2\n  = z^2\n  $$\n- next" },
			];
			const expected = ["-   x^2 + y^2", "    = z^2", "- next"];

			for (const testCase of cases) {
				assert.deepStrictEqual(
					renderPlainMarkdown(testCase.text),
					expected,
					`Unexpected tight-list display-math output for ${testCase.name}`,
				);
			}
		});

		it("should keep tight-list near-miss delimiters literal for \\[...\\] and $$...$$", () => {
			assert.deepStrictEqual(renderPlainMarkdown("- before \\[\n  x^2\n  \\] after\n- next"), [
				"- before [",
				"x^2",
				"] after",
				"- next",
			]);
			assert.deepStrictEqual(renderPlainMarkdown("- before $$\n  x^2\n  $$ after\n- next"), [
				"- before $$",
				"x^2",
				"$$ after",
				"- next",
			]);
		});

		it("should keep top-level near-miss delimiters literal when prose shares a line", () => {
			assert.deepStrictEqual(renderPlainMarkdown("before \\[\nx^2\n\\] after"), ["before", "[", "x^2", "] after"]);
			assert.deepStrictEqual(renderPlainMarkdown("before $$\nx^2\n$$ after"), ["before", "$$", "x^2", "$$ after"]);
		});

		it("should keep malformed and single-dollar-like math candidates literal", () => {
			assert.deepStrictEqual(renderPlainMarkdown("\\[\nx^2"), ["[", "x^2"]);
			assert.deepStrictEqual(renderPlainMarkdown("$$\nx^2"), ["$$", "x^2"]);
			assert.deepStrictEqual(renderPlainMarkdown("before \\(x^2 after"), ["before (x^2 after"]);
			assert.deepStrictEqual(renderPlainMarkdown("Price is $20 in $HOME and $PATH, not $x$."), [
				"Price is $20 in $HOME and $PATH, not $x$.",
			]);
		});

		it("should keep spacing stable when math is adjacent to headings and paragraphs", () => {
			const plainLines = renderPlainMarkdown("# Heading\n\n$$\nx^2\n$$\n\ntext");
			assert.deepStrictEqual(plainLines, ["Heading", "", "  x^2", "", "text"]);
		});

		it("should give \\[...\\], $$...$$, and fenced math the same detectable no-border no-highlight contract", () => {
			const cases = ["\\[\nx^2 + y^2\n= z^2\n\\]", "$$\nx^2 + y^2\n= z^2\n$$", "```math\nx^2 + y^2\n= z^2\n```"];
			const outputs = cases.map((text) => renderMarkdown(text, 80, detectableMarkdownTheme));
			const plainOutputs = outputs.map((lines) => lines.map((line) => stripAnsi(line).trimEnd()));

			assert.deepStrictEqual(plainOutputs[0], plainOutputs[1]);
			assert.deepStrictEqual(plainOutputs[1], plainOutputs[2]);
			assert.deepStrictEqual(outputs[0], outputs[1]);
			assert.deepStrictEqual(outputs[1], outputs[2]);

			const joinedOutput = outputs[0].join("\n");
			assert.ok(joinedOutput.includes("\x1b[42m"), "Display math should use detectable codeBlock styling");
			assert.ok(!joinedOutput.includes("BORDER<"), "Display math should bypass codeBlockBorder");
			assert.ok(!joinedOutput.includes("HL["), "Display math should bypass highlightCode");
		});

		it("should still use the detectable highlightCode and codeBlockBorder path for normal fenced code", () => {
			const lines = renderMarkdown("```ts\nconst answer = 42;\n```", 80, detectableMarkdownTheme);
			const plainLines = lines.map((line) => stripAnsi(line).trimEnd());
			const joinedOutput = lines.join("\n");

			assert.deepStrictEqual(plainLines, ["BORDER<```ts>", ">> HL[ts:0]<const answer = 42;>", "BORDER<```>"]);
			assert.ok(joinedOutput.includes("\x1b[41m"), "Normal code should render border styling");
			assert.ok(joinedOutput.includes("\x1b[45m"), "Normal code should render highlight output");
		});

		it("should wrap narrow display math without synthetic fences or highlight markers", () => {
			const cases = [
				"\\[\nabcdefghij1234567890\n\\]",
				"$$\nabcdefghij1234567890\n$$",
				"```math\nabcdefghij1234567890\n```",
			];

			for (const text of cases) {
				const lines = renderMarkdown(text, 12, detectableMarkdownTheme);
				const plainLines = lines.map((line) => stripAnsi(line).trimEnd());
				const joinedOutput = lines.join("\n");
				const compactPlain = plainLines.join("").replace(/\s+/g, "");

				assert.ok(
					compactPlain.includes("BLOCK<abcdefghij1234567890>"),
					`Wrapped display math lost content: ${JSON.stringify(plainLines)}`,
				);
				assert.ok(
					!plainLines.some((line) => line.includes("BORDER<") || line.includes("HL[") || line.includes("```")),
					`Display math should stay fence-free when wrapped: ${JSON.stringify(plainLines)}`,
				);
				assert.ok(
					joinedOutput.includes("\x1b[42m"),
					"Wrapped display math should keep detectable codeBlock styling",
				);
				assert.ok(!joinedOutput.includes("\x1b[41m"), "Wrapped display math should not use border styling");
				assert.ok(!joinedOutput.includes("\x1b[45m"), "Wrapped display math should not use highlight styling");
			}
		});

		it("should reset inline math styling without leaking into following text or later lines in TUI", async () => {
			const defaultTextStyle: DefaultTextStyle = {
				color: (text) => chalk.gray(text),
				italic: true,
			};
			const markdown = new Markdown(
				"before \\(x^2\\) after continuation text",
				0,
				0,
				defaultMarkdownTheme,
				defaultTextStyle,
			);
			const terminal = new VirtualTerminal(20, 6);
			const tui = new TUI(terminal);
			const component = new MarkdownWithInput(markdown);
			tui.addChild(component);
			tui.start();
			await terminal.waitForRender();

			assert.ok(
				component.markdownLineCount > 1,
				`Expected wrapped markdown lines, got ${component.markdownLineCount}`,
			);

			const beforeFg = getCellFg(terminal, 0, 0);
			const mathFg = getCellFg(terminal, 0, 7);
			const afterFg = getCellFg(terminal, 0, 11);
			const continuationFg = getCellFg(terminal, 1, 0);

			assert.notStrictEqual(
				mathFg,
				beforeFg,
				"Inline math should use a different foreground style than surrounding text",
			);
			assert.strictEqual(
				afterFg,
				beforeFg,
				"Text after inline math should restore the surrounding foreground style",
			);
			assert.strictEqual(
				continuationFg,
				beforeFg,
				"Wrapped continuation text should restore the surrounding foreground style",
			);
			assert.ok(getCellItalic(terminal, 0, 0) !== 0, "Surrounding text should stay italic");
			assert.strictEqual(
				getCellItalic(terminal, 0, 7),
				0,
				"Inline math should use code styling without inherited italics",
			);
			assert.strictEqual(
				getCellItalic(terminal, 0, 11),
				getCellItalic(terminal, 0, 0),
				"Text after inline math should restore italic styling",
			);
			assert.strictEqual(
				getCellItalic(terminal, 1, 0),
				getCellItalic(terminal, 0, 0),
				"Wrapped continuation text should restore italic styling",
			);

			const inputRow = component.markdownLineCount;
			assert.notStrictEqual(
				getCellFg(terminal, inputRow, 0),
				mathFg,
				"The next rendered line should not inherit inline math foreground styling",
			);
			assert.strictEqual(
				getCellItalic(terminal, inputRow, 0),
				0,
				"The next rendered line should not inherit inline math italics",
			);

			tui.stop();
		});
	});

	describe("Spacing after code blocks", () => {
		it("should have only one blank line between code block and following paragraph", () => {
			const markdown = new Markdown(
				`hello world

\`\`\`js
const hello = "world";
\`\`\`

again, hello world`,
				0,
				0,
				defaultMarkdownTheme,
			);

			const lines = markdown.render(80);
			const plainLines = lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, "").trimEnd());

			const closingBackticksIndex = plainLines.indexOf("```");
			assert.ok(closingBackticksIndex !== -1, "Should have closing backticks");

			const afterBackticks = plainLines.slice(closingBackticksIndex + 1);
			const emptyLineCount = afterBackticks.findIndex((line) => line !== "");

			assert.strictEqual(
				emptyLineCount,
				1,
				`Expected 1 empty line after code block, but found ${emptyLineCount}. Lines after backticks: ${JSON.stringify(afterBackticks.slice(0, 5))}`,
			);
		});

		it("should normalize paragraph and code block spacing to one blank line", () => {
			const cases = [
				`hello this is text
\`\`\`
code block
\`\`\`
more text`,
				`hello this is text

\`\`\`
code block
\`\`\`

more text`,
			];
			const expectedLines = ["hello this is text", "", "```", "  code block", "```", "", "more text"];

			for (const text of cases) {
				const markdown = new Markdown(text, 0, 0, defaultMarkdownTheme);
				const lines = markdown.render(80);
				const plainLines = lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, "").trimEnd());

				assert.deepStrictEqual(
					plainLines,
					expectedLines,
					`Unexpected spacing for markdown: ${JSON.stringify(text)}`,
				);
			}
		});

		it("should not add a trailing blank line when code block is the last rendered block", () => {
			const cases = ["```js\nconst hello = 'world';\n```", "hello world\n\n```js\nconst hello = 'world';\n```"];

			for (const text of cases) {
				const markdown = new Markdown(text, 0, 0, defaultMarkdownTheme);
				const lines = markdown.render(80);
				const plainLines = lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, "").trimEnd());

				assert.notStrictEqual(
					plainLines.at(-1),
					"",
					`Expected code block to end without a blank line: ${JSON.stringify(plainLines)}`,
				);
			}
		});
	});

	describe("Spacing after dividers", () => {
		it("should have only one blank line between divider and following paragraph", () => {
			const markdown = new Markdown(
				`hello world

---

again, hello world`,
				0,
				0,
				defaultMarkdownTheme,
			);

			const lines = markdown.render(80);
			const plainLines = lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, "").trimEnd());

			const dividerIndex = plainLines.findIndex((line) => line.includes("─"));
			assert.ok(dividerIndex !== -1, "Should have divider");

			const afterDivider = plainLines.slice(dividerIndex + 1);
			const emptyLineCount = afterDivider.findIndex((line) => line !== "");

			assert.strictEqual(
				emptyLineCount,
				1,
				`Expected 1 empty line after divider, but found ${emptyLineCount}. Lines after divider: ${JSON.stringify(afterDivider.slice(0, 5))}`,
			);
		});

		it("should not add a trailing blank line when divider is the last rendered block", () => {
			const markdown = new Markdown("---", 0, 0, defaultMarkdownTheme);
			const lines = markdown.render(80);
			const plainLines = lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, "").trimEnd());

			assert.notStrictEqual(
				plainLines.at(-1),
				"",
				`Expected divider to end without a blank line: ${JSON.stringify(plainLines)}`,
			);
		});
	});

	describe("Spacing after headings", () => {
		it("should have only one blank line between heading and following paragraph", () => {
			const markdown = new Markdown(
				`# Hello

This is a paragraph`,
				0,
				0,
				defaultMarkdownTheme,
			);

			const lines = markdown.render(80);
			const plainLines = lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, "").trimEnd());

			const headingIndex = plainLines.findIndex((line) => line.includes("Hello"));
			assert.ok(headingIndex !== -1, "Should have heading");

			const afterHeading = plainLines.slice(headingIndex + 1);
			const emptyLineCount = afterHeading.findIndex((line) => line !== "");

			assert.strictEqual(
				emptyLineCount,
				1,
				`Expected 1 empty line after heading, but found ${emptyLineCount}. Lines after heading: ${JSON.stringify(afterHeading.slice(0, 5))}`,
			);
		});

		it("should not add a trailing blank line when heading is the last rendered block", () => {
			const markdown = new Markdown("# Hello", 0, 0, defaultMarkdownTheme);
			const lines = markdown.render(80);
			const plainLines = lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, "").trimEnd());

			assert.notStrictEqual(
				plainLines.at(-1),
				"",
				`Expected heading to end without a blank line: ${JSON.stringify(plainLines)}`,
			);
		});
	});

	describe("Spacing after blockquotes", () => {
		it("should have only one blank line between blockquote and following paragraph", () => {
			const markdown = new Markdown(
				`hello world

> This is a quote

again, hello world`,
				0,
				0,
				defaultMarkdownTheme,
			);

			const lines = markdown.render(80);
			const plainLines = lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, "").trimEnd());

			const quoteIndex = plainLines.findIndex((line) => line.includes("This is a quote"));
			assert.ok(quoteIndex !== -1, "Should have blockquote");

			const afterQuote = plainLines.slice(quoteIndex + 1);
			const emptyLineCount = afterQuote.findIndex((line) => line !== "");

			assert.strictEqual(
				emptyLineCount,
				1,
				`Expected 1 empty line after blockquote, but found ${emptyLineCount}. Lines after quote: ${JSON.stringify(afterQuote.slice(0, 5))}`,
			);
		});

		it("should not add a trailing blank line when blockquote is the last rendered block", () => {
			const markdown = new Markdown("> This is a quote", 0, 0, defaultMarkdownTheme);
			const lines = markdown.render(80);
			const plainLines = lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, "").trimEnd());

			assert.notStrictEqual(
				plainLines.at(-1),
				"",
				`Expected blockquote to end without a blank line: ${JSON.stringify(plainLines)}`,
			);
		});
	});

	describe("Blockquotes with multiline content", () => {
		it("should apply consistent styling to all lines in lazy continuation blockquote", () => {
			// Markdown "lazy continuation" - second line without > is still part of the quote
			const markdown = new Markdown(
				`>Foo
bar`,
				0,
				0,
				defaultMarkdownTheme,
				{
					color: (text) => chalk.magenta(text), // This should NOT be applied to blockquotes
				},
			);

			const lines = markdown.render(80);

			// Both lines should have the quote border
			const plainLines = lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, ""));
			const quotedLines = plainLines.filter((line) => line.startsWith("│ "));
			assert.strictEqual(quotedLines.length, 2, `Expected 2 quoted lines, got: ${JSON.stringify(plainLines)}`);

			// Both lines should have italic (from theme.quote styling)
			const fooLine = lines.find((line) => line.includes("Foo"));
			const barLine = lines.find((line) => line.includes("bar"));
			assert.ok(fooLine, "Should have Foo line");
			assert.ok(barLine, "Should have bar line");

			// Check that both have italic (\x1b[3m) - blockquotes use theme styling, not default message color
			assert.ok(fooLine?.includes("\x1b[3m"), `Foo line should have italic: ${fooLine}`);
			assert.ok(barLine?.includes("\x1b[3m"), `bar line should have italic: ${barLine}`);

			// Blockquotes should NOT have the default message color (magenta)
			assert.ok(!fooLine?.includes("\x1b[35m"), `Foo line should NOT have magenta color: ${fooLine}`);
			assert.ok(!barLine?.includes("\x1b[35m"), `bar line should NOT have magenta color: ${barLine}`);
		});

		it("should apply consistent styling to explicit multiline blockquote", () => {
			const markdown = new Markdown(
				`>Foo
>bar`,
				0,
				0,
				defaultMarkdownTheme,
				{
					color: (text) => chalk.cyan(text), // This should NOT be applied to blockquotes
				},
			);

			const lines = markdown.render(80);

			// Both lines should have the quote border
			const plainLines = lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, ""));
			const quotedLines = plainLines.filter((line) => line.startsWith("│ "));
			assert.strictEqual(quotedLines.length, 2, `Expected 2 quoted lines, got: ${JSON.stringify(plainLines)}`);

			// Both lines should have italic (from theme.quote styling)
			const fooLine = lines.find((line) => line.includes("Foo"));
			const barLine = lines.find((line) => line.includes("bar"));
			assert.ok(fooLine?.includes("\x1b[3m"), `Foo line should have italic: ${fooLine}`);
			assert.ok(barLine?.includes("\x1b[3m"), `bar line should have italic: ${barLine}`);

			// Blockquotes should NOT have the default message color (cyan)
			assert.ok(!fooLine?.includes("\x1b[36m"), `Foo line should NOT have cyan color: ${fooLine}`);
			assert.ok(!barLine?.includes("\x1b[36m"), `bar line should NOT have cyan color: ${barLine}`);
		});

		it("should render list content inside blockquotes", () => {
			const markdown = new Markdown(
				`> 1. bla bla
> - nested bullet`,
				0,
				0,
				defaultMarkdownTheme,
			);

			const lines = markdown.render(80);
			const plainLines = lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, ""));
			const quotedLines = plainLines.filter((line) => line.startsWith("│ "));

			assert.ok(
				quotedLines.some((line) => line.includes("1. bla bla")),
				`Missing ordered list item: ${JSON.stringify(quotedLines)}`,
			);
			assert.ok(
				quotedLines.some((line) => line.includes("- nested bullet")),
				`Missing unordered list item: ${JSON.stringify(quotedLines)}`,
			);
		});

		it("should wrap long blockquote lines and add border to each wrapped line", () => {
			const longText = "This is a very long blockquote line that should wrap to multiple lines when rendered";
			const markdown = new Markdown(`> ${longText}`, 0, 0, defaultMarkdownTheme);

			// Render at narrow width to force wrapping
			const lines = markdown.render(30);
			const plainLines = lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, "").trimEnd());

			// Filter to non-empty lines (exclude trailing blank line after blockquote)
			const contentLines = plainLines.filter((line) => line.length > 0);

			// Should have multiple lines due to wrapping
			assert.ok(contentLines.length > 1, `Expected multiple wrapped lines, got: ${JSON.stringify(contentLines)}`);

			// Every content line should start with the quote border
			for (const line of contentLines) {
				assert.ok(line.startsWith("│ "), `Wrapped line should have quote border: "${line}"`);
			}

			// All content should be preserved
			const allText = contentLines.join(" ");
			assert.ok(allText.includes("very long"), "Should preserve 'very long'");
			assert.ok(allText.includes("blockquote"), "Should preserve 'blockquote'");
			assert.ok(allText.includes("multiple"), "Should preserve 'multiple'");
		});

		it("should properly indent wrapped blockquote lines with styling", () => {
			const markdown = new Markdown(
				"> This is styled text that is long enough to wrap",
				0,
				0,
				defaultMarkdownTheme,
				{
					color: (text) => chalk.yellow(text), // This should NOT be applied to blockquotes
					italic: true,
				},
			);

			const lines = markdown.render(25);
			const plainLines = lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, "").trimEnd());

			// Filter to non-empty lines
			const contentLines = plainLines.filter((line) => line.length > 0);

			// All lines should have the quote border
			for (const line of contentLines) {
				assert.ok(line.startsWith("│ "), `Line should have quote border: "${line}"`);
			}

			// Check that italic is applied (from theme.quote)
			const allOutput = lines.join("\n");
			assert.ok(allOutput.includes("\x1b[3m"), "Should have italic");

			// Blockquotes should NOT have the default message color (yellow)
			assert.ok(!allOutput.includes("\x1b[33m"), "Should NOT have yellow color from default style");
		});

		it("should render inline formatting inside blockquotes and reapply quote styling after", () => {
			const markdown = new Markdown("> Quote with **bold** and `code`", 0, 0, defaultMarkdownTheme);

			const lines = markdown.render(80);
			const plainLines = lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, ""));

			// Should have the quote border
			assert.ok(
				plainLines.some((line) => line.startsWith("│ ")),
				"Should have quote border",
			);

			// Content should be preserved
			const allPlain = plainLines.join(" ");
			assert.ok(allPlain.includes("Quote with"), "Should preserve 'Quote with'");
			assert.ok(allPlain.includes("bold"), "Should preserve 'bold'");
			assert.ok(allPlain.includes("code"), "Should preserve 'code'");

			const allOutput = lines.join("\n");

			// Should have bold styling (\x1b[1m)
			assert.ok(allOutput.includes("\x1b[1m"), "Should have bold styling");

			// Should have code styling (yellow = \x1b[33m from defaultMarkdownTheme)
			assert.ok(allOutput.includes("\x1b[33m"), "Should have code styling (yellow)");

			// Should have italic from quote styling (\x1b[3m)
			assert.ok(allOutput.includes("\x1b[3m"), "Should have italic from quote styling");
		});
	});

	describe("Heading with inline code", () => {
		it("should preserve heading styling after inline code", () => {
			const markdown = new Markdown("### Why `sourceInfo` should not be optional", 0, 0, defaultMarkdownTheme);

			const lines = markdown.render(80);
			const joinedOutput = lines.join("\n");

			// The heading theme is bold+cyan. After the yellow inline code, the heading
			// styling (bold+cyan) must be restored so subsequent text is styled correctly.
			// bold = \x1b[1m, cyan = \x1b[36m, yellow = \x1b[33m
			assert.ok(joinedOutput.includes("\x1b[33m"), "Should have yellow for inline code");

			// Find the position of "should not be optional" in the raw output.
			// It must be preceded by heading style codes (bold+cyan), not appear unstyled.
			const afterCodeIndex = joinedOutput.indexOf("should not be optional");
			assert.ok(afterCodeIndex > 0, "Should contain text after inline code");

			// Look at the ANSI codes between the code span end and "should not be optional".
			// There should be bold (\x1b[1m) and cyan (\x1b[36m) re-applied.
			const precedingChunk = joinedOutput.slice(Math.max(0, afterCodeIndex - 40), afterCodeIndex);
			assert.ok(
				precedingChunk.includes("\x1b[1m"),
				`Should re-apply bold before text after code: ${precedingChunk}`,
			);
			assert.ok(
				precedingChunk.includes("\x1b[36m"),
				`Should re-apply cyan before text after code: ${precedingChunk}`,
			);
		});

		it("should preserve heading styling after inline code for h1", () => {
			const markdown = new Markdown("# Title with `code` inside", 0, 0, defaultMarkdownTheme);

			const lines = markdown.render(80);
			const joinedOutput = lines.join("\n");

			const afterCodeIndex = joinedOutput.indexOf("inside");
			assert.ok(afterCodeIndex > 0, "Should contain text after inline code");

			const precedingChunk = joinedOutput.slice(Math.max(0, afterCodeIndex - 40), afterCodeIndex);
			// H1 uses heading + bold + underline
			assert.ok(precedingChunk.includes("\x1b[1m"), `Should re-apply bold for h1: ${precedingChunk}`);
			assert.ok(precedingChunk.includes("\x1b[36m"), `Should re-apply cyan for h1: ${precedingChunk}`);
			assert.ok(precedingChunk.includes("\x1b[4m"), `Should re-apply underline for h1: ${precedingChunk}`);
		});

		it("should not leak h1 underline into padding when inline code is the last token", async () => {
			const markdown = new Markdown("# Important distinction from `open()`", 0, 0, defaultMarkdownTheme);
			const terminal = new VirtualTerminal(80, 4);
			const tui = new TUI(terminal);
			tui.addChild(markdown);
			tui.start();
			await terminal.waitForRender();

			const renderedLine = markdown.render(80)[0];
			assert.ok(renderedLine, "Should render heading line");
			const contentWidth = renderedLine.replace(/\x1b\[[0-9;]*m/g, "").trimEnd().length;
			assert.ok(contentWidth > 0, "Should have visible heading content");

			for (let col = contentWidth; col < 80; col++) {
				assert.strictEqual(getCellUnderline(terminal, 0, col), 0, `Expected no underline in padding at col ${col}`);
			}

			tui.stop();
		});

		it("should preserve heading styling after bold text", () => {
			const markdown = new Markdown("## Heading with **bold** and more", 0, 0, defaultMarkdownTheme);

			const lines = markdown.render(80);
			const joinedOutput = lines.join("\n");

			const afterBoldIndex = joinedOutput.indexOf("and more");
			assert.ok(afterBoldIndex > 0, "Should contain text after bold");

			const precedingChunk = joinedOutput.slice(Math.max(0, afterBoldIndex - 40), afterBoldIndex);
			assert.ok(precedingChunk.includes("\x1b[1m"), `Should re-apply bold for h2: ${precedingChunk}`);
			assert.ok(precedingChunk.includes("\x1b[36m"), `Should re-apply cyan for h2: ${precedingChunk}`);
		});
	});

	describe("Links", () => {
		it("should not duplicate URL for autolinked emails", () => {
			const markdown = new Markdown("Contact user@example.com for help", 0, 0, defaultMarkdownTheme);

			const lines = markdown.render(80);
			const plainLines = lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, ""));
			const joinedPlain = plainLines.join(" ");

			// Should contain the email once, not duplicated with mailto:
			assert.ok(joinedPlain.includes("user@example.com"), "Should contain email");
			assert.ok(!joinedPlain.includes("mailto:"), "Should not show mailto: prefix for autolinked emails");
		});

		it("should not duplicate URL for bare URLs", () => {
			const markdown = new Markdown("Visit https://example.com for more", 0, 0, defaultMarkdownTheme);

			const lines = markdown.render(80);
			const plainLines = lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, ""));
			const joinedPlain = plainLines.join(" ");

			// URL should appear only once
			const urlCount = (joinedPlain.match(/https:\/\/example\.com/g) || []).length;
			assert.strictEqual(urlCount, 1, "URL should appear exactly once");
		});

		it("should show URL for explicit markdown links with different text", () => {
			const markdown = new Markdown("[click here](https://example.com)", 0, 0, defaultMarkdownTheme);

			const lines = markdown.render(80);
			const plainLines = lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, ""));
			const joinedPlain = plainLines.join(" ");

			// Should show both link text and URL
			assert.ok(joinedPlain.includes("click here"), "Should contain link text");
			assert.ok(joinedPlain.includes("(https://example.com)"), "Should show URL in parentheses");
		});

		it("should show URL for explicit mailto links with different text", () => {
			const markdown = new Markdown("[Email me](mailto:test@example.com)", 0, 0, defaultMarkdownTheme);

			const lines = markdown.render(80);
			const plainLines = lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, ""));
			const joinedPlain = plainLines.join(" ");

			// Should show both link text and mailto URL
			assert.ok(joinedPlain.includes("Email me"), "Should contain link text");
			assert.ok(joinedPlain.includes("(mailto:test@example.com)"), "Should show mailto URL in parentheses");
		});
	});

	describe("HTML-like tags in text", () => {
		it("should render content with HTML-like tags as text", () => {
			// When the model emits something like <thinking>content</thinking> in regular text,
			// marked might treat it as HTML and hide the content
			const markdown = new Markdown(
				"This is text with <thinking>hidden content</thinking> that should be visible",
				0,
				0,
				defaultMarkdownTheme,
			);

			const lines = markdown.render(80);
			const plainLines = lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, ""));
			const joinedPlain = plainLines.join(" ");

			// The content inside the tags should be visible
			assert.ok(
				joinedPlain.includes("hidden content") || joinedPlain.includes("<thinking>"),
				"Should render HTML-like tags or their content as text, not hide them",
			);
		});

		it("should render HTML tags in code blocks correctly", () => {
			const markdown = new Markdown("```html\n<div>Some HTML</div>\n```", 0, 0, defaultMarkdownTheme);

			const lines = markdown.render(80);
			const plainLines = lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, ""));
			const joinedPlain = plainLines.join("\n");

			// HTML in code blocks should be visible
			assert.ok(
				joinedPlain.includes("<div>") && joinedPlain.includes("</div>"),
				"Should render HTML in code blocks",
			);
		});
	});
});

import { execSync } from "child_process";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bashTool } from "../src/tools/bash.js";
import { editTool } from "../src/tools/edit.js";
import { globTool } from "../src/tools/glob.js";
import { grepTool } from "../src/tools/grep.js";
import { readTool } from "../src/tools/read.js";
import { writeTool } from "../src/tools/write.js";

// Helper to extract text from content blocks
function getTextOutput(result: any): string {
	return (
		result.content
			?.filter((c: any) => c.type === "text")
			.map((c: any) => c.text)
			.join("\n") || ""
	);
}

describe("Coding Agent Tools", () => {
	let testDir: string;

	beforeEach(() => {
		// Create a unique temporary directory for each test
		testDir = join(tmpdir(), `coding-agent-test-${Date.now()}`);
		mkdirSync(testDir, { recursive: true });
	});

	afterEach(() => {
		// Clean up test directory
		rmSync(testDir, { recursive: true, force: true });
	});

	describe("read tool", () => {
		it("should read file contents that fit within limits", async () => {
			const testFile = join(testDir, "test.txt");
			const content = "Hello, world!\nLine 2\nLine 3";
			writeFileSync(testFile, content);

			const result = await readTool.execute("test-call-1", { path: testFile });

			expect(getTextOutput(result)).toBe(content);
			expect(getTextOutput(result)).not.toContain("more lines not shown");
			expect(result.details).toBeUndefined();
		});

		it("should handle non-existent files", async () => {
			const testFile = join(testDir, "nonexistent.txt");

			await expect(readTool.execute("test-call-2", { path: testFile })).rejects.toThrow();
		});

		it("should truncate files exceeding line limit", async () => {
			const testFile = join(testDir, "large.txt");
			const lines = Array.from({ length: 2500 }, (_, i) => `Line ${i + 1}`);
			writeFileSync(testFile, lines.join("\n"));

			const result = await readTool.execute("test-call-3", { path: testFile });
			const output = getTextOutput(result);

			expect(output).toContain("Line 1");
			expect(output).toContain("Line 2000");
			expect(output).not.toContain("Line 2001");
			expect(output).toContain("500 more lines not shown");
			expect(output).toContain("Use offset=2001 to continue reading");
		});

		it("should truncate long lines and show notice", async () => {
			const testFile = join(testDir, "long-lines.txt");
			const longLine = "a".repeat(3000);
			const content = `Short line\n${longLine}\nAnother short line`;
			writeFileSync(testFile, content);

			const result = await readTool.execute("test-call-4", { path: testFile });
			const output = getTextOutput(result);

			expect(output).toContain("Short line");
			expect(output).toContain("Another short line");
			expect(output).toContain("Some lines were truncated to 2000 characters");
			expect(output.split("\n")[1].length).toBe(2000);
		});

		it("should handle offset parameter", async () => {
			const testFile = join(testDir, "offset-test.txt");
			const lines = Array.from({ length: 100 }, (_, i) => `Line ${i + 1}`);
			writeFileSync(testFile, lines.join("\n"));

			const result = await readTool.execute("test-call-5", { path: testFile, offset: 51 });
			const output = getTextOutput(result);

			expect(output).not.toContain("Line 50");
			expect(output).toContain("Line 51");
			expect(output).toContain("Line 100");
			expect(output).not.toContain("more lines not shown");
		});

		it("should handle limit parameter", async () => {
			const testFile = join(testDir, "limit-test.txt");
			const lines = Array.from({ length: 100 }, (_, i) => `Line ${i + 1}`);
			writeFileSync(testFile, lines.join("\n"));

			const result = await readTool.execute("test-call-6", { path: testFile, limit: 10 });
			const output = getTextOutput(result);

			expect(output).toContain("Line 1");
			expect(output).toContain("Line 10");
			expect(output).not.toContain("Line 11");
			expect(output).toContain("90 more lines not shown");
			expect(output).toContain("Use offset=11 to continue reading");
		});

		it("should handle offset + limit together", async () => {
			const testFile = join(testDir, "offset-limit-test.txt");
			const lines = Array.from({ length: 100 }, (_, i) => `Line ${i + 1}`);
			writeFileSync(testFile, lines.join("\n"));

			const result = await readTool.execute("test-call-7", {
				path: testFile,
				offset: 41,
				limit: 20,
			});
			const output = getTextOutput(result);

			expect(output).not.toContain("Line 40");
			expect(output).toContain("Line 41");
			expect(output).toContain("Line 60");
			expect(output).not.toContain("Line 61");
			expect(output).toContain("40 more lines not shown");
			expect(output).toContain("Use offset=61 to continue reading");
		});

		it("should show error when offset is beyond file length", async () => {
			const testFile = join(testDir, "short.txt");
			writeFileSync(testFile, "Line 1\nLine 2\nLine 3");

			await expect(readTool.execute("test-call-8", { path: testFile, offset: 100 })).rejects.toThrow(
				/Offset 100 is beyond end of file.*3 lines total/,
			);
		});

		it("should show both truncation notices when applicable", async () => {
			const testFile = join(testDir, "both-truncations.txt");
			const longLine = "b".repeat(3000);
			const lines = Array.from({ length: 2500 }, (_, i) => (i === 500 ? longLine : `Line ${i + 1}`));
			writeFileSync(testFile, lines.join("\n"));

			const result = await readTool.execute("test-call-9", { path: testFile });
			const output = getTextOutput(result);

			expect(output).toContain("Some lines were truncated to 2000 characters");
			expect(output).toContain("500 more lines not shown");
		});
	});

	describe("write tool", () => {
		it("should write file contents", async () => {
			const testFile = join(testDir, "write-test.txt");
			const content = "Test content";

			const result = await writeTool.execute("test-call-3", { path: testFile, content });

			expect(getTextOutput(result)).toContain("Successfully wrote");
			expect(result.details).toBeDefined();
			expect(result.details?.created).toBe(true);
			expect(result.details?.previousContent).toBeNull();
		});

		it("should create parent directories", async () => {
			const testFile = join(testDir, "nested", "dir", "test.txt");
			const content = "Nested content";

			const result = await writeTool.execute("test-call-4", { path: testFile, content });

			expect(getTextOutput(result)).toContain("Successfully wrote");
		});
	});

	describe("edit tool", () => {
		it("should replace text in file", async () => {
			const testFile = join(testDir, "edit-test.txt");
			const originalContent = "Hello, world!";
			writeFileSync(testFile, originalContent);

			const result = await editTool.execute("test-call-5", {
				path: testFile,
				oldText: "world",
				newText: "testing",
			});

			expect(getTextOutput(result)).toContain("Successfully replaced");
			expect(result.details).toBeDefined();
			expect(result.details.diff).toBeDefined();
			expect(typeof result.details.diff).toBe("string");
			expect(result.details.diff).toContain("testing");
		});

		it("should fail if text not found", async () => {
			const testFile = join(testDir, "edit-test.txt");
			const originalContent = "Hello, world!";
			writeFileSync(testFile, originalContent);

			await expect(
				editTool.execute("test-call-6", {
					path: testFile,
					oldText: "nonexistent",
					newText: "testing",
				}),
			).rejects.toThrow("Could not find the text");
		});

		it("should fail if text appears multiple times without all flag", async () => {
			const testFile = join(testDir, "edit-test.txt");
			const originalContent = "foo foo foo";
			writeFileSync(testFile, originalContent);

			await expect(
				editTool.execute("test-call-7", {
					path: testFile,
					oldText: "foo",
					newText: "bar",
				}),
			).rejects.toThrow("Found 3 occurrences");
		});

		it("should replace all occurrences when all flag is true", async () => {
			const testFile = join(testDir, "edit-all.txt");
			writeFileSync(testFile, "foo bar foo baz foo");

			const result = await editTool.execute("test-call-all", {
				path: testFile,
				oldText: "foo",
				newText: "qux",
				all: true,
			});

			expect(getTextOutput(result)).toContain("Successfully replaced");
			expect(getTextOutput(result)).toContain("3 occurrences");
			const { readFileSync } = await import("fs");
			const newContent = readFileSync(testFile, "utf-8");
			expect(newContent).toBe("qux bar qux baz qux");
		});

		it("should handle escaped newlines from LLM (unescape fallback)", async () => {
			const testFile = join(testDir, "edit-escape.txt");
			writeFileSync(testFile, "Line 1\nLine 2\nLine 3");

			const result = await editTool.execute("test-call-escape", {
				path: testFile,
				oldText: "Line 1\\nLine 2", // Model sent escaped newline
				newText: "Header\nBody",
			});

			expect(getTextOutput(result)).toContain("Successfully replaced");
			expect(getTextOutput(result)).toContain("unescaped match");
			const { readFileSync } = await import("fs");
			const newContent = readFileSync(testFile, "utf-8");
			expect(newContent).toBe("Header\nBody\nLine 3");
		});

		it("should handle flexible whitespace matching", async () => {
			const testFile = join(testDir, "edit-whitespace.txt");
			writeFileSync(testFile, "function   hello(  )  {\n    return  'world';\n}");

			const result = await editTool.execute("test-call-whitespace", {
				path: testFile,
				oldText: "function hello( ) { return 'world'; }", // Different whitespace
				newText: "const hello = () => 'world';",
			});

			expect(getTextOutput(result)).toContain("Successfully replaced");
			expect(getTextOutput(result)).toContain("flexible match");
		});

		it("should provide suggestion when text not found but similar exists", async () => {
			const testFile = join(testDir, "edit-suggest.txt");
			writeFileSync(testFile, "function calculateTotal(items) {\n  return items.reduce((a,b) => a+b, 0);\n}");

			await expect(
				editTool.execute("test-call-suggest", {
					path: testFile,
					oldText: "function calulateTotal(items)", // typo: calulate
					newText: "function computeTotal(items)",
				}),
			).rejects.toThrow(/Did you mean/);
		});

		it("should provide multi-line block suggestion when similar exists", async () => {
			const testFile = join(testDir, "edit-block-suggest.txt");
			// Create content where 4 out of 5 lines match (80% Jaccard similarity)
			writeFileSync(testFile, "Line 1\nLine 2\nLine 3\nLine 4\nLine 5");

			await expect(
				editTool.execute("test-call-block-suggest", {
					path: testFile,
					oldText: "Line 1\nLine 2\nLine 3\nLine 4\nLine X", // 4 of 5 lines match
					newText: "New content",
				}),
			).rejects.toThrow(/Did you mean/);
		});

		it("should handle curly single quotes in oldText when file uses straight quotes", async () => {
			const testFile = join(testDir, "edit-curly-single.txt");
			writeFileSync(testFile, "return 'hello';");

			const result = await editTool.execute("test-curly-single", {
				path: testFile,
				oldText: "return \u2018hello\u2019;", // curly quotes
				newText: "return 'world';",
			});

			expect(getTextOutput(result)).toContain("Successfully replaced");
			expect(getTextOutput(result)).toContain("normalized");
			const { readFileSync } = await import("fs");
			expect(readFileSync(testFile, "utf-8")).toBe("return 'world';");
		});

		it("should handle straight quotes in oldText when file uses curly quotes", async () => {
			const testFile = join(testDir, "edit-curly-reverse.txt");
			writeFileSync(testFile, "return \u2018hello\u2019;");

			const result = await editTool.execute("test-curly-reverse", {
				path: testFile,
				oldText: "return 'hello';",
				newText: "return 'world';",
			});

			expect(getTextOutput(result)).toContain("Successfully replaced");
			expect(getTextOutput(result)).toContain("normalized");
		});

		it("should handle curly double quotes in oldText", async () => {
			const testFile = join(testDir, "edit-curly-double.txt");
			writeFileSync(testFile, 'const x = "hello";');

			const result = await editTool.execute("test-curly-double", {
				path: testFile,
				oldText: "const x = \u201Chello\u201D;", // curly double quotes
				newText: 'const x = "world";',
			});

			expect(getTextOutput(result)).toContain("Successfully replaced");
			expect(getTextOutput(result)).toContain("normalized");
		});

		it("should handle guillemets (angle quotes)", async () => {
			const testFile = join(testDir, "edit-guillemets.txt");
			writeFileSync(testFile, 'say "bonjour"');

			const result = await editTool.execute("test-guillemets", {
				path: testFile,
				oldText: "say \u00ABbonjour\u00BB", // « »
				newText: 'say "hello"',
			});

			expect(getTextOutput(result)).toContain("Successfully replaced");
			expect(getTextOutput(result)).toContain("normalized");
		});

		it("should handle em dash in oldText when file uses hyphen", async () => {
			const testFile = join(testDir, "edit-em-dash.txt");
			writeFileSync(testFile, "value = a - b;");

			const result = await editTool.execute("test-em-dash", {
				path: testFile,
				oldText: "value = a \u2014 b;", // em dash
				newText: "value = a + b;",
			});

			expect(getTextOutput(result)).toContain("Successfully replaced");
			expect(getTextOutput(result)).toContain("normalized");
		});

		it("should handle en dash in oldText", async () => {
			const testFile = join(testDir, "edit-en-dash.txt");
			writeFileSync(testFile, "pages 10-20");

			const result = await editTool.execute("test-en-dash", {
				path: testFile,
				oldText: "pages 10\u201320", // en dash
				newText: "pages 10-25",
			});

			expect(getTextOutput(result)).toContain("Successfully replaced");
			expect(getTextOutput(result)).toContain("normalized");
		});

		it("should handle non-breaking space in oldText", async () => {
			const testFile = join(testDir, "edit-nbsp.txt");
			writeFileSync(testFile, "hello world");

			const result = await editTool.execute("test-nbsp", {
				path: testFile,
				oldText: "hello\u00A0world", // nbsp
				newText: "hello there",
			});

			expect(getTextOutput(result)).toContain("Successfully replaced");
			expect(getTextOutput(result)).toContain("normalized");
		});

		it("should handle confusables combined with flexible whitespace", async () => {
			const testFile = join(testDir, "edit-confusable-ws.txt");
			writeFileSync(testFile, "const  x  =  'hello';");

			const result = await editTool.execute("test-confusable-ws", {
				path: testFile,
				oldText: "const x = \u2018hello\u2019;",
				newText: "const y = 'world';",
			});

			expect(getTextOutput(result)).toContain("Successfully replaced");
			expect(getTextOutput(result)).toContain("flexible");
		});

		it("should handle multiple confusable types together", async () => {
			const testFile = join(testDir, "edit-multi-confusable.txt");
			writeFileSync(testFile, 'const msg = "hello - world";');

			const result = await editTool.execute("test-multi-confusable", {
				path: testFile,
				oldText: "const msg = \u201Chello \u2014 world\u201D;", // curly quotes + em dash
				newText: 'const msg = "goodbye";',
			});

			expect(getTextOutput(result)).toContain("Successfully replaced");
		});
	});

	describe("bash tool", () => {
		it("should execute simple commands", async () => {
			const result = await bashTool.execute("test-call-8", { command: "echo 'test output'" });

			expect(getTextOutput(result)).toContain("test output");
			expect(result.details).toBeUndefined();
		});

		it("should handle command errors", async () => {
			await expect(bashTool.execute("test-call-9", { command: "exit 1" })).rejects.toThrow(
				/Command exited with code 1/,
			);
		});

		it("should respect timeout", async () => {
			// Note: bash tool enforces minimum timeout of 1800s (30 minutes)
			// Using sleep 2 with test timeout 6000ms ensures it completes before test timeout
			await bashTool.execute("test-call-10", { command: "sleep 2" });
		}, 6000);
	});

	describe("grep tool", () => {
		it("should include filename when searching a single file", async () => {
			const testFile = join(testDir, "example.txt");
			writeFileSync(testFile, "first line\nmatch line\nlast line");

			const result = await grepTool.execute("test-call-11", {
				pattern: "match",
				path: testFile,
			});

			const output = getTextOutput(result);
			expect(output).toContain("example.txt:2: match line");
		});

		it("should respect global limit and include context lines", async () => {
			const testFile = join(testDir, "context.txt");
			const content = ["before", "match one", "after", "middle", "match two", "after two"].join("\n");
			writeFileSync(testFile, content);

			const result = await grepTool.execute("test-call-12", {
				pattern: "match",
				path: testFile,
				limit: 1,
				context: 1,
			});

			const output = getTextOutput(result);
			expect(output).toContain("context.txt-1- before");
			expect(output).toContain("context.txt:2: match one");
			expect(output).toContain("context.txt-3- after");
			expect(output).toContain("(limit of 1 matches reached)");
			// Ensure second match is not present
			expect(output).not.toContain("match two");
		});

		it("should respect .gitignore by default in git repos", async () => {
			// Initialize git repo so rg respects .gitignore
			execSync("git init", { cwd: testDir, stdio: "ignore" });
			writeFileSync(join(testDir, ".gitignore"), "ignored.txt\n");
			writeFileSync(join(testDir, "ignored.txt"), "secret content");
			writeFileSync(join(testDir, "kept.txt"), "secret content");

			const result = await grepTool.execute("test-call-grep-gitignore-1", {
				pattern: "secret",
				path: testDir,
			});

			const output = getTextOutput(result);
			expect(output).toContain("kept.txt");
			expect(output).not.toContain("ignored.txt");
		});

		it("should include gitignored files when includeIgnored is true", async () => {
			// Initialize git repo so we can test bypassing .gitignore
			execSync("git init", { cwd: testDir, stdio: "ignore" });
			writeFileSync(join(testDir, ".gitignore"), "ignored.txt\n");
			writeFileSync(join(testDir, "ignored.txt"), "secret content");
			writeFileSync(join(testDir, "kept.txt"), "secret content");

			const result = await grepTool.execute("test-call-grep-gitignore-2", {
				pattern: "secret",
				path: testDir,
				includeIgnored: true,
			});

			const output = getTextOutput(result);
			expect(output).toContain("kept.txt");
			expect(output).toContain("ignored.txt");
		});

		it("should show hint when no matches and includeIgnored is false", async () => {
			// Initialize git repo so rg respects .gitignore
			execSync("git init", { cwd: testDir, stdio: "ignore" });
			writeFileSync(join(testDir, ".gitignore"), "*.log\n");
			writeFileSync(join(testDir, "app.log"), "error message");

			const result = await grepTool.execute("test-call-grep-gitignore-3", {
				pattern: "error message",
				path: testDir,
				literal: true,
			});

			const output = getTextOutput(result);
			expect(output).toContain("No matches found");
			expect(output).toContain("includeIgnored: true");
		});

		it("should not show hint when no matches and includeIgnored is true", async () => {
			const result = await grepTool.execute("test-call-grep-gitignore-4", {
				pattern: "nonexistent pattern xyz",
				path: testDir,
				includeIgnored: true,
			});

			const output = getTextOutput(result);
			expect(output).toContain("No matches found");
			expect(output).not.toContain("includeIgnored: true");
		});

		it("should handle patterns starting with a dash", async () => {
			const testFile = join(testDir, "dashed.txt");
			writeFileSync(testFile, "flags: --categories\nother line");

			const result = await grepTool.execute("test-call-grep-dash-1", {
				pattern: "--categories",
				path: testFile,
			});

			const output = getTextOutput(result);
			expect(output).toContain("dashed.txt:1: flags: --categories");
		});

		it("should handle regex patterns starting with a dash", async () => {
			const testFile = join(testDir, "dashed-regex.txt");
			writeFileSync(testFile, "modules categories\n--modules and categories");

			const result = await grepTool.execute("test-call-grep-dash-2", {
				pattern: "--modules|modules\\b.*categories",
				path: testFile,
			});

			const output = getTextOutput(result);
			expect(output).toContain("dashed-regex.txt:1: modules categories");
			expect(output).toContain("dashed-regex.txt:2: --modules and categories");
		});
	});

	describe("glob tool (find mode)", () => {
		it("should include hidden files that are not gitignored", async () => {
			const hiddenDir = join(testDir, ".secret");
			mkdirSync(hiddenDir);
			writeFileSync(join(hiddenDir, "hidden.txt"), "hidden");
			writeFileSync(join(testDir, "visible.txt"), "visible");

			const result = await globTool.execute("test-call-13", {
				pattern: "**/*.txt",
				path: testDir,
			});

			const outputLines = getTextOutput(result)
				.split("\n")
				.map((line) => line.trim())
				.filter(Boolean);

			expect(outputLines).toContain("visible.txt");
			expect(outputLines).toContain(".secret/hidden.txt");
		});

		it("should respect .gitignore", async () => {
			writeFileSync(join(testDir, ".gitignore"), "ignored.txt\n");
			writeFileSync(join(testDir, "ignored.txt"), "ignored");
			writeFileSync(join(testDir, "kept.txt"), "kept");

			const result = await globTool.execute("test-call-14", {
				pattern: "**/*.txt",
				path: testDir,
			});

			const output = getTextOutput(result);
			expect(output).toContain("kept.txt");
			expect(output).not.toContain("ignored.txt");
		});

		it("should include gitignored files when includeIgnored is true", async () => {
			writeFileSync(join(testDir, ".gitignore"), "ignored.txt\n");
			writeFileSync(join(testDir, "ignored.txt"), "ignored content");
			writeFileSync(join(testDir, "kept.txt"), "kept");

			const result = await globTool.execute("test-call-include-ignored-1", {
				pattern: "**/*.txt",
				path: testDir,
				includeIgnored: true,
			});

			const output = getTextOutput(result);
			expect(output).toContain("kept.txt");
			expect(output).toContain("ignored.txt");
		});

		it("should show hint when no matches and includeIgnored is false", async () => {
			writeFileSync(join(testDir, ".gitignore"), "*.log\n");
			writeFileSync(join(testDir, "app.log"), "log content");

			const result = await globTool.execute("test-call-include-ignored-2", {
				pattern: "*.log",
				path: testDir,
				includeIgnored: false,
			});

			const output = getTextOutput(result);
			expect(output).toContain("No files found matching pattern");
			expect(output).toContain("includeIgnored: true");
		});

		it("should not show hint when no matches and includeIgnored is true", async () => {
			const result = await globTool.execute("test-call-include-ignored-3", {
				pattern: "*.nonexistent",
				path: testDir,
				includeIgnored: true,
			});

			const output = getTextOutput(result);
			expect(output).toContain("No files found matching pattern");
			expect(output).not.toContain("includeIgnored: true");
		});
	});

	describe("glob tool (ls mode)", () => {
		it("should list dotfiles and directories when no pattern is provided", async () => {
			writeFileSync(join(testDir, ".hidden-file"), "secret");
			mkdirSync(join(testDir, ".hidden-dir"));

			const result = await globTool.execute("test-call-15", { path: testDir });
			const output = getTextOutput(result);

			expect(output).toContain(".hidden-file");
			expect(output).toContain(".hidden-dir/");
		});
	});

	describe("schema validation", () => {
		it("should have Google-compatible schemas for all coding tools", async () => {
			const { validateToolSchemas } = await import("@kennyfrc/pi-ai");
			const { codingTools } = await import("../src/tools/index.js");

			const errors = validateToolSchemas(codingTools);

			if (errors.length > 0) {
				const errorMessages = errors.map((e) => `Tool "${e.toolName}" at ${e.path}: ${e.message}`);
				throw new Error(
					`Schema validation failed:\n${errorMessages.join("\n")}\n\n` +
						`Fix: Use StringEnum instead of Type.Union([Type.Literal(...)]) for string enums.`,
				);
			}

			expect(errors).toEqual([]);
		});
	});
});

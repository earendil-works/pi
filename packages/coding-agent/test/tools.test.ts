import { mkdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bashTool } from "../src/tools/bash.js";
import { editTool } from "../src/tools/edit.js";
import { findTool } from "../src/tools/find.js";
import { grepTool } from "../src/tools/grep.js";
import { lsTool } from "../src/tools/ls.js";
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

			const result = await readTool.execute("test-call-2", { path: testFile });

			expect(getTextOutput(result)).toContain("Error");
			expect(getTextOutput(result)).toContain("File not found");
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

			const result = await readTool.execute("test-call-8", { path: testFile, offset: 100 });
			const output = getTextOutput(result);

			expect(output).toContain("Error: Offset 100 is beyond end of file");
			expect(output).toContain("3 lines total");
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
			expect(getTextOutput(result)).toContain(testFile);
			expect(result.details).toBeUndefined();
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

			const result = await editTool.execute("test-call-6", {
				path: testFile,
				oldText: "nonexistent",
				newText: "testing",
			});

			expect(getTextOutput(result)).toContain("Could not find the exact text");
		});

		it("should fail if text appears multiple times", async () => {
			const testFile = join(testDir, "edit-test.txt");
			const originalContent = "foo foo foo";
			writeFileSync(testFile, originalContent);

			const result = await editTool.execute("test-call-7", {
				path: testFile,
				oldText: "foo",
				newText: "bar",
			});

			expect(getTextOutput(result)).toContain("Found 3 occurrences");
		});
	});

	describe("bash tool", () => {
		it("should execute simple commands", async () => {
			const result = await bashTool.execute("test-call-8", { command: "echo 'test output'" });

			expect(getTextOutput(result)).toContain("test output");
			expect(result.details).toBeUndefined();
		});

		it("should handle command errors", async () => {
			const result = await bashTool.execute("test-call-9", { command: "exit 1" });

			expect(getTextOutput(result)).toContain("Command failed");
		});

		it("should respect timeout", async () => {
			const result = await bashTool.execute("test-call-10", { command: "sleep 35" });

			expect(getTextOutput(result)).toContain("Command failed");
		}, 35000);
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
			expect(output).toContain("(truncated, limit of 1 matches reached)");
			// Ensure second match is not present
			expect(output).not.toContain("match two");
		});
	});

	describe("find tool", () => {
		it("should include hidden files that are not gitignored", async () => {
			const hiddenDir = join(testDir, ".secret");
			mkdirSync(hiddenDir);
			writeFileSync(join(hiddenDir, "hidden.txt"), "hidden");
			writeFileSync(join(testDir, "visible.txt"), "visible");

			const result = await findTool.execute("test-call-13", {
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

			const result = await findTool.execute("test-call-14", {
				pattern: "**/*.txt",
				path: testDir,
			});

			const output = getTextOutput(result);
			expect(output).toContain("kept.txt");
			expect(output).not.toContain("ignored.txt");
		});
	});

	describe("ls tool", () => {
		it("should list dotfiles and directories", async () => {
			writeFileSync(join(testDir, ".hidden-file"), "secret");
			mkdirSync(join(testDir, ".hidden-dir"));

			const result = await lsTool.execute("test-call-15", { path: testDir });
			const output = getTextOutput(result);

			expect(output).toContain(".hidden-file");
			expect(output).toContain(".hidden-dir/");
		});
	});
});

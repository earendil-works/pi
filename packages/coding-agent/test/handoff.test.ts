import type { TextContent } from "@kennyfrc/mu-ai";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	buildHandoffMessage,
	countScripts,
	estimateTokens,
	expandPath,
	extractLines,
	type FileResult,
	type FileSlice,
	formatFileBlock,
	formatFileContext,
	formatSlice,
	type HandoffDetails,
	handoffTool,
	parseSlice,
} from "../src/tools/handoff.js";

// Tool result type with optional isError flag (extends AgentToolResult)
interface ToolResult {
	content: TextContent[];
	details: HandoffDetails;
	isError?: boolean;
}

// -----------------------------------------------------------------------------
// parseSlice tests
// -----------------------------------------------------------------------------

describe("parseSlice", () => {
	it("parses full file (no colon)", () => {
		const result = parseSlice("src/foo.ts");
		expect(result).toEqual({ path: "src/foo.ts", sliceType: "full" });
	});

	it("parses single line", () => {
		const result = parseSlice("src/foo.ts:42");
		expect(result).toEqual({ path: "src/foo.ts", sliceType: "single-line", startLine: 42 });
	});

	it("parses line range", () => {
		const result = parseSlice("src/foo.ts:10-50");
		expect(result).toEqual({ path: "src/foo.ts", sliceType: "range", startLine: 10, endLine: 50 });
	});

	it("parses infinite range (no end)", () => {
		const result = parseSlice("src/foo.ts:100-");
		expect(result).toEqual({ path: "src/foo.ts", sliceType: "infinite-range", startLine: 100 });
	});

	it("handles Windows paths correctly", () => {
		// The non-greedy regex should not match the drive letter colon
		const result = parseSlice("C:\\Users\\test\\file.ts:10-20");
		expect(result).toEqual({
			path: "C:\\Users\\test\\file.ts",
			sliceType: "range",
			startLine: 10,
			endLine: 20,
		});
	});

	it("falls back to full file for invalid start line", () => {
		const result = parseSlice("file.ts:0");
		expect(result).toEqual({ path: "file.ts:0", sliceType: "full" });
	});

	it("falls back to full file for invalid range (end < start)", () => {
		const result = parseSlice("file.ts:50-10");
		expect(result).toEqual({ path: "file.ts:50-10", sliceType: "full" });
	});

	it("handles paths with multiple colons (URL-like)", () => {
		// Edge case: paths that look like URLs
		const result = parseSlice("http://example.com/file.ts");
		expect(result.sliceType).toBe("full");
	});
});

// -----------------------------------------------------------------------------
// formatSlice tests
// -----------------------------------------------------------------------------

describe("formatSlice", () => {
	it("formats full file", () => {
		const slice: FileSlice = { path: "src/foo.ts", sliceType: "full" };
		expect(formatSlice(slice)).toBe("src/foo.ts");
	});

	it("formats single line", () => {
		const slice: FileSlice = { path: "src/foo.ts", sliceType: "single-line", startLine: 42 };
		expect(formatSlice(slice)).toBe("src/foo.ts:42");
	});

	it("formats range", () => {
		const slice: FileSlice = { path: "src/foo.ts", sliceType: "range", startLine: 10, endLine: 50 };
		expect(formatSlice(slice)).toBe("src/foo.ts:10-50");
	});

	it("formats infinite range", () => {
		const slice: FileSlice = { path: "src/foo.ts", sliceType: "infinite-range", startLine: 100 };
		expect(formatSlice(slice)).toBe("src/foo.ts:100-");
	});

	it("round-trips with parseSlice", () => {
		const inputs = ["src/foo.ts", "src/foo.ts:42", "src/foo.ts:10-50", "src/foo.ts:100-"];

		for (const input of inputs) {
			const parsed = parseSlice(input);
			const formatted = formatSlice(parsed);
			expect(formatted).toBe(input);
		}
	});
});

// -----------------------------------------------------------------------------
// expandPath tests
// -----------------------------------------------------------------------------

describe("expandPath", () => {
	it("expands ~ alone to home directory", () => {
		const result = expandPath("~");
		expect(result).toBe(process.env.HOME || require("os").homedir());
	});

	it("expands ~/ prefix", () => {
		const result = expandPath("~/Documents/file.ts");
		expect(result).toMatch(/^\/.*\/Documents\/file\.ts$/);
		expect(result).not.toContain("~");
	});

	it("leaves absolute paths unchanged", () => {
		const result = expandPath("/usr/local/bin/file.ts");
		expect(result).toBe("/usr/local/bin/file.ts");
	});

	it("leaves relative paths unchanged", () => {
		const result = expandPath("src/foo.ts");
		expect(result).toBe("src/foo.ts");
	});
});

// -----------------------------------------------------------------------------
// extractLines tests
// -----------------------------------------------------------------------------

describe("extractLines", () => {
	const content = "line1\nline2\nline3\nline4\nline5";

	it("returns full content for full slice", () => {
		const slice: FileSlice = { path: "test.ts", sliceType: "full" };
		expect(extractLines(content, slice)).toBe(content);
	});

	it("extracts single line (1-indexed)", () => {
		const slice: FileSlice = { path: "test.ts", sliceType: "single-line", startLine: 2 };
		expect(extractLines(content, slice)).toBe("line2");
	});

	it("extracts first line", () => {
		const slice: FileSlice = { path: "test.ts", sliceType: "single-line", startLine: 1 };
		expect(extractLines(content, slice)).toBe("line1");
	});

	it("extracts line range (inclusive)", () => {
		const slice: FileSlice = { path: "test.ts", sliceType: "range", startLine: 2, endLine: 4 };
		expect(extractLines(content, slice)).toBe("line2\nline3\nline4");
	});

	it("extracts infinite range to end", () => {
		const slice: FileSlice = { path: "test.ts", sliceType: "infinite-range", startLine: 3 };
		expect(extractLines(content, slice)).toBe("line3\nline4\nline5");
	});

	it("returns empty string for out-of-bounds single line", () => {
		const slice: FileSlice = { path: "test.ts", sliceType: "single-line", startLine: 100 };
		expect(extractLines(content, slice)).toBe("");
	});

	it("handles empty content", () => {
		const slice: FileSlice = { path: "test.ts", sliceType: "range", startLine: 1, endLine: 5 };
		expect(extractLines("", slice)).toBe("");
	});
});

// -----------------------------------------------------------------------------
// Token estimation tests
// -----------------------------------------------------------------------------

describe("countScripts", () => {
	it("counts Latin characters", () => {
		const result = countScripts("Hello World");
		expect(result.latin).toBe(10); // Excludes space
		expect(result.other).toBe(1); // Space
	});

	it("counts CJK characters", () => {
		const result = countScripts("你好世界");
		expect(result.cjk).toBe(4);
	});

	it("counts mixed content", () => {
		const result = countScripts("Hello 你好");
		expect(result.latin).toBe(5);
		expect(result.cjk).toBe(2);
		expect(result.other).toBe(1); // space
	});

	it("handles empty string", () => {
		const result = countScripts("");
		expect(result.latin).toBe(0);
		expect(result.cjk).toBe(0);
		expect(result.other).toBe(0);
	});
});

describe("estimateTokens", () => {
	it("returns 0 for empty string", () => {
		expect(estimateTokens("")).toBe(0);
	});

	it("estimates ~4 chars/token for English text", () => {
		// 100 chars of English should be ~25 tokens + 15% buffer ≈ 29 tokens
		const text = "a".repeat(100);
		const estimate = estimateTokens(text);
		expect(estimate).toBeGreaterThan(20);
		expect(estimate).toBeLessThan(40);
	});

	it("estimates higher token count for CJK text", () => {
		// CJK: ~0.6 chars/token means 10 chars ≈ 17 tokens + buffer
		const cjk = "你".repeat(10);
		const latin = "a".repeat(10);

		const cjkEstimate = estimateTokens(cjk);
		const latinEstimate = estimateTokens(latin);

		// CJK should estimate significantly higher
		expect(cjkEstimate).toBeGreaterThan(latinEstimate * 3);
	});

	it("includes safety buffer", () => {
		const text = "a".repeat(400); // 100 base tokens
		const estimate = estimateTokens(text);
		// With 15% buffer, should be more than 100
		expect(estimate).toBeGreaterThan(100);
	});
});

// -----------------------------------------------------------------------------
// Formatting tests
// -----------------------------------------------------------------------------

describe("formatFileBlock", () => {
	it("formats full file without line info", () => {
		const result: FileResult = {
			slice: { path: "src/foo.ts", sliceType: "full" },
			content: "const x = 1;",
			tokens: 10,
		};
		const formatted = formatFileBlock(result);
		expect(formatted).toContain("File: src/foo.ts");
		expect(formatted).not.toContain("lines");
		expect(formatted).toContain("const x = 1;");
	});

	it("formats single line with line info", () => {
		const result: FileResult = {
			slice: { path: "src/foo.ts", sliceType: "single-line", startLine: 42 },
			content: "const x = 1;",
			tokens: 10,
		};
		const formatted = formatFileBlock(result);
		expect(formatted).toContain("File: src/foo.ts (line 42)");
	});

	it("formats range with line info", () => {
		const result: FileResult = {
			slice: { path: "src/foo.ts", sliceType: "range", startLine: 10, endLine: 50 },
			content: "const x = 1;",
			tokens: 10,
		};
		const formatted = formatFileBlock(result);
		expect(formatted).toContain("File: src/foo.ts (lines 10-50)");
	});

	it("formats infinite range with line info", () => {
		const result: FileResult = {
			slice: { path: "src/foo.ts", sliceType: "infinite-range", startLine: 100 },
			content: "const x = 1;",
			tokens: 10,
		};
		const formatted = formatFileBlock(result);
		expect(formatted).toContain("File: src/foo.ts (lines 100-end)");
	});
});

describe("formatFileContext", () => {
	it("returns empty string for no files", () => {
		expect(formatFileContext([])).toBe("");
	});

	it("wraps files in file_context tags", () => {
		const results: FileResult[] = [
			{
				slice: { path: "a.ts", sliceType: "full" },
				content: "const a = 1;",
				tokens: 5,
			},
		];
		const formatted = formatFileContext(results);
		expect(formatted).toMatch(/^<file_context>/);
		expect(formatted).toMatch(/<\/file_context>$/);
	});

	it("includes all file blocks", () => {
		const results: FileResult[] = [
			{ slice: { path: "a.ts", sliceType: "full" }, content: "a", tokens: 1 },
			{ slice: { path: "b.ts", sliceType: "full" }, content: "b", tokens: 1 },
		];
		const formatted = formatFileContext(results);
		expect(formatted).toContain("File: a.ts");
		expect(formatted).toContain("File: b.ts");
	});
});

describe("buildHandoffMessage", () => {
	it("includes goal in header", () => {
		const message = buildHandoffMessage("Implement feature X", "<file_context></file_context>", null);
		expect(message).toContain("# Handoff: Implement feature X");
	});

	it("includes parent thread reference when provided", () => {
		const message = buildHandoffMessage("Goal", "<files>", "abc-123");
		expect(message).toContain("**Parent Thread:** `abc-123`");
		expect(message).toContain("read_thread");
	});

	it("omits parent thread section when null", () => {
		const message = buildHandoffMessage("Goal", "<files>", null);
		expect(message).not.toContain("Parent Thread");
	});

	it("includes file context", () => {
		const fileContext = "<file_context>\ntest content\n</file_context>";
		const message = buildHandoffMessage("Goal", fileContext, null);
		expect(message).toContain(fileContext);
	});

	it("includes instructions for the new session", () => {
		const message = buildHandoffMessage("Goal", "<files>", null);
		expect(message).toContain("Begin working on the goal");
	});
});

// -----------------------------------------------------------------------------
// Tool execution tests
// -----------------------------------------------------------------------------

describe("handoffTool.execute", () => {
	const testDir = join(tmpdir(), "handoff-test-" + Date.now());

	beforeAll(() => {
		mkdirSync(testDir, { recursive: true });
		writeFileSync(join(testDir, "small.ts"), "const x = 1;\nconst y = 2;\nconst z = 3;");
		writeFileSync(join(testDir, "medium.ts"), "line\n".repeat(100));

		// Create a file that would exceed token limit alone
		writeFileSync(join(testDir, "huge.ts"), "x".repeat(500000));
	});

	afterAll(() => {
		rmSync(testDir, { recursive: true, force: true });
	});

	it("succeeds with valid files under token limit", async () => {
		const result = (await handoffTool.execute("test-call", {
			goal: "Test goal",
			files: [join(testDir, "small.ts")],
		})) as ToolResult;

		expect(result.isError).toBeFalsy();
		expect(result.details).toBeDefined();
		expect(result.details.handoffType).toBe("explicit");
		expect(result.details.goal).toBe("Test goal");
		expect(result.details.formattedMessage).toContain("const x = 1");
		expect(result.details.fileTokens).toBeGreaterThan(0);
	});

	it("returns error for missing file", async () => {
		const result = (await handoffTool.execute("test-call", {
			goal: "Test goal",
			files: [join(testDir, "nonexistent.ts")],
		})) as ToolResult;

		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain("File not found");
	});

	it("returns error when exceeding token limit", async () => {
		const result = (await handoffTool.execute("test-call", {
			goal: "Test goal",
			files: [join(testDir, "huge.ts")],
			token_limit: 1000,
		})) as ToolResult;

		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain("exceed");
		expect(result.content[0].text).toContain("token limit");
		expect(result.content[0].text).toContain("Suggestions");
	});

	it("handles line range selection", async () => {
		const result = (await handoffTool.execute("test-call", {
			goal: "Test goal",
			files: [`${join(testDir, "small.ts")}:1-2`],
		})) as ToolResult;

		expect(result.isError).toBeFalsy();
		expect(result.details.formattedMessage).toContain("const x = 1");
		expect(result.details.formattedMessage).toContain("const y = 2");
		expect(result.details.formattedMessage).not.toContain("const z = 3");
	});

	it("handles single line selection", async () => {
		const result = (await handoffTool.execute("test-call", {
			goal: "Test goal",
			files: [`${join(testDir, "small.ts")}:2`],
		})) as ToolResult;

		expect(result.isError).toBeFalsy();
		expect(result.details.formattedMessage).toContain("const y = 2");
		expect(result.details.formattedMessage).not.toContain("const x = 1");
	});

	it("respects custom token limit", async () => {
		// medium.ts has 100 lines, should be under default 100k but may exceed low limit
		const result = (await handoffTool.execute("test-call", {
			goal: "Test goal",
			files: [join(testDir, "medium.ts")],
			token_limit: 10, // Very low limit
		})) as ToolResult;

		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain("10"); // Shows the limit
	});

	it("handles multiple files", async () => {
		const result = (await handoffTool.execute("test-call", {
			goal: "Test goal",
			files: [join(testDir, "small.ts"), `${join(testDir, "medium.ts")}:1-5`],
		})) as ToolResult;

		expect(result.isError).toBeFalsy();
		expect(result.details.formattedMessage).toContain("small.ts");
		expect(result.details.formattedMessage).toContain("medium.ts");
	});

	it("reports token count in success message", async () => {
		const result = (await handoffTool.execute("test-call", {
			goal: "Test goal",
			files: [join(testDir, "small.ts")],
		})) as ToolResult;

		expect(result.isError).toBeFalsy();
		expect(result.content[0].text).toMatch(/\d+ tokens/);
		expect(result.content[0].text).toContain("1 file(s)");
	});

	it("throws on abort signal", async () => {
		const controller = new AbortController();
		controller.abort();

		await expect(
			handoffTool.execute(
				"test-call",
				{
					goal: "Test goal",
					files: [join(testDir, "small.ts")],
				},
				controller.signal,
			),
		).rejects.toThrow("Aborted");
	});

	it("handles infinite range selection", async () => {
		const result = (await handoffTool.execute("test-call", {
			goal: "Test goal",
			files: [`${join(testDir, "small.ts")}:2-`],
		})) as ToolResult;

		expect(result.isError).toBeFalsy();
		expect(result.details.formattedMessage).toContain("const y = 2");
		expect(result.details.formattedMessage).toContain("const z = 3");
		expect(result.details.formattedMessage).not.toContain("const x = 1");
	});

	it("shows largest files in error when over budget", async () => {
		const result = (await handoffTool.execute("test-call", {
			goal: "Test goal",
			files: [join(testDir, "huge.ts"), join(testDir, "medium.ts"), join(testDir, "small.ts")],
			token_limit: 100,
		})) as ToolResult;

		expect(result.isError).toBe(true);
		// Should list the largest file first
		expect(result.content[0].text).toContain("huge.ts");
	});

	it("handles empty goal gracefully", async () => {
		const result = (await handoffTool.execute("test-call", {
			goal: "",
			files: [join(testDir, "small.ts")],
		})) as ToolResult;

		// Empty goal is allowed - the model decides if it makes sense
		expect(result.isError).toBeFalsy();
	});
});

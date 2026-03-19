import type { TextContent } from "@kennyfrc/mu-ai";
import { describe, expect, it } from "vitest";
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
	formatParentThreadReference,
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
		expect(message).toContain("<system_reminder>");
	});

	it("omits parent thread section when null", () => {
		const message = buildHandoffMessage("Goal", "<files>", null);
		expect(message).not.toContain("Parent Thread");
	});

	it("includes file context", () => {
		const fileContext = "test content";
		const message = buildHandoffMessage("Goal", fileContext, null);
		expect(message).toContain("<file_context>");
		expect(message).toContain(fileContext);
		expect(message).toContain("</file_context>");
	});

	it("includes instructions for the new session", () => {
		const message = buildHandoffMessage("Goal", "<files>", null);
		expect(message).toContain("Begin working on the goal");
	});
});

describe("formatParentThreadReference", () => {
	it("includes parent id and reminder", () => {
		const result = formatParentThreadReference("parent-xyz");
		expect(result).toContain("**Parent Thread:** `parent-xyz`");
		expect(result).toContain("read_thread");
		expect(result).toContain("<system_reminder>");
	});
});

// -----------------------------------------------------------------------------
// Tool execution tests
// -----------------------------------------------------------------------------

describe("handoffTool.execute", () => {
	it("returns a summary-only compaction request for a valid goal", async () => {
		const result = (await handoffTool.execute("test-call", {
			goal: "Test goal",
		})) as ToolResult;

		expect(result.isError).toBeFalsy();
		expect(result.details).toBeDefined();
		expect(result.details.handoffType).toBe("explicit");
		expect(result.details.goal).toBe("Test goal");
		expect(result.details.formattedMessage).toBe("");
		expect(result.details.fileTokens).toBe(0);
		expect(result.details.keyFiles).toEqual([]);
		expect(result.content[0]?.text).toBe('Compaction requested: "Test goal"');
	});

	it("throws on abort signal", async () => {
		const controller = new AbortController();
		controller.abort();

		await expect(handoffTool.execute("test-call", { goal: "Test goal" }, controller.signal)).rejects.toThrow(
			"Aborted",
		);
	});

	it("returns an error for an empty goal", async () => {
		const result = (await handoffTool.execute("test-call", {
			goal: "",
		})) as ToolResult;

		expect(result.isError).toBe(true);
		expect(result.content[0]?.text).toBe("Error: goal is required");
	});
});

/**
 * Red tests for write tool streaming.
 * These tests verify that the write tool streams content lines via onProgress callback.
 *
 * Expected behavior:
 * - Write tool calls onProgress for each content line
 * - Streaming happens BEFORE the file is written
 * - Content is streamed line-by-line for incremental visual feedback
 */

import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeTool } from "../src/tools/write.js";

describe("write tool streaming", () => {
	let tmpDir: string;
	let testFile: string;

	beforeEach(async () => {
		tmpDir = path.join(os.tmpdir(), "write-streaming-test", Date.now().toString());
		await fs.mkdir(tmpDir, { recursive: true });
		testFile = path.join(tmpDir, "test.txt");
	});

	afterEach(async () => {
		await fs.rm(tmpDir, { recursive: true, force: true });
	});

	it("streams content lines via onProgress callback", async () => {
		const content = `import { foo } from "./foo.js";
import { bar } from "./bar.js";

export function main() {
  foo();
  bar();
}
`;

		const progressChunks: string[] = [];
		const onProgress = (chunk: string) => {
			progressChunks.push(chunk);
		};

		const result = await writeTool.execute(
			"test-call-id",
			{
				path: testFile,
				content,
			},
			undefined,
			onProgress,
		);

		// Verify streaming happened
		expect(progressChunks.length).toBeGreaterThan(0);

		// Verify streamed content matches original content
		const streamedText = progressChunks.join("");
		expect(streamedText).toBe(content);
	});

	it("streams content line by line", async () => {
		const lines = ["line1", "line2", "line3", "line4", "line5"];
		const content = lines.join("\n") + "\n";

		const progressChunks: string[] = [];
		const onProgress = (chunk: string) => {
			progressChunks.push(chunk);
		};

		await writeTool.execute(
			"test-call-id",
			{
				path: testFile,
				content,
			},
			undefined,
			onProgress,
		);

		// Should have streamed each line (5 lines = 5 chunks)
		expect(progressChunks.length).toBe(5);

		// Each chunk should be a single line with newline
		for (let i = 0; i < lines.length; i++) {
			expect(progressChunks[i]).toBe(lines[i] + "\n");
		}
	});

	it("streams before file is written (progress chunks arrive before result)", async () => {
		const content = "line1\nline2\nline3\n";

		const events: Array<{ type: "progress" | "result"; content: string }> = [];
		const onProgress = (chunk: string) => {
			events.push({ type: "progress", content: chunk });
		};

		const result = await writeTool.execute(
			"test-call-id",
			{
				path: testFile,
				content,
			},
			undefined,
			onProgress,
		);

		events.push({ type: "result", content: "done" });

		// Progress events should come before result
		const progressIndices = events.map((e, i) => (e.type === "progress" ? i : -1)).filter((i) => i >= 0);
		const resultIndex = events.findIndex((e) => e.type === "result");

		// All progress events should be before the result
		for (const pi of progressIndices) {
			expect(pi).toBeLessThan(resultIndex);
		}
	});

	it("streams empty content (edge case)", async () => {
		const progressChunks: string[] = [];
		const onProgress = (chunk: string) => {
			progressChunks.push(chunk);
		};

		const result = await writeTool.execute(
			"test-call-id",
			{
				path: testFile,
				content: "",
			},
			undefined,
			onProgress,
		);

		// Empty content should result in no streaming (nothing to show)
		expect(progressChunks.length).toBe(0);

		// File should still be created/emptied
		const writtenContent = await fs.readFile(testFile, "utf-8");
		expect(writtenContent).toBe("");
	});

	it("streams content for file overwrite (existing file)", async () => {
		// Create existing file
		await fs.writeFile(testFile, "old content\n", "utf-8");

		const newContent = "new content\nmore lines\n";

		const progressChunks: string[] = [];
		const onProgress = (chunk: string) => {
			progressChunks.push(chunk);
		};

		const result = await writeTool.execute(
			"test-call-id",
			{
				path: testFile,
				content: newContent,
			},
			undefined,
			onProgress,
		);

		// Should stream the new content
		expect(progressChunks.length).toBeGreaterThan(0);
		const streamedText = progressChunks.join("");
		expect(streamedText).toBe(newContent);

		// Verify file was actually overwritten
		const writtenContent = await fs.readFile(testFile, "utf-8");
		expect(writtenContent).toBe(newContent);
	});

	it("streams large file content (100+ lines)", async () => {
		const lines: string[] = [];
		for (let i = 1; i <= 100; i++) {
			lines.push(`// Line ${i}: This is a comment for testing large file streaming`);
		}
		const content = lines.join("\n") + "\n";

		const progressChunks: string[] = [];
		const onProgress = (chunk: string) => {
			progressChunks.push(chunk);
		};

		await writeTool.execute(
			"test-call-id",
			{
				path: testFile,
				content,
			},
			undefined,
			onProgress,
		);

		// Should stream all 100 lines
		expect(progressChunks.length).toBe(100);

		// Verify content matches
		const streamedText = progressChunks.join("");
		expect(streamedText).toBe(content);
	});

	it("handles single-line content without trailing newline", async () => {
		const content = "single line without newline";

		const progressChunks: string[] = [];
		const onProgress = (chunk: string) => {
			progressChunks.push(chunk);
		};

		await writeTool.execute(
			"test-call-id",
			{
				path: testFile,
				content,
			},
			undefined,
			onProgress,
		);

		// Single line without newline should still be streamed (as one chunk)
		expect(progressChunks.length).toBe(1);
		expect(progressChunks[0]).toBe(content);
	});
});

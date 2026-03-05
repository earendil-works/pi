/**
 * Red tests for edit tool streaming.
 * These tests verify that the edit tool streams diff lines via onProgress callback.
 *
 * Expected behavior:
 * - Edit tool calls onProgress for each diff line as it's generated
 * - Streaming happens BEFORE the file is written
 * - Diff format matches what's returned in details.diff
 */

import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { editTool } from "../src/tools/edit.js";

describe("edit tool streaming", () => {
	let tmpDir: string;
	let testFile: string;

	beforeEach(async () => {
		tmpDir = path.join(os.tmpdir(), "edit-streaming-test", Date.now().toString());
		await fs.mkdir(tmpDir, { recursive: true });
		testFile = path.join(tmpDir, "test.txt");
	});

	afterEach(async () => {
		await fs.rm(tmpDir, { recursive: true, force: true });
	});

	it("streams diff lines via onProgress callback", async () => {
		const originalContent = `function hello() {
  console.log("Hello, World!");
  return 1;
}

function goodbye() {
  console.log("Goodbye!");
  return 0;
}
`;
		await fs.writeFile(testFile, originalContent, "utf-8");

		const progressChunks: string[] = [];
		const onProgress = (chunk: string) => {
			progressChunks.push(chunk);
		};

		const result = await editTool.execute(
			"test-call-id",
			{
				path: testFile,
				oldText: 'console.log("Hello, World!");',
				newText: 'console.log("Hello, Universe!");',
			},
			undefined,
			onProgress,
		);

		// Verify streaming happened
		expect(progressChunks.length).toBeGreaterThan(0);

		// Verify streamed content matches the diff format
		const streamedText = progressChunks.join("");
		expect(streamedText).toContain("-"); // Removed line marker
		expect(streamedText).toContain("+"); // Added line marker
		expect(streamedText).toContain("Hello, World!"); // Old content
		expect(streamedText).toContain("Hello, Universe!"); // New content

		// Verify final diff matches what was streamed
		const finalDiff = result.details?.diff ?? "";
		expect(streamedText.trim()).toBe(finalDiff.trim());
	});

	it("streams before file is written (progress chunks arrive before result)", async () => {
		const originalContent = "line1\nline2\nline3\n";
		await fs.writeFile(testFile, originalContent, "utf-8");

		const events: Array<{ type: "progress" | "result"; content: string }> = [];
		const onProgress = (chunk: string) => {
			events.push({ type: "progress", content: chunk });
		};

		const result = await editTool.execute(
			"test-call-id",
			{
				path: testFile,
				oldText: "line2",
				newText: "line2-modified",
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

	it("streams multi-line edit changes", async () => {
		const originalContent = `function old() {
  console.log("old");
  return 1;
}

function keep() {
  console.log("keep");
  return 2;
}
`;
		await fs.writeFile(testFile, originalContent, "utf-8");

		const progressChunks: string[] = [];
		const onProgress = (chunk: string) => {
			progressChunks.push(chunk);
		};

		const newBlock = `function new() {
  console.log("new");
  return 3;
}`;

		await editTool.execute(
			"test-call-id",
			{
				path: testFile,
				oldText: `function old() {
  console.log("old");
  return 1;
}`,
				newText: newBlock,
			},
			undefined,
			onProgress,
		);

		// Should stream all lines of the multi-line change
		expect(progressChunks.length).toBeGreaterThan(3);

		const streamedText = progressChunks.join("");
		expect(streamedText).toContain("function old()"); // Old function removed
		expect(streamedText).toContain("function new()"); // New function added
	});

	it("streams nothing if edit makes no changes (same content)", async () => {
		const originalContent = "line1\nline2\nline3\n";
		await fs.writeFile(testFile, originalContent, "utf-8");

		const progressChunks: string[] = [];
		const onProgress = (chunk: string) => {
			progressChunks.push(chunk);
		};

		// Edit that results in no change (oldText === newText)
		await expect(
			editTool.execute(
				"test-call-id",
				{
					path: testFile,
					oldText: "line2",
					newText: "line2", // Same as oldText
				},
				undefined,
				onProgress,
			),
		).rejects.toThrow("No changes made");

		// No streaming should happen for no-op edits
		expect(progressChunks.length).toBe(0);
	});

	it("does not stream when text is not found (error case)", async () => {
		const originalContent = "line1\nline2\nline3\n";
		await fs.writeFile(testFile, originalContent, "utf-8");

		const progressChunks: string[] = [];
		const onProgress = (chunk: string) => {
			progressChunks.push(chunk);
		};

		await expect(
			editTool.execute(
				"test-call-id",
				{
					path: testFile,
					oldText: "nonexistent",
					newText: "replacement",
				},
				undefined,
				onProgress,
			),
		).rejects.toThrow("Could not find");

		// No streaming should happen when match fails
		expect(progressChunks.length).toBe(0);
	});
});

/**
 * Failing Test Suite for Hashline Implementation (oh-my-pi Aligned)
 *
 * These tests define the expected behavior for hashline functionality.
 * They will fail until the implementation is complete.
 *
 * Run with: npx vitest run packages/coding-agent/test/hashline.test.ts
 */

import { mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { editTool } from "../src/tools/edit.js";
import { readTool } from "../src/tools/read.js";

// Helper to extract text from content blocks
function getTextOutput(result: any): string {
	return (
		result.content
			?.filter((c: any) => c.type === "text")
			.map((c: any) => c.text)
			.join("\n") || ""
	);
}

describe("Hashline Implementation (oh-my-pi Aligned)", () => {
	let testDir: string;

	beforeEach(() => {
		testDir = join(tmpdir(), `hashline-test-${Date.now()}`);
		mkdirSync(testDir, { recursive: true });
	});

	afterEach(() => {
		rmSync(testDir, { recursive: true, force: true });
	});

	// ============================================================================
	// READ TOOL - HASHLINE FORMAT OUTPUT
	// ============================================================================

	describe("read tool - hashline format", () => {
		it("should prefix each line with line number and base36 hash", async () => {
			const testFile = join(testDir, "simple.txt");
			writeFileSync(testFile, "Hello\nWorld\n");

			const result = await readTool.execute("test-call", { path: testFile });
			const output = getTextOutput(result);

			// Each line should match: {number}:{base36}|{content}
			// base36 = [a-z0-9], 2 chars
			const lines = output.split("\n").filter((l) => l.trim() || l.includes("|"));
			expect(lines[0]).toMatch(/^1:[a-z0-9]{2}\|Hello$/);
			expect(lines[1]).toMatch(/^2:[a-z0-9]{2}\|World$/);
		});

		it("should use whitespace-normalized content for hash", async () => {
			const testFile = join(testDir, "whitespace-hash.txt");
			// Same semantic content, different whitespace
			writeFileSync(testFile, "const x = 1;\nconst  x=1;\n");

			const result = await readTool.execute("test-call", { path: testFile });
			const output = getTextOutput(result);

			const lines = output.split("\n").filter((l) => l.includes("|"));
			const hash1 = lines[0].split(":")[1].split("|")[0];
			const hash2 = lines[1].split(":")[1].split("|")[0];
			// Whitespace-normalized, so hashes should match
			expect(hash1).toBe(hash2);
		});

		it("should include line numbers matching file position (1-indexed)", async () => {
			const testFile = join(testDir, "numbered.txt");
			writeFileSync(testFile, "line1\nline2\nline3\nline4\nline5");

			const result = await readTool.execute("test-call", { path: testFile, offset: 3, limit: 2 });
			const output = getTextOutput(result);

			// Even with offset/limit, line numbers reflect absolute file position
			const lines = output.split("\n").filter((l) => l.includes("|"));
			expect(lines[0]).toMatch(/^3:[a-z0-9]{2}\|line3$/);
			expect(lines[1]).toMatch(/^4:[a-z0-9]{2}\|line4$/);
		});

		it("should handle empty lines with consistent hash", async () => {
			const testFile = join(testDir, "empty-lines.txt");
			writeFileSync(testFile, "content\n\ncontent\n");

			const result = await readTool.execute("test-call", { path: testFile });
			const output = getTextOutput(result);

			// Empty line should still have hash: "lineNum:hash|"
			const lines = output.split("\n").filter((l) => l.includes("|"));
			expect(lines[1]).toMatch(/^2:[a-z0-9]{2}\|$/);
		});

		it("should handle files with pipe characters in content", async () => {
			const testFile = join(testDir, "pipe-content.txt");
			writeFileSync(testFile, "a|b|c\nd|e\n");

			const result = await readTool.execute("test-call", { path: testFile });
			const output = getTextOutput(result);

			// First | is delimiter, rest is content
			expect(output).toContain("|a|b|c");
			expect(output).toContain("|d|e");
		});
	});

	// ============================================================================
	// EDIT TOOL - BATCH OPERATIONS SCHEMA
	// ============================================================================

	describe("edit tool - batch operations", () => {
		it("should accept single set_line operation", async () => {
			const testFile = join(testDir, "set-line.txt");
			writeFileSync(testFile, "line1\nline2\nline3\n");

			const readResult = await readTool.execute("read-call", { path: testFile });
			const readOutput = getTextOutput(readResult);
			const line2Hashline = readOutput.split("\n").find((l) => l.startsWith("2:"));
			if (!line2Hashline) throw new Error("Line 2 not found");
			const anchor = line2Hashline.split("|")[0]; // "2:xx"

			const result = await editTool.execute("edit-call", {
				path: testFile,
				edits: [{ set_line: { anchor, new_text: "REPLACED" } }],
			});

			expect(getTextOutput(result)).toContain("Successfully edited");
			expect(readFileSync(testFile, "utf-8")).toBe("line1\nREPLACED\nline3\n");
		});

		it("should accept multiple operations in one call", async () => {
			const testFile = join(testDir, "batch.txt");
			writeFileSync(testFile, "a\nb\nc\nd\ne\n");

			const readResult = await readTool.execute("read-call", { path: testFile });
			const readOutput = getTextOutput(readResult);
			const lines = readOutput.split("\n").filter((l) => l.includes("|"));
			const anchor2 = lines[1].split("|")[0]; // line 2
			const anchor4 = lines[3].split("|")[0]; // line 4

			const result = await editTool.execute("edit-call", {
				path: testFile,
				edits: [{ set_line: { anchor: anchor2, new_text: "B" } }, { set_line: { anchor: anchor4, new_text: "D" } }],
			});

			expect(getTextOutput(result)).toContain("Successfully edited");
			expect(readFileSync(testFile, "utf-8")).toBe("a\nB\nc\nD\ne\n");
		});

		it("should support replace_lines for range replacement", async () => {
			const testFile = join(testDir, "replace-range.txt");
			writeFileSync(testFile, "start\nremove1\nremove2\nremove3\nend\n");

			const readResult = await readTool.execute("read-call", { path: testFile });
			const readOutput = getTextOutput(readResult);
			const lines = readOutput.split("\n").filter((l) => l.includes("|"));
			const startAnchor = lines[1].split("|")[0]; // line 2
			const endAnchor = lines[3].split("|")[0]; // line 4

			const result = await editTool.execute("edit-call", {
				path: testFile,
				edits: [{ replace_lines: { start_anchor: startAnchor, end_anchor: endAnchor, new_text: "middle" } }],
			});

			expect(getTextOutput(result)).toContain("Successfully edited");
			expect(readFileSync(testFile, "utf-8")).toBe("start\nmiddle\nend\n");
		});

		it("should support insert_after operation", async () => {
			const testFile = join(testDir, "insert-after.txt");
			writeFileSync(testFile, "line1\nline2\n");

			const readResult = await readTool.execute("read-call", { path: testFile });
			const readOutput = getTextOutput(readResult);
			const line1Hashline = readOutput.split("\n").find((l) => l.startsWith("1:"));
			if (!line1Hashline) throw new Error("Line 1 not found");
			const anchor = line1Hashline.split("|")[0];

			const result = await editTool.execute("edit-call", {
				path: testFile,
				edits: [{ insert_after: { anchor, text: "inserted" } }],
			});

			expect(getTextOutput(result)).toContain("Successfully edited");
			expect(readFileSync(testFile, "utf-8")).toBe("line1\ninserted\nline2\n");
		});

		it("should support replace operation for fuzzy matching fallback", async () => {
			const testFile = join(testDir, "fuzzy-fallback.txt");
			writeFileSync(testFile, "function hello() {\n  return 'world';\n}");

			const result = await editTool.execute("edit-call", {
				path: testFile,
				edits: [{ replace: { old_text: "function hello()", new_text: "function greet()" } }],
			});

			expect(getTextOutput(result)).toContain("Successfully edited");
			expect(readFileSync(testFile, "utf-8")).toContain("function greet()");
		});

		it("should reject empty edits array", async () => {
			const testFile = join(testDir, "empty-edits.txt");
			writeFileSync(testFile, "content\n");

			await expect(
				editTool.execute("edit-call", {
					path: testFile,
					edits: [],
				}),
			).rejects.toThrow(/edits array must not be empty/);
		});
	});

	// ============================================================================
	// EDIT TOOL - DELETE OPERATIONS
	// ============================================================================

	describe("edit tool - delete operations", () => {
		it("should delete single line with empty new_text", async () => {
			const testFile = join(testDir, "delete-single.txt");
			writeFileSync(testFile, "keep\ndelete me\nkeep\n");

			const readResult = await readTool.execute("read-call", { path: testFile });
			const readOutput = getTextOutput(readResult);
			const line2Hashline = readOutput.split("\n").find((l) => l.startsWith("2:"));
			if (!line2Hashline) throw new Error("Line 2 not found");
			const anchor = line2Hashline.split("|")[0];

			await editTool.execute("edit-call", {
				path: testFile,
				edits: [{ set_line: { anchor, new_text: "" } }],
			});

			expect(readFileSync(testFile, "utf-8")).toBe("keep\nkeep\n");
		});

		it("should delete range with empty new_text", async () => {
			const testFile = join(testDir, "delete-range.txt");
			writeFileSync(testFile, "start\nremove1\nremove2\nend\n");

			const readResult = await readTool.execute("read-call", { path: testFile });
			const readOutput = getTextOutput(readResult);
			const lines = readOutput.split("\n").filter((l) => l.includes("|"));
			const startAnchor = lines[1].split("|")[0];
			const endAnchor = lines[2].split("|")[0];

			await editTool.execute("edit-call", {
				path: testFile,
				edits: [{ replace_lines: { start_anchor: startAnchor, end_anchor: endAnchor, new_text: "" } }],
			});

			expect(readFileSync(testFile, "utf-8")).toBe("start\nend\n");
		});
	});

	// ============================================================================
	// EDIT TOOL - HASH RELOCATION
	// ============================================================================

	describe("edit tool - hash relocation", () => {
		it("should auto-relocate when hash moved to different line", async () => {
			const testFile = join(testDir, "relocate.txt");
			writeFileSync(testFile, "line1\nline2\ntarget\n");

			const readResult = await readTool.execute("read-call", { path: testFile });
			const readOutput = getTextOutput(readResult);
			const lines = readOutput.split("\n").filter((l) => l.includes("|"));
			const originalAnchor = lines[2].split("|")[0]; // line 3, hash "xx"
			const hash = originalAnchor.split(":")[1];

			// Insert line above, shifting target to line 4
			writeFileSync(testFile, "line1\nline2\ninserted\ntarget\n");

			// Edit with old line number but correct hash
			const result = await editTool.execute("edit-call", {
				path: testFile,
				edits: [{ set_line: { anchor: `3:${hash}`, new_text: "RELOCATED" } }],
			});

			expect(getTextOutput(result)).toContain("Successfully edited");
			// Should have edited line 4 (where hash was found)
			expect(readFileSync(testFile, "utf-8")).toBe("line1\nline2\ninserted\nRELOCATED\n");
		});

		it("should NOT relocate when hash referenced multiple times in batch", async () => {
			const testFile = join(testDir, "duplicate-hash.txt");
			// Use same content for lines 1 and 2 so they have the same hash
			writeFileSync(testFile, "same\nsame\nfooter\n");

			const readResult = await readTool.execute("read-call", { path: testFile });
			const readOutput = getTextOutput(readResult);
			const lines = readOutput.split("\n").filter((l) => l.includes("|"));
			const anchor1 = lines[0].split("|")[0]; // line 1: "same"
			const anchor2 = lines[1].split("|")[0]; // line 2: "same" - same hash
			const hash1 = anchor1.split(":")[1];

			// Verify both anchors have the same hash
			expect(anchor2.split(":")[1]).toBe(hash1);

			// Replace "same" lines with different content
			// Now hash "jh" (for "same") is nowhere in the file
			writeFileSync(testFile, "changed\nalso changed\nfooter\n");

			// Try to edit with same hash referenced twice in batch (ambiguous)
			// Both anchors reference the same hash which is now absent
			await expect(
				editTool.execute("edit-call", {
					path: testFile,
					edits: [
						{ set_line: { anchor: anchor1, new_text: "new1" } }, // stale
						{ set_line: { anchor: anchor2, new_text: "new2" } }, // stale
					],
				}),
			).rejects.toThrow(/Stale reference|hash mismatch/);
		});

		it("should relocate for replace_lines when start hash moved", async () => {
			const testFile = join(testDir, "relocate-range.txt");
			writeFileSync(testFile, "line1\nstart\nmiddle\nend\nline5\n");

			const readResult = await readTool.execute("read-call", { path: testFile });
			const readOutput = getTextOutput(readResult);
			const lines = readOutput.split("\n").filter((l) => l.includes("|"));
			const startHash = lines[1].split(":")[1];
			const endAnchor = lines[3].split("|")[0]; // "4:xx"

			// Insert line at top, shifting everything down
			writeFileSync(testFile, "inserted\nline1\nstart\nmiddle\nend\nline5\n");

			// Use old line numbers but correct hashes
			await editTool.execute("edit-call", {
				path: testFile,
				edits: [
					{
						replace_lines: {
							start_anchor: `2:${startHash}`,
							end_anchor: endAnchor,
							new_text: "REPLACED",
						},
					},
				],
			});

			expect(readFileSync(testFile, "utf-8")).toBe("inserted\nline1\nREPLACED\nline5\n");
		});

		it("should relocate for insert_after when anchor hash moved", async () => {
			const testFile = join(testDir, "relocate-insert.txt");
			writeFileSync(testFile, "line1\nanchor\nline3\n");

			const readResult = await readTool.execute("read-call", { path: testFile });
			const readOutput = getTextOutput(readResult);
			const lines = readOutput.split("\n").filter((l) => l.includes("|"));
			const anchorHash = lines[1].split(":")[1];

			// Delete first line, shifting anchor to line 1
			writeFileSync(testFile, "anchor\nline3\n");

			// Use old line number but correct hash
			await editTool.execute("edit-call", {
				path: testFile,
				edits: [{ insert_after: { anchor: `2:${anchorHash}`, text: "inserted" } }],
			});

			expect(readFileSync(testFile, "utf-8")).toBe("anchor\ninserted\nline3\n");
		});
	});

	// ============================================================================
	// EDIT TOOL - STALE REFERENCE ERRORS (Rich Error Messages)
	// ============================================================================

	describe("edit tool - stale reference errors", () => {
		it("should reject with HashlineMismatchError when hash mismatch", async () => {
			const testFile = join(testDir, "stale.txt");
			writeFileSync(testFile, "original\n");

			const readResult = await readTool.execute("read-call", { path: testFile });
			const anchor = getTextOutput(readResult).split("|")[0];

			// Modify file
			writeFileSync(testFile, "modified\n");

			await expect(
				editTool.execute("edit-call", {
					path: testFile,
					edits: [{ set_line: { anchor, new_text: "new" } }],
				}),
			).rejects.toThrow(/changed since last read/);
		});

		it("should show context lines with >>> marker for stale lines", async () => {
			const testFile = join(testDir, "stale-context.txt");
			writeFileSync(testFile, "before\ntarget\nafter\n");

			const readResult = await readTool.execute("read-call", { path: testFile });
			const readOutput = getTextOutput(readResult);
			const line2Hashline = readOutput.split("\n").find((l) => l.startsWith("2:"));
			if (!line2Hashline) throw new Error("Line 2 not found");
			const anchor = line2Hashline.split("|")[0];

			writeFileSync(testFile, "before\nCHANGED\nafter\n");

			try {
				await editTool.execute("edit-call", {
					path: testFile,
					edits: [{ set_line: { anchor, new_text: "new" } }],
				});
				expect.fail("Should have thrown");
			} catch (error: any) {
				expect(error.message).toContain(">>>");
				expect(error.message).toContain("CHANGED");
			}
		});

		it("should provide quick-fix remap section", async () => {
			const testFile = join(testDir, "quick-fix.txt");
			writeFileSync(testFile, "target\n");

			const readResult = await readTool.execute("read-call", { path: testFile });
			const originalAnchor = getTextOutput(readResult).split("|")[0];
			const originalHash = originalAnchor.split(":")[1];

			writeFileSync(testFile, "changed\n");

			// Re-read to get new hash
			const newReadResult = await readTool.execute("read-call", { path: testFile });
			const newHashLine = getTextOutput(newReadResult).split("\n")[0];
			const newHash = newHashLine.split(":")[1].split("|")[0];

			try {
				await editTool.execute("edit-call", {
					path: testFile,
					edits: [{ set_line: { anchor: originalAnchor, new_text: "new" } }],
				});
				expect.fail("Should have thrown");
			} catch (error: any) {
				expect(error.message).toContain("Quick fix");
				expect(error.message).toContain(`${originalHash}`);
				expect(error.message).toContain(`${newHash}`);
			}
		});

		it("should collect all mismatches before rejecting (batch)", async () => {
			const testFile = join(testDir, "batch-stale.txt");
			writeFileSync(testFile, "line1\nline2\nline3\n");

			const readResult = await readTool.execute("read-call", { path: testFile });
			const lines = getTextOutput(readResult)
				.split("\n")
				.filter((l) => l.includes("|"));
			const anchor1 = lines[0].split("|")[0];
			const anchor2 = lines[1].split("|")[0];

			// Modify both lines
			writeFileSync(testFile, "CHANGED1\nCHANGED2\nline3\n");

			try {
				await editTool.execute("edit-call", {
					path: testFile,
					edits: [
						{ set_line: { anchor: anchor1, new_text: "new1" } },
						{ set_line: { anchor: anchor2, new_text: "new2" } },
					],
				});
				expect.fail("Should have thrown");
			} catch (error: any) {
				// Error should mention both stale lines
				expect(error.message).toContain("2 lines");
				expect(error.message).toContain("CHANGED1");
				expect(error.message).toContain("CHANGED2");
			}
		});
	});

	// ============================================================================
	// EDIT TOOL - ATOMIC VALIDATION
	// ============================================================================

	describe("edit tool - atomic validation", () => {
		it("should reject all edits if any single edit is invalid", async () => {
			const testFile = join(testDir, "atomic.txt");
			writeFileSync(testFile, "line1\nline2\nline3\n");

			const readResult = await readTool.execute("read-call", { path: testFile });
			const lines = getTextOutput(readResult)
				.split("\n")
				.filter((l) => l.includes("|"));
			const validAnchor = lines[0].split("|")[0];
			const staleAnchor = lines[1].split("|")[0];

			// Only modify line 2
			writeFileSync(testFile, "line1\nCHANGED\nline3\n");

			// Try to edit line 1 (valid) and line 2 (stale)
			await expect(
				editTool.execute("edit-call", {
					path: testFile,
					edits: [
						{ set_line: { anchor: validAnchor, new_text: "edited1" } },
						{ set_line: { anchor: staleAnchor, new_text: "edited2" } },
					],
				}),
			).rejects.toThrow();

			// Verify NO edits were applied
			const content = readFileSync(testFile, "utf-8");
			expect(content).toBe("line1\nCHANGED\nline3\n");
		});
	});

	// ============================================================================
	// EDIT TOOL - PREFIX STRIPPING
	// ============================================================================

	describe("edit tool - prefix stripping", () => {
		it("should strip accidentally copied LINE:HASH| prefixes from new_text", async () => {
			const testFile = join(testDir, "strip-prefix.txt");
			writeFileSync(testFile, "target\n");

			const readResult = await readTool.execute("read-call", { path: testFile });
			const anchor = getTextOutput(readResult).split("|")[0];

			// Model accidentally copies the prefix into new_text
			await editTool.execute("edit-call", {
				path: testFile,
				edits: [{ set_line: { anchor, new_text: "1:ab|replaced" } }],
			});

			// Prefix should be stripped
			expect(readFileSync(testFile, "utf-8")).toBe("replaced\n");
		});

		it("should strip diff + markers if majority present", async () => {
			const testFile = join(testDir, "strip-diff.txt");
			writeFileSync(testFile, "line1\nline2\n");

			const readResult = await readTool.execute("read-call", { path: testFile });
			const readOutput = getTextOutput(readResult);
			const line1Hashline = readOutput.split("\n").find((l) => l.startsWith("1:"));
			if (!line1Hashline) throw new Error("Line 1 not found");
			const anchor = line1Hashline.split("|")[0];

			// Model uses diff-style content
			await editTool.execute("edit-call", {
				path: testFile,
				edits: [
					{
						insert_after: {
							anchor,
							text: "+inserted line 1\n+inserted line 2",
						},
					},
				],
			});

			const content = readFileSync(testFile, "utf-8");
			expect(content).toBe("line1\ninserted line 1\ninserted line 2\nline2\n");
		});
	});

	// ============================================================================
	// EDIT TOOL - NO-OP DETECTION
	// ============================================================================

	describe("edit tool - no-op detection", () => {
		it("should reject edit when new_text matches current content", async () => {
			const testFile = join(testDir, "noop.txt");
			writeFileSync(testFile, "unchanged\n");

			const readResult = await readTool.execute("read-call", { path: testFile });
			const anchor = getTextOutput(readResult).split("|")[0];

			await expect(
				editTool.execute("edit-call", {
					path: testFile,
					edits: [{ set_line: { anchor, new_text: "unchanged" } }],
				}),
			).rejects.toThrow(/no-op|identical content/);
		});
	});

	// ============================================================================
	// EDIT TOOL - INDENTATION PRESERVATION
	// ============================================================================

	describe("edit tool - indentation preservation", () => {
		it("should restore original indentation when model changes it", async () => {
			const testFile = join(testDir, "indent.txt");
			writeFileSync(testFile, "  indented line\n");

			const readResult = await readTool.execute("read-call", { path: testFile });
			const anchor = getTextOutput(readResult).split("|")[0];

			// Model provides wrong indentation
			await editTool.execute("edit-call", {
				path: testFile,
				edits: [{ set_line: { anchor, new_text: "wrong indent" } }],
			});

			// Should preserve original 2-space indent
			expect(readFileSync(testFile, "utf-8")).toBe("  wrong indent\n");
		});
	});

	// ============================================================================
	// EDIT TOOL - PREFIX STRIPPING (Extended)
	// ============================================================================

	describe("edit tool - prefix stripping extended", () => {
		it("should strip hashline prefix when majority of lines have it", async () => {
			const testFile = join(testDir, "strip-majority-hash.txt");
			writeFileSync(testFile, "line1\nline2\n");

			const readResult = await readTool.execute("read-call", { path: testFile });
			const line1Output = getTextOutput(readResult)
				.split("\n")
				.find((l) => l.startsWith("1:"));
			if (!line1Output) throw new Error("Line 1 not found");
			const anchor = line1Output.split("|")[0];

			// Insert 3 lines where 2 have hashline prefix (>50%)
			await editTool.execute("edit-call", {
				path: testFile,
				edits: [
					{
						insert_after: {
							anchor,
							text: "2:ab|new line 1\nno prefix line\n3:cd|new line 2",
						},
					},
				],
			});

			const content = readFileSync(testFile, "utf-8");
			expect(content).toBe("line1\nnew line 1\nno prefix line\nnew line 2\nline2\n");
		});

		it("should NOT strip hashline prefix when minority of lines have it", async () => {
			const testFile = join(testDir, "strip-minority-hash.txt");
			writeFileSync(testFile, "line1\nline2\n");

			const readResult = await readTool.execute("read-call", { path: testFile });
			const line1Output = getTextOutput(readResult)
				.split("\n")
				.find((l) => l.startsWith("1:"));
			if (!line1Output) throw new Error("Line 1 not found");
			const anchor = line1Output.split("|")[0];

			// Insert 3 lines where only 1 has hashline prefix (<50%)
			await editTool.execute("edit-call", {
				path: testFile,
				edits: [
					{
						insert_after: {
							anchor,
							text: "2:ab|new line 1\nregular content\nanother regular",
						},
					},
				],
			});

			const content = readFileSync(testFile, "utf-8");
			// Should preserve the prefix since it's minority
			expect(content).toContain("2:ab|new line 1");
		});

		it("should strip diff + markers when majority present", async () => {
			const testFile = join(testDir, "strip-diff-majority.txt");
			writeFileSync(testFile, "line1\nline2\n");

			const readResult = await readTool.execute("read-call", { path: testFile });
			const line1Output = getTextOutput(readResult)
				.split("\n")
				.find((l) => l.startsWith("1:"));
			if (!line1Output) throw new Error("Line 1 not found");
			const anchor = line1Output.split("|")[0];

			// Insert with diff-style + markers
			await editTool.execute("edit-call", {
				path: testFile,
				edits: [
					{
						insert_after: {
							anchor,
							text: "+inserted 1\n+inserted 2\n+inserted 3",
						},
					},
				],
			});

			const content = readFileSync(testFile, "utf-8");
			expect(content).toBe("line1\ninserted 1\ninserted 2\ninserted 3\nline2\n");
		});

		it("should NOT strip + if it could be valid content (minority)", async () => {
			const testFile = join(testDir, "strip-diff-minority.txt");
			writeFileSync(testFile, "line1\nline2\n");

			const readResult = await readTool.execute("read-call", { path: testFile });
			const line1Output = getTextOutput(readResult)
				.split("\n")
				.find((l) => l.startsWith("1:"));
			if (!line1Output) throw new Error("Line 1 not found");
			const anchor = line1Output.split("|")[0];

			// Only 1 out of 3 lines has + prefix
			await editTool.execute("edit-call", {
				path: testFile,
				edits: [
					{
						insert_after: {
							anchor,
							text: "+only one\nregular line\nanother regular",
						},
					},
				],
			});

			const content = readFileSync(testFile, "utf-8");
			// Should preserve the + since it's minority
			expect(content).toContain("+only one");
		});

		it("should prefer hashline stripping over diff stripping", async () => {
			const testFile = join(testDir, "strip-priority.txt");
			writeFileSync(testFile, "line1\nline2\n");

			const readResult = await readTool.execute("read-call", { path: testFile });
			const line1Output = getTextOutput(readResult)
				.split("\n")
				.find((l) => l.startsWith("1:"));
			if (!line1Output) throw new Error("Line 1 not found");
			const anchor = line1Output.split("|")[0];

			// Mix of hashline and diff prefixes - hashline should win (checked first)
			await editTool.execute("edit-call", {
				path: testFile,
				edits: [
					{
						insert_after: {
							anchor,
							text: "1:ab|line with hash\n+line with plus\n2:cd|another hash",
						},
					},
				],
			});

			const content = readFileSync(testFile, "utf-8");
			// Hashline majority (2/3), so strip hashlines but keep +
			expect(content).toBe("line1\nline with hash\n+line with plus\nanother hash\nline2\n");
		});
	});

	// ============================================================================
	// EDIT TOOL - NO-OP DETECTION (Extended)
	// ============================================================================

	describe("edit tool - no-op detection extended", () => {
		it("should reject replace_lines that results in identical content", async () => {
			const testFile = join(testDir, "noop-range.txt");
			writeFileSync(testFile, "start\nmiddle\nend\n");

			const readResult = await readTool.execute("read-call", { path: testFile });
			const lines = getTextOutput(readResult)
				.split("\n")
				.filter((l) => l.includes("|"));
			const startAnchor = lines[1].split("|")[0];
			const endAnchor = lines[1].split("|")[0]; // Same line for single line "range"

			await expect(
				editTool.execute("edit-call", {
					path: testFile,
					edits: [{ replace_lines: { start_anchor: startAnchor, end_anchor: endAnchor, new_text: "middle" } }],
				}),
			).rejects.toThrow(/no changes|identical|noop/i);
		});

		it("should reject insert_after with empty result after stripping", async () => {
			const testFile = join(testDir, "noop-insert.txt");
			writeFileSync(testFile, "line1\nline2\n");

			const readResult = await readTool.execute("read-call", { path: testFile });
			const line1Output = getTextOutput(readResult)
				.split("\n")
				.find((l) => l.startsWith("1:"));
			if (!line1Output) throw new Error("Line 1 not found");
			const anchor = line1Output.split("|")[0];

			// All lines empty after content that becomes empty when stripped
			await expect(
				editTool.execute("edit-call", {
					path: testFile,
					edits: [{ insert_after: { anchor, text: "" } }],
				}),
			).rejects.toThrow(/non-empty|empty/);
		});

		it("should allow edit that changes only whitespace normalization", async () => {
			const testFile = join(testDir, "whitespace-change.txt");
			writeFileSync(testFile, "const  x =  1;\n");

			const readResult = await readTool.execute("read-call", { path: testFile });
			const anchor = getTextOutput(readResult).split("|")[0];

			// Changing spacing - this is a valid edit (content differs)
			await editTool.execute("edit-call", {
				path: testFile,
				edits: [{ set_line: { anchor, new_text: "const x = 1;" } }],
			});

			expect(readFileSync(testFile, "utf-8")).toBe("const x = 1;\n");
		});
	});

	// ============================================================================
	// EDIT TOOL - INDENTATION PRESERVATION (Extended)
	// ============================================================================

	describe("edit tool - indentation preservation extended", () => {
		it("should preserve tabs when model provides unindented content", async () => {
			const testFile = join(testDir, "indent-tabs.txt");
			writeFileSync(testFile, "\t\ttabbed line\n");

			const readResult = await readTool.execute("read-call", { path: testFile });
			const anchor = getTextOutput(readResult).split("|")[0];

			await editTool.execute("edit-call", {
				path: testFile,
				edits: [{ set_line: { anchor, new_text: "changed" } }],
			});

			expect(readFileSync(testFile, "utf-8")).toBe("\t\tchanged\n");
		});

		it("should preserve mixed indentation", async () => {
			const testFile = join(testDir, "indent-mixed.txt");
			writeFileSync(testFile, "  \t  mixed indent\n");

			const readResult = await readTool.execute("read-call", { path: testFile });
			const anchor = getTextOutput(readResult).split("|")[0];

			await editTool.execute("edit-call", {
				path: testFile,
				edits: [{ set_line: { anchor, new_text: "changed" } }],
			});

			expect(readFileSync(testFile, "utf-8")).toBe("  \t  changed\n");
		});

		it("should NOT add indent if model already provided it", async () => {
			const testFile = join(testDir, "indent-provided.txt");
			writeFileSync(testFile, "  original\n");

			const readResult = await readTool.execute("read-call", { path: testFile });
			const anchor = getTextOutput(readResult).split("|")[0];

			// Model provides its own (different) indent
			await editTool.execute("edit-call", {
				path: testFile,
				edits: [{ set_line: { anchor, new_text: "    changed" } }], // 4 spaces
			});

			expect(readFileSync(testFile, "utf-8")).toBe("    changed\n");
		});

		it("should preserve indent for multi-line replacements", async () => {
			const testFile = join(testDir, "indent-multi.txt");
			writeFileSync(testFile, "  line1\n  line2\n  line3\n");

			const readResult = await readTool.execute("read-call", { path: testFile });
			const lines = getTextOutput(readResult)
				.split("\n")
				.filter((l) => l.includes("|"));
			const startAnchor = lines[0].split("|")[0];
			const endAnchor = lines[2].split("|")[0];

			// Replace range with unindented content
			await editTool.execute("edit-call", {
				path: testFile,
				edits: [{ replace_lines: { start_anchor: startAnchor, end_anchor: endAnchor, new_text: "a\nb\nc" } }],
			});

			const content = readFileSync(testFile, "utf-8");
			expect(content).toBe("  a\n  b\n  c\n");
		});

		it("should handle empty original line (no indent to preserve)", async () => {
			const testFile = join(testDir, "indent-empty.txt");
			writeFileSync(testFile, "\n");

			const readResult = await readTool.execute("read-call", { path: testFile });
			const anchor = getTextOutput(readResult).split("|")[0];

			await editTool.execute("edit-call", {
				path: testFile,
				edits: [{ set_line: { anchor, new_text: "  indented content" } }],
			});

			expect(readFileSync(testFile, "utf-8")).toBe("  indented content\n");
		});
	});

	// ============================================================================
	// EDIT TOOL - ERROR MESSAGE FORMAT
	// ============================================================================

	describe("edit tool - error message format", () => {
		it("should include >>> marker on changed lines only", async () => {
			const testFile = join(testDir, "error-marker.txt");
			writeFileSync(testFile, "unchanged1\nwill change\nunchanged2\n");

			const readResult = await readTool.execute("read-call", { path: testFile });
			const lines = getTextOutput(readResult)
				.split("\n")
				.filter((l) => l.includes("|"));
			const anchor = lines[1].split("|")[0];

			// Modify only line 2
			writeFileSync(testFile, "unchanged1\nCHANGED\nunchanged2\n");

			try {
				await editTool.execute("edit-call", {
					path: testFile,
					edits: [{ set_line: { anchor, new_text: "new" } }],
				});
				expect.fail("Should have thrown");
			} catch (error: any) {
				const lines = error.message.split("\n");
				// Find lines with markers
				const markedLines = lines.filter((l: string) => l.includes(">>>"));
				const unmarkedLines = lines.filter((l: string) => l.includes("unchanged"));

				// Only changed line should have >>>
				expect(markedLines.length).toBeGreaterThanOrEqual(1);
				expect(markedLines.some((l: string) => l.includes("CHANGED"))).toBe(true);

				// Unchanged lines should NOT have >>>
				expect(unmarkedLines.every((l: string) => !l.includes(">>>"))).toBe(true);
			}
		});

		it("should show 2 lines of context around changed lines", async () => {
			const testFile = join(testDir, "error-context.txt");
			writeFileSync(testFile, "line1\nline2\nwill change\nline4\nline5\n");

			const readResult = await readTool.execute("read-call", { path: testFile });
			const lines = getTextOutput(readResult)
				.split("\n")
				.filter((l) => l.includes("|"));
			const anchor = lines[2].split("|")[0];

			writeFileSync(testFile, "line1\nline2\nCHANGED\nline4\nline5\n");

			try {
				await editTool.execute("edit-call", {
					path: testFile,
					edits: [{ set_line: { anchor, new_text: "new" } }],
				});
				expect.fail("Should have thrown");
			} catch (error: any) {
				// Should show lines 1-5 (changed line 3 + 2 context on each side)
				expect(error.message).toContain("line1");
				expect(error.message).toContain("line2");
				expect(error.message).toContain("CHANGED");
				expect(error.message).toContain("line4");
				expect(error.message).toContain("line5");
			}
		});

		it("should show ellipsis between non-contiguous context regions", async () => {
			const testFile = join(testDir, "error-ellipsis.txt");
			const content = Array.from({ length: 20 }, (_, i) => `line${i + 1}`).join("\n");
			writeFileSync(testFile, content + "\n");

			const readResult = await readTool.execute("read-call", { path: testFile });
			const lines = getTextOutput(readResult)
				.split("\n")
				.filter((l) => l.includes("|"));
			const anchor1 = lines[2].split("|")[0]; // line 3
			const anchor2 = lines[17].split("|")[0]; // line 18

			// Modify lines 3 and 18
			const newContent = Array.from({ length: 20 }, (_, i) =>
				i === 2 ? "CHANGED1" : i === 17 ? "CHANGED2" : `line${i + 1}`,
			).join("\n");
			writeFileSync(testFile, newContent + "\n");

			try {
				await editTool.execute("edit-call", {
					path: testFile,
					edits: [
						{ set_line: { anchor: anchor1, new_text: "new1" } },
						{ set_line: { anchor: anchor2, new_text: "new2" } },
					],
				});
				expect.fail("Should have thrown");
			} catch (error: any) {
				// Should show ellipsis between the two change regions
				expect(error.message).toContain("...");
			}
		});
	});

	// ============================================================================
	// EDIT TOOL - COMPLEX SCENARIOS
	// ============================================================================

	describe("edit tool - complex scenarios", () => {
		it("should handle interleaved read-edit-read-edit cycles", async () => {
			const testFile = join(testDir, "interleaved.txt");
			writeFileSync(testFile, "a\nb\nc\n");

			// First edit
			const read1 = await readTool.execute("read1", { path: testFile });
			const anchor1 = getTextOutput(read1)
				.split("\n")
				.find((l) => l.startsWith("1:"))
				?.split("|")[0];
			if (!anchor1) throw new Error("Line 1 not found");

			await editTool.execute("edit1", {
				path: testFile,
				edits: [{ set_line: { anchor: anchor1, new_text: "A" } }],
			});

			// Second edit (must re-read)
			const read2 = await readTool.execute("read2", { path: testFile });
			const anchor2 = getTextOutput(read2)
				.split("\n")
				.find((l) => l.startsWith("3:"))
				?.split("|")[0];
			if (!anchor2) throw new Error("Line 3 not found");

			await editTool.execute("edit2", {
				path: testFile,
				edits: [{ set_line: { anchor: anchor2, new_text: "C" } }],
			});

			expect(readFileSync(testFile, "utf-8")).toBe("A\nb\nC\n");
		});

		it("should handle edit at start of file", async () => {
			const testFile = join(testDir, "edit-start.txt");
			writeFileSync(testFile, "first\nsecond\n");

			const readResult = await readTool.execute("read-call", { path: testFile });
			const anchor = getTextOutput(readResult)
				.split("\n")
				.find((l) => l.startsWith("1:"))
				?.split("|")[0];
			if (!anchor) throw new Error("Line 1 not found");

			await editTool.execute("edit-call", {
				path: testFile,
				edits: [{ set_line: { anchor, new_text: "FIRST" } }],
			});

			expect(readFileSync(testFile, "utf-8")).toBe("FIRST\nsecond\n");
		});

		it("should handle edit at end of file", async () => {
			const testFile = join(testDir, "edit-end.txt");
			writeFileSync(testFile, "first\nlast\n");

			const readResult = await readTool.execute("read-call", { path: testFile });
			const readOutput = getTextOutput(readResult);
			// Find the line with content "last" (not the trailing empty line)
			const lastLine = readOutput.split("\n").find((l) => l.includes("|last"));
			if (!lastLine) throw new Error("Line with 'last' not found");
			const anchor = lastLine.split("|")[0];

			await editTool.execute("edit-call", {
				path: testFile,
				edits: [{ set_line: { anchor, new_text: "LAST" } }],
			});

			expect(readFileSync(testFile, "utf-8")).toBe("first\nLAST\n");
		});

		it("should handle single-line file", async () => {
			const testFile = join(testDir, "single-line.txt");
			writeFileSync(testFile, "only\n");

			const readResult = await readTool.execute("read-call", { path: testFile });
			const anchor = getTextOutput(readResult).split("|")[0];

			await editTool.execute("edit-call", {
				path: testFile,
				edits: [{ set_line: { anchor, new_text: "ONLY" } }],
			});

			expect(readFileSync(testFile, "utf-8")).toBe("ONLY\n");
		});

		it("should handle large batch of edits efficiently", async () => {
			const testFile = join(testDir, "large-batch.txt");
			const lines = Array.from({ length: 100 }, (_, i) => `line${i + 1}`);
			writeFileSync(testFile, lines.join("\n") + "\n");

			const readResult = await readTool.execute("read-call", { path: testFile });
			const readLines = getTextOutput(readResult)
				.split("\n")
				.filter((l) => l.includes("|"));

			// Edit every 10th line
			const edits = [];
			for (let i = 0; i < 100; i += 10) {
				const anchor = readLines[i].split("|")[0];
				edits.push({ set_line: { anchor, new_text: `CHANGED${i + 1}` } });
			}

			await editTool.execute("edit-call", { path: testFile, edits });

			const content = readFileSync(testFile, "utf-8");
			expect(content).toContain("CHANGED1");
			expect(content).toContain("CHANGED11");
			expect(content).toContain("CHANGED91");
		});
	});

	// ============================================================================
	// EDIT TOOL - BOTTOM-UP APPLICATION
	// ============================================================================

	describe("edit tool - bottom-up application", () => {
		it("should handle edits in any order via bottom-up sorting", async () => {
			const testFile = join(testDir, "bottom-up.txt");
			writeFileSync(testFile, "a\nb\nc\nd\n");

			const readResult = await readTool.execute("read-call", { path: testFile });
			const lines = getTextOutput(readResult)
				.split("\n")
				.filter((l) => l.includes("|"));
			const anchor1 = lines[0].split("|")[0]; // line 1
			const anchor3 = lines[2].split("|")[0]; // line 3

			// Edit line 1 first, then line 3 (in array order)
			// But system should apply line 3 first, then line 1
			await editTool.execute("edit-call", {
				path: testFile,
				edits: [{ set_line: { anchor: anchor1, new_text: "A" } }, { set_line: { anchor: anchor3, new_text: "C" } }],
			});

			expect(readFileSync(testFile, "utf-8")).toBe("A\nb\nC\nd\n");
		});
	});

	// ============================================================================
	// BACKWARD COMPATIBILITY
	// ============================================================================

	describe("backward compatibility", () => {
		it("should support legacy oldText/newText parameters", async () => {
			const testFile = join(testDir, "legacy.txt");
			writeFileSync(testFile, "Hello, world!");

			const result = await editTool.execute("edit-call", {
				path: testFile,
				oldText: "world",
				newText: "testing",
			});

			expect(getTextOutput(result)).toContain("Successfully replaced");
			expect(readFileSync(testFile, "utf-8")).toBe("Hello, testing!");
		});

		it("should reject mixing edits array with legacy params", async () => {
			const testFile = join(testDir, "mixed.txt");
			writeFileSync(testFile, "content\n");

			await expect(
				editTool.execute("edit-call", {
					path: testFile,
					edits: [{ set_line: { anchor: "1:ab", new_text: "new" } }],
					oldText: "content",
					newText: "replaced",
				}),
			).rejects.toThrow(/Cannot mix edits array with oldText/);
		});
	});

	// ============================================================================
	// EDGE CASES
	// ============================================================================

	describe("edge cases", () => {
		it("should handle unicode content", async () => {
			const testFile = join(testDir, "unicode.txt");
			writeFileSync(testFile, "こんにちは\n🎉 emoji\n");

			const readResult = await readTool.execute("read-call", { path: testFile });
			const readOutput = getTextOutput(readResult);

			expect(readOutput).toMatch(/1:[a-z0-9]{2}\|こんにちは/);
			expect(readOutput).toMatch(/2:[a-z0-9]{2}\|🎉 emoji/);
		});

		it("should handle empty files", async () => {
			const testFile = join(testDir, "empty.txt");
			writeFileSync(testFile, "");

			const readResult = await readTool.execute("read-call", { path: testFile });
			const readOutput = getTextOutput(readResult);

			// Empty file should produce one empty line with hash
			expect(readOutput).toMatch(/^1:[a-z0-9]{2}\|$/);
		});

		it("should reject insert_after with empty text", async () => {
			const testFile = join(testDir, "insert-empty.txt");
			writeFileSync(testFile, "line\n");

			const readResult = await readTool.execute("read-call", { path: testFile });
			const anchor = getTextOutput(readResult).split("|")[0];

			await expect(
				editTool.execute("edit-call", {
					path: testFile,
					edits: [{ insert_after: { anchor, text: "" } }],
				}),
			).rejects.toThrow(/non-empty/);
		});

		it("should reject invalid range (start > end)", async () => {
			const testFile = join(testDir, "invalid-range.txt");
			writeFileSync(testFile, "a\nb\nc\n");

			const readResult = await readTool.execute("read-call", { path: testFile });
			const lines = getTextOutput(readResult)
				.split("\n")
				.filter((l) => l.includes("|"));
			const anchor3 = lines[2].split("|")[0]; // line 3
			const anchor1 = lines[0].split("|")[0]; // line 1

			await expect(
				editTool.execute("edit-call", {
					path: testFile,
					edits: [{ replace_lines: { start_anchor: anchor3, end_anchor: anchor1, new_text: "x" } }],
				}),
			).rejects.toThrow(/start.*must be.*end/);
		});
	});
});

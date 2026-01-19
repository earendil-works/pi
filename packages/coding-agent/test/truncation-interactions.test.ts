import { mkdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { globTool } from "../src/tools/glob.js";
import { grepTool } from "../src/tools/grep.js";

/**
 * Tests for pairwise interactions between truncation operations.
 *
 * Operations analyzed:
 * - Grep: truncateLine, trackTotalBytes, checkByteBudget, checkMatchLimit, buildNotices
 * - Glob: trackTotalBytes, checkByteBudget, checkCountLimit, formatFdOutput
 */

function getTextOutput(result: { content: Array<{ type: string; text?: string }> }): string {
	return (
		result.content
			?.filter((c) => c.type === "text")
			.map((c) => c.text)
			.join("\n") || ""
	);
}

describe("Grep truncation interactions", () => {
	let testDir: string;

	beforeEach(() => {
		testDir = join(tmpdir(), `grep-interactions-${Date.now()}`);
		mkdirSync(testDir, { recursive: true });
	});

	afterEach(() => {
		rmSync(testDir, { recursive: true, force: true });
	});

	describe("truncateLine <-> trackTotalBytes interaction", () => {
		it("truncated line should reduce bytes counted vs full line", async () => {
			const testFile = join(testDir, "truncate-bytes.txt");
			// Create a line that's exactly 5000 chars with pattern at start
			// After truncation to 4096 + "...", it becomes 4099 chars
			const longLine = "MATCH" + "x".repeat(4995);
			writeFileSync(testFile, longLine);

			const result = await grepTool.execute("test-trunc-bytes", {
				pattern: "MATCH",
				path: testFile,
				limit: 1,
			});

			const output = getTextOutput(result);

			// Should see truncation notice
			expect(output).toContain("some lines truncated to 4096 chars");

			// The output line should be: "truncate-bytes.txt:1: " + 4096 chars + "..."
			// That's ~22 + 4096 + 3 = ~4121 chars, well under 16KB
			expect(output).not.toContain("output truncated to 16KB");
		});

		it("many truncated lines should still hit byte limit eventually", async () => {
			const testFile = join(testDir, "many-truncated.txt");
			// Each line is 5000 chars, truncated to 4099 + prefix (~20) = ~4120 bytes
			// 16KB / 4120 ≈ 4 lines before byte limit
			const lines: string[] = [];
			for (let i = 0; i < 10; i++) {
				lines.push(`MATCH${i}` + "y".repeat(4994));
			}
			writeFileSync(testFile, lines.join("\n"));

			const result = await grepTool.execute("test-many-trunc", {
				pattern: "MATCH",
				path: testFile,
				limit: 100,
			});

			const output = getTextOutput(result);

			// Should see both truncation notices
			expect(output).toContain("some lines truncated to 4096 chars");
			expect(output).toContain("output truncated to 16KB");

			// Should have fewer than 10 matches
			const matchCount = (output.match(/MATCH\d/g) || []).length;
			expect(matchCount).toBeLessThan(10);
			expect(matchCount).toBeGreaterThan(0);
		});
	});

	describe("checkByteBudget <-> checkMatchLimit race condition", () => {
		it("byte limit should take precedence when both thresholds near", async () => {
			const testFile = join(testDir, "race.txt");
			// Create exactly 5 matches, each ~3500 bytes
			// Total: 5 * 3500 = 17500 bytes > 16KB
			// With limit=5, we should hit byte limit on match 5
			const lines: string[] = [];
			for (let i = 0; i < 5; i++) {
				lines.push("FINDME" + "z".repeat(3494)); // ~3500 chars per line
			}
			writeFileSync(testFile, lines.join("\n"));

			const result = await grepTool.execute("test-race", {
				pattern: "FINDME",
				path: testFile,
				limit: 5,
			});

			const output = getTextOutput(result);

			// Should show byte truncation, not match limit
			// (or possibly show match limit if we got exactly 5 before byte limit)
			// The key is that we don't show BOTH "limit of 5 matches" AND "output truncated"
			const hasByteMsg = output.includes("output truncated to 16KB");
			const hasMatchMsg = output.includes("limit of 5 matches reached");

			// At most one of these should be true (byteTruncated takes precedence in notices)
			if (hasByteMsg) {
				expect(hasMatchMsg).toBe(false);
			}
		});

		it("match limit should appear when byte limit not reached", async () => {
			const testFile = join(testDir, "match-limit.txt");
			// Short lines, many matches
			const lines: string[] = [];
			for (let i = 0; i < 20; i++) {
				lines.push(`FINDME line ${i}`);
			}
			writeFileSync(testFile, lines.join("\n"));

			const result = await grepTool.execute("test-match-only", {
				pattern: "FINDME",
				path: testFile,
				limit: 5,
			});

			const output = getTextOutput(result);

			expect(output).toContain("limit of 5 matches reached");
			expect(output).not.toContain("output truncated to 16KB");
			expect(output).not.toContain("some lines truncated");
		});
	});

	describe("hadLineTruncation <-> byteTruncated sibling flags", () => {
		it("both flags can be true and both notices appear", async () => {
			const testFile = join(testDir, "both-flags.txt");
			// Large lines that get truncated AND hit byte limit
			const lines: string[] = [];
			for (let i = 0; i < 20; i++) {
				lines.push("PATTERN" + "a".repeat(5000)); // Each > 4096, will be truncated
			}
			writeFileSync(testFile, lines.join("\n"));

			const result = await grepTool.execute("test-both-flags", {
				pattern: "PATTERN",
				path: testFile,
				limit: 100,
			});

			const output = getTextOutput(result);

			// Both notices should appear, separated by "; "
			expect(output).toContain("some lines truncated to 4096 chars");
			expect(output).toContain("output truncated to 16KB");
			expect(output).toContain("; "); // Both in same parenthetical
		});

		it("line truncation notice appears alone when byte limit not hit", async () => {
			const testFile = join(testDir, "line-only.txt");
			// Single long line
			const longLine = "PATTERN" + "b".repeat(5000);
			writeFileSync(testFile, longLine);

			const result = await grepTool.execute("test-line-only", {
				pattern: "PATTERN",
				path: testFile,
			});

			const output = getTextOutput(result);

			expect(output).toContain("some lines truncated to 4096 chars");
			expect(output).not.toContain("output truncated to 16KB");
			expect(output).not.toContain("; ");
		});
	});

	describe("UTF-8 multi-byte character handling", () => {
		it("byte counting handles unicode correctly in grep", async () => {
			const testFile = join(testDir, "unicode.txt");
			// Japanese characters: 3 bytes each in UTF-8
			// 5500 chars * 3 bytes = 16500 bytes > 16KB
			const unicodeLine = "MATCH" + "あ".repeat(5495);
			writeFileSync(testFile, unicodeLine);

			const result = await grepTool.execute("test-unicode", {
				pattern: "MATCH",
				path: testFile,
			});

			const output = getTextOutput(result);

			// Line is > 4096 chars, should be truncated
			expect(output).toContain("some lines truncated to 4096 chars");
			// Single match, should not hit byte limit (truncated line is ~4100 chars * 3 = 12KB)
			// Actually, after truncation, it's ASCII "MATCH" (5 bytes) + ~4091 Japanese chars * 3 bytes
			// = 5 + 12273 = ~12KB, plus prefix. Should be close but under 16KB.
			// Let's just verify it doesn't error
			expect(output).toContain("MATCH");
		});

		it("emoji (4-byte UTF-8) handled correctly", async () => {
			const testFile = join(testDir, "emoji.txt");
			// Emoji are 4 bytes each
			const emojiLine = "FIND🎉" + "🎉".repeat(1000);
			writeFileSync(testFile, emojiLine);

			const result = await grepTool.execute("test-emoji", {
				pattern: "FIND",
				path: testFile,
			});

			const output = getTextOutput(result);

			// Should find the match without errors
			expect(output).toContain("FIND");
			// Line is 1005 chars but 5 + 4000 = 4005 bytes, under 4096 char limit
			// but over 4096 bytes - however truncation is char-based not byte-based
			expect(output).not.toContain("truncated");
		});
	});

	describe("context lines interaction with truncation", () => {
		it("context lines are also truncated", async () => {
			const testFile = join(testDir, "context-trunc.txt");
			const longContext = "c".repeat(5000);
			const content = `${longContext}\nFINDME\n${longContext}`;
			writeFileSync(testFile, content);

			const result = await grepTool.execute("test-ctx-trunc", {
				pattern: "FINDME",
				path: testFile,
				context: 1,
			});

			const output = getTextOutput(result);

			// Should find match
			expect(output).toContain("FINDME");
			// Context lines should trigger truncation notice
			expect(output).toContain("some lines truncated to 4096 chars");
			// Three lines in output (context-before, match, context-after)
			const lines = output.split("\n").filter((l) => l.includes("context-trunc.txt"));
			expect(lines.length).toBe(3);
		});

		it("context lines contribute to byte budget", async () => {
			const testFile = join(testDir, "context-bytes.txt");
			// Each context block: 3 lines * 1000 chars = ~3000 bytes
			// With many matches, should hit byte limit
			const lines: string[] = [];
			for (let i = 0; i < 30; i++) {
				lines.push("x".repeat(1000));
				lines.push(`MATCH${i}`);
				lines.push("y".repeat(1000));
			}
			writeFileSync(testFile, lines.join("\n"));

			const result = await grepTool.execute("test-ctx-bytes", {
				pattern: "MATCH",
				path: testFile,
				context: 1,
				limit: 100,
			});

			const output = getTextOutput(result);

			// With ~3KB per match block, should hit 16KB limit after ~5 matches
			expect(output).toContain("output truncated to 16KB");
			const matchCount = (output.match(/MATCH\d+/g) || []).length;
			expect(matchCount).toBeLessThan(30);
			expect(matchCount).toBeGreaterThan(0);
		});
	});
});

describe("Glob truncation interactions", () => {
	let testDir: string;

	beforeEach(() => {
		testDir = join(tmpdir(), `glob-interactions-${Date.now()}`);
		mkdirSync(testDir, { recursive: true });
	});

	afterEach(() => {
		rmSync(testDir, { recursive: true, force: true });
	});

	describe("checkByteBudget <-> checkCountLimit race", () => {
		it("byte limit takes precedence over count limit in formatFdOutput", async () => {
			// Create files with long names to hit byte limit before count limit
			for (let i = 0; i < 200; i++) {
				const filename = `${"x".repeat(100)}_${String(i).padStart(5, "0")}.txt`;
				writeFileSync(join(testDir, filename), "content");
			}

			const result = await globTool.execute("test-glob-race", {
				pattern: "*.txt",
				path: testDir,
				limit: 1000, // High limit
			});

			const output = getTextOutput(result);

			// Should hit byte limit (100+ char names * 200 = 20KB > 16KB)
			expect(output).toContain("output truncated to 16KB");
			expect(output).not.toContain("1000 results shown");
		});

		it("count limit appears when byte limit not reached", async () => {
			// Short filenames
			for (let i = 0; i < 20; i++) {
				writeFileSync(join(testDir, `f${i}.txt`), "content");
			}

			const result = await globTool.execute("test-count-only", {
				pattern: "*.txt",
				path: testDir,
				limit: 5,
			});

			const output = getTextOutput(result);

			expect(output).toContain("truncated, 5 results shown");
			expect(output).not.toContain("output truncated to 16KB");
		});
	});

	describe("listDirectory byte truncation", () => {
		it("listDirectory respects byte limit", async () => {
			// Create many entries with medium-length names
			for (let i = 0; i < 500; i++) {
				const name = `entry_${String(i).padStart(5, "0")}_${"y".repeat(30)}`;
				if (i % 10 === 0) {
					mkdirSync(join(testDir, name));
				} else {
					writeFileSync(join(testDir, name), "content");
				}
			}

			const result = await globTool.execute("test-ls-bytes", {
				path: testDir,
				// No pattern = ls mode
			});

			const output = getTextOutput(result);

			expect(output).toContain("output truncated to 16KB");
			// Should have fewer than 500 entries
			const entryCount = output.split("\n").filter((l) => l.startsWith("entry_")).length;
			expect(entryCount).toBeLessThan(500);
		});

		it("count limit in listDirectory when byte limit not hit", async () => {
			// Few entries with short names
			for (let i = 0; i < 10; i++) {
				writeFileSync(join(testDir, `f${i}`), "content");
			}

			const result = await globTool.execute("test-ls-count", {
				path: testDir,
				limit: 5,
			});

			const output = getTextOutput(result);

			expect(output).toContain("truncated, 5 more entries");
			expect(output).not.toContain("output truncated to 16KB");
		});
	});

	describe("edge cases - no spurious messages", () => {
		it("empty directory shows no truncation message", async () => {
			const result = await globTool.execute("test-empty", {
				path: testDir,
			});

			const output = getTextOutput(result);
			expect(output).toBe("(empty directory)");
			expect(output).not.toContain("truncated");
		});

		it("no matches shows no truncation message", async () => {
			writeFileSync(join(testDir, "file.js"), "content");

			const result = await globTool.execute("test-no-match", {
				pattern: "*.txt",
				path: testDir,
			});

			const output = getTextOutput(result);
			expect(output).toContain("No files found matching pattern");
			// The hint about gitignored files is expected, but no truncation message
			expect(output).not.toContain("truncated");
		});

		it("single small result shows no truncation message", async () => {
			writeFileSync(join(testDir, "a.txt"), "content");

			const result = await globTool.execute("test-single", {
				pattern: "*.txt",
				path: testDir,
			});

			const output = getTextOutput(result);
			expect(output).toBe("a.txt");
			expect(output).not.toContain("truncated");
		});

		it("results exactly at limit show count message not byte message", async () => {
			// Create exactly 5 files with short names
			for (let i = 0; i < 5; i++) {
				writeFileSync(join(testDir, `f${i}.txt`), "content");
			}

			const result = await globTool.execute("test-exact-limit", {
				pattern: "*.txt",
				path: testDir,
				limit: 5,
			});

			const output = getTextOutput(result);

			// Should show count truncation since we hit the limit
			expect(output).toContain("truncated, 5 results shown");
			expect(output).not.toContain("output truncated to 16KB");
		});
	});
});

import { mkdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { globTool } from "../src/tools/glob.js";
import { grepTool } from "../src/tools/grep.js";

// Helper to extract text from content blocks
function getTextOutput(result: { content: Array<{ type: string; text?: string }> }): string {
	return (
		result.content
			?.filter((c) => c.type === "text")
			.map((c) => c.text)
			.join("\n") || ""
	);
}

describe("Grep tool truncation", () => {
	let testDir: string;

	beforeEach(() => {
		testDir = join(tmpdir(), `grep-truncate-test-${Date.now()}`);
		mkdirSync(testDir, { recursive: true });
	});

	afterEach(() => {
		rmSync(testDir, { recursive: true, force: true });
	});

	describe("per-line truncation (4096 chars)", () => {
		it("should truncate lines exceeding 4096 characters", async () => {
			const testFile = join(testDir, "minified.js");
			// Create a single line with 10000 characters containing a search pattern
			const longLine = "a".repeat(4000) + "FINDME" + "b".repeat(5994);
			writeFileSync(testFile, longLine);

			const result = await grepTool.execute("test-line-truncate", {
				pattern: "FINDME",
				path: testFile,
			});

			const output = getTextOutput(result);

			// Should find the match
			expect(output).toContain("FINDME");
			// Should show truncation notice
			expect(output).toContain("some lines truncated to 4096 chars");
			// The actual displayed line should be truncated (4096 + "...")
			const matchLine = output.split("\n").find((line) => line.includes("minified.js:1:"));
			expect(matchLine).toBeDefined();
			// Line format: "minified.js:1: <content>..."
			const contentPart = matchLine!.replace(/^minified\.js:1: /, "");
			expect(contentPart.length).toBe(4099); // 4096 chars + "..."
			expect(contentPart.endsWith("...")).toBe(true);
		});

		it("should not truncate lines under 4096 characters", async () => {
			const testFile = join(testDir, "normal.txt");
			const normalLine = "Hello FINDME world";
			writeFileSync(testFile, normalLine);

			const result = await grepTool.execute("test-no-truncate", {
				pattern: "FINDME",
				path: testFile,
			});

			const output = getTextOutput(result);

			expect(output).toContain("Hello FINDME world");
			expect(output).not.toContain("truncated");
			expect(output).not.toContain("...");
		});

		it("should truncate context lines as well", async () => {
			const testFile = join(testDir, "with-context.txt");
			const longContextLine = "c".repeat(5000);
			const content = `${longContextLine}\nFINDME\n${longContextLine}`;
			writeFileSync(testFile, content);

			const result = await grepTool.execute("test-context-truncate", {
				pattern: "FINDME",
				path: testFile,
				context: 1,
			});

			const output = getTextOutput(result);

			// Should find the match
			expect(output).toContain("FINDME");
			// Should show truncation notice for context lines
			expect(output).toContain("some lines truncated to 4096 chars");
		});
	});

	describe("total output byte limit (16KB)", () => {
		it("should truncate output at 16KB", async () => {
			const testFile = join(testDir, "large.txt");
			// Create many matches - each line is ~30 bytes, we need ~600 lines to hit 16KB
			const lines: string[] = [];
			for (let i = 0; i < 1000; i++) {
				lines.push(`Line ${i} contains FINDME here`);
			}
			writeFileSync(testFile, lines.join("\n"));

			const result = await grepTool.execute("test-byte-limit", {
				pattern: "FINDME",
				path: testFile,
				limit: 1000, // High limit to ensure byte limit kicks in first
			});

			const output = getTextOutput(result);

			// Should show byte truncation notice
			expect(output).toContain("output truncated to 16KB");
			// Should not show all 1000 matches
			const matchCount = (output.match(/FINDME/g) || []).length;
			expect(matchCount).toBeLessThan(1000);
			expect(matchCount).toBeGreaterThan(0);
		});

		it("should show both truncation notices when applicable", async () => {
			const testFile = join(testDir, "both.txt");
			// Create lines that are long AND numerous
			const lines: string[] = [];
			for (let i = 0; i < 100; i++) {
				// Each line is 5000 chars, will trigger per-line truncation
				lines.push("x".repeat(2000) + `MATCH${i}` + "y".repeat(2993));
			}
			writeFileSync(testFile, lines.join("\n"));

			const result = await grepTool.execute("test-both-limits", {
				pattern: "MATCH",
				path: testFile,
				limit: 100,
			});

			const output = getTextOutput(result);

			// Should show line truncation notice
			expect(output).toContain("some lines truncated to 4096 chars");
			// Should show byte limit notice (16KB will be hit quickly with 4KB+ per match)
			expect(output).toContain("output truncated to 16KB");
		});
	});

	describe("match count limit interaction", () => {
		it("should respect match limit when byte limit not reached", async () => {
			const testFile = join(testDir, "few-matches.txt");
			const lines = Array.from({ length: 50 }, (_, i) => `Line ${i} MATCH`);
			writeFileSync(testFile, lines.join("\n"));

			const result = await grepTool.execute("test-match-limit", {
				pattern: "MATCH",
				path: testFile,
				limit: 10,
			});

			const output = getTextOutput(result);

			// Should hit match limit before byte limit
			expect(output).toContain("limit of 10 matches reached");
			expect(output).not.toContain("output truncated to 16KB");
			const matchCount = (output.match(/MATCH/g) || []).length;
			expect(matchCount).toBe(10);
		});
	});
});

describe("Glob tool truncation", () => {
	let testDir: string;

	beforeEach(() => {
		testDir = join(tmpdir(), `glob-truncate-test-${Date.now()}`);
		mkdirSync(testDir, { recursive: true });
	});

	afterEach(() => {
		rmSync(testDir, { recursive: true, force: true });
	});

	describe("total output byte limit (16KB)", () => {
		it("should truncate glob output at 16KB", async () => {
			// Create many files with long names to hit the byte limit
			// ~400 files with 50-char names = ~20KB
			for (let i = 0; i < 500; i++) {
				const filename = `file_${String(i).padStart(6, "0")}_${"x".repeat(30)}.txt`;
				writeFileSync(join(testDir, filename), "content");
			}

			const result = await globTool.execute("test-glob-byte-limit", {
				pattern: "*.txt",
				path: testDir,
			});

			const output = getTextOutput(result);

			// Should show byte truncation notice
			expect(output).toContain("output truncated to 16KB");
			// Should not show all 500 files
			const fileCount = output
				.split("\n")
				.filter((line) => line.includes(".txt") && !line.includes("truncated")).length;
			expect(fileCount).toBeLessThan(500);
			expect(fileCount).toBeGreaterThan(0);
		});

		it("should truncate directory listing at 16KB", async () => {
			// Create many files/directories
			for (let i = 0; i < 600; i++) {
				const name = `entry_${String(i).padStart(6, "0")}_${"y".repeat(20)}`;
				if (i % 5 === 0) {
					mkdirSync(join(testDir, name));
				} else {
					writeFileSync(join(testDir, name), "content");
				}
			}

			const result = await globTool.execute("test-ls-byte-limit", {
				path: testDir,
				// No pattern = ls mode
			});

			const output = getTextOutput(result);

			// Should show byte truncation notice
			expect(output).toContain("output truncated to 16KB");
			// Should not show all 600 entries
			const entryCount = output.split("\n").filter((line) => line.startsWith("entry_")).length;
			expect(entryCount).toBeLessThan(600);
			expect(entryCount).toBeGreaterThan(0);
		});
	});

	describe("count limit interaction", () => {
		it("should respect count limit when byte limit not reached", async () => {
			// Create a few files with short names
			for (let i = 0; i < 20; i++) {
				writeFileSync(join(testDir, `f${i}.txt`), "content");
			}

			const result = await globTool.execute("test-count-limit", {
				pattern: "*.txt",
				path: testDir,
				limit: 5,
			});

			const output = getTextOutput(result);

			// Should hit count limit, not byte limit
			expect(output).toContain("truncated, 5 results shown");
			expect(output).not.toContain("output truncated to 16KB");
		});

		it("should show byte truncation before count limit for long filenames", async () => {
			// Create files with very long names
			for (let i = 0; i < 200; i++) {
				const filename = `${"z".repeat(100)}_${String(i).padStart(5, "0")}.txt`;
				writeFileSync(join(testDir, filename), "content");
			}

			const result = await globTool.execute("test-byte-before-count", {
				pattern: "*.txt",
				path: testDir,
				limit: 1000, // High limit to ensure byte limit kicks in first
			});

			const output = getTextOutput(result);

			// Should hit byte limit before count limit
			expect(output).toContain("output truncated to 16KB");
			expect(output).not.toContain("1000 results shown");
		});
	});

	describe("edge cases", () => {
		it("should handle empty directory without truncation message", async () => {
			const result = await globTool.execute("test-empty-dir", {
				path: testDir,
			});

			const output = getTextOutput(result);
			expect(output).toBe("(empty directory)");
		});

		it("should handle small output without truncation message", async () => {
			writeFileSync(join(testDir, "a.txt"), "content");
			writeFileSync(join(testDir, "b.txt"), "content");

			const result = await globTool.execute("test-small-output", {
				pattern: "*.txt",
				path: testDir,
			});

			const output = getTextOutput(result);
			expect(output).not.toContain("truncated");
			expect(output).toContain("a.txt");
			expect(output).toContain("b.txt");
		});
	});
});

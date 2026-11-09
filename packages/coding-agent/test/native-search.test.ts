import {
	chmodSync,
	closeSync,
	mkdirSync,
	mkdtempSync,
	openSync,
	rmSync,
	symlinkSync,
	truncateSync,
	utimesSync,
	writeFileSync,
	writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFindTool } from "../src/core/tools/find.ts";
import { createGrepTool } from "../src/core/tools/grep.ts";

let root: string;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "pi-native-search-"));
});
afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

describe("native grep", () => {
	it("uses PCRE2 for lookaround and backreferences, and preserves literal matching", async () => {
		writeFileSync(join(root, "source.txt"), "foofoo\nfoobar\na.b\naXb\n");
		const grep = createGrepTool(root);
		const advanced = await grep.execute("pcre2", { pattern: "(foo)\\1(?=$)", context: 0 });
		expect(advanced.content).toEqual([{ type: "text", text: "source.txt:1: foofoo" }]);
		const literal = await grep.execute("literal", { pattern: "a.b", literal: true, context: 0 });
		expect(literal.content).toEqual([{ type: "text", text: "source.txt:3: a.b" }]);
	});

	it.each(["^(a(?1)?b)$", "^(a(?1)?b)$|c\\nd"])(
		"matches nested PCRE2 recursion without exhausting the default JIT stack: %s",
		async (pattern) => {
			writeFileSync(join(root, "source.txt"), `${"a".repeat(1000)}${"b".repeat(1000)}\n`);
			const result = await createGrepTool(root).execute("recursive-pcre2", {
				pattern,
				path: "source.txt",
				context: 0,
			});
			expect(result.details?.matchCount).toBe(1);
			expect(result.details?.files).toEqual(["source.txt"]);
		},
	);

	it("applies line ranges before match caps and supports multiline patterns", async () => {
		writeFileSync(join(root, "source.txt"), `${Array(250).fill("needle").join("\n")}\nalpha\nbeta\nneedle\n`);
		const grep = createGrepTool(root);
		const ranged = await grep.execute("range", { pattern: "needle", path: "source.txt:251-254", context: 0 });
		expect(ranged.content).toEqual([{ type: "text", text: "source.txt:253: needle" }]);
		const multiline = await grep.execute("multiline", { pattern: "alpha\\nbeta", path: "source.txt", context: 0 });
		expect(multiline.content).toEqual([{ type: "text", text: "source.txt:251: alpha\nsource.txt:252: beta" }]);
	});

	it("counts adjacent multiline spans individually and caps their displayed matches", async () => {
		writeFileSync(join(root, "source.txt"), "alpha\nbeta\n".repeat(30));
		const result = await createGrepTool(root).execute("multiline-cap", {
			pattern: "alpha\\nbeta",
			path: "source.txt",
			limit: 2,
			context: 1,
		});
		expect(result.details).toMatchObject({ matchCount: 2, matchLimitReached: 2 });
		expect(result.content[0]).toMatchObject({
			text: expect.stringMatching(
				/^source.txt:1: alpha\nsource.txt:2: beta\nsource.txt:3: alpha\nsource.txt:4: beta\nsource.txt-5- alpha\n\n/,
			),
		});
	});

	it("selects multiline spans inside ranges even when the coalesced block starts outside them", async () => {
		writeFileSync(join(root, "source.txt"), "alpha\nbeta\n".repeat(8));
		const grep = createGrepTool(root);
		const ranged = await grep.execute("multiline-range", {
			pattern: "alpha\\nbeta",
			path: "source.txt:5-8",
			context: 0,
		});
		expect(ranged.details?.matchCount).toBe(2);
		expect(ranged.content).toEqual([
			{ type: "text", text: "source.txt:5: alpha\nsource.txt:6: beta\nsource.txt:7: alpha\nsource.txt:8: beta" },
		]);
		const disjoint = await grep.execute("multiline-disjoint", {
			pattern: "alpha\\nbeta",
			path: "source.txt:5-6,9-10",
			context: 0,
		});
		expect(disjoint.content).toEqual([
			{ type: "text", text: "source.txt:5: alpha\nsource.txt:6: beta\nsource.txt:9: alpha\nsource.txt:10: beta" },
		]);
	});

	it("does not duplicate a line shared by distinct multiline spans", async () => {
		writeFileSync(join(root, "source.txt"), "ab\ncd\nEF\n");
		const result = await createGrepTool(root).execute("shared-line", {
			pattern: "ab\\nc|d\\nEF",
			path: "source.txt",
			context: 0,
		});
		expect(result.details?.matchCount).toBe(2);
		expect(result.content).toEqual([{ type: "text", text: "source.txt:1: ab\nsource.txt:2: cd\nsource.txt:3: EF" }]);
	});

	it("keeps a zero-width EOF match when the multiline alternative does not match", async () => {
		writeFileSync(join(root, "source.txt"), "end");
		const result = await createGrepTool(root).execute("multiline-eof", {
			pattern: "alpha\\nbeta|$",
			path: "source.txt",
			context: 0,
		});
		expect(result.details?.matchCount).toBe(1);
		expect(result.content).toEqual([{ type: "text", text: "source.txt:1: end" }]);
	});

	it("preserves preceding input for later multiline PCRE2 lookbehind matches", async () => {
		writeFileSync(join(root, "source.txt"), "a\nb\nc\n");
		const result = await createGrepTool(root).execute("multiline-lookbehind", {
			pattern: "a\\nb|(?<=b\\n)c",
			path: "source.txt",
			context: 0,
		});
		expect(result.details?.matchCount).toBe(2);
		expect(result.content).toEqual([{ type: "text", text: "source.txt:1: a\nsource.txt:2: b\nsource.txt:3: c" }]);
	});

	it.each(["(?=x)|a\\nb", "(?=\\C)|a\\nb"])(
		"reaches a late line range after frequent multiline PCRE2 matches: %s",
		async (pattern) => {
			writeFileSync(join(root, "source.txt"), "x\n".repeat(1_000_000));
			const result = await createGrepTool(root).execute("late-pcre2-range", {
				pattern,
				path: "source.txt:1000000-1000000",
				context: 0,
				limit: 1,
			});
			expect(result.details?.matchCount).toBe(1);
			const content = result.content[0];
			if (content.type !== "text") throw new Error("Expected text search results");
			expect([...content.text.matchAll(/^source\.txt:(\d+): (.*)$/gm)].map((match) => match.slice(1))).toEqual([
				["1000000", "x"],
			]);
		},
	);

	it.each(["é", "界", "😀"])("preserves later PCRE2 lookbehind after an empty match on %s", async (character) => {
		writeFileSync(join(root, "source.txt"), `${character}x\ny\n`);
		const result = await createGrepTool(root).execute("unicode-empty-match", {
			pattern: `(?=${character})|(?<=${character})x\\ny`,
			path: "source.txt",
			context: 0,
		});
		expect(result.details?.matchCount).toBe(2);
		expect(result.content).toEqual([{ type: "text", text: `source.txt:1: ${character}x\nsource.txt:2: y` }]);
	});

	it("keeps later lines searchable after byte matches end inside a UTF-8 character", async () => {
		writeFileSync(join(root, "source.txt"), "é\nneedle\n");
		const result = await createGrepTool(root).execute("pcre2-byte-offset", {
			pattern: "\\C|a\\nb",
			path: "source.txt:2-2",
			context: 0,
		});
		expect(result.content).toEqual([{ type: "text", text: "source.txt:2: needle" }]);
	});

	it("preserves PCRE2 matching after malformed UTF-8 in multiline subjects", async () => {
		writeFileSync(join(root, "source.txt"), Buffer.concat([Buffer.from([0xff]), Buffer.from("\né\nneedle\n")]));
		const result = await createGrepTool(root).execute("pcre2-invalid-utf8", {
			pattern: "(?<=é\\n)needle",
			path: "source.txt",
			context: 0,
		});
		expect(result.details?.matchCount).toBe(1);
		expect(result.content).toEqual([{ type: "text", text: "source.txt:3: needle" }]);
	});

	it("decodes BOM-marked UTF-16 before full-subject multiline matching", async () => {
		writeFileSync(
			join(root, "source.txt"),
			Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("界\n文\n終\n", "utf16le")]),
		);
		const result = await createGrepTool(root).execute("multiline-utf16", {
			pattern: "界\\n文|(?<=文\\n)終",
			path: "source.txt",
			context: 0,
		});
		expect(result.details?.matchCount).toBe(2);
		expect(result.content).toEqual([{ type: "text", text: "source.txt:1: 界\nsource.txt:2: 文\nsource.txt:3: 終" }]);
	});

	it.each([65533, 65534, 65535, 65536])(
		"decodes final UTF-16 replacement bytes after %i ASCII characters",
		async (count) => {
			writeFileSync(
				join(root, "source.txt"),
				Buffer.concat([
					Buffer.from([0xff, 0xfe]),
					Buffer.from("x".repeat(count), "utf16le"),
					Buffer.from([0x00, 0xd8]),
				]),
			);
			for (const pattern of ["�", "�|a\\nb"]) {
				const result = await createGrepTool(root).execute("utf16-flush", {
					pattern,
					path: "source.txt",
					context: 0,
				});
				expect(result.details?.matchCount).toBe(1);
				expect(result.content[0]).toMatchObject({ text: expect.stringContaining(`� [col ${count + 1}]`) });
			}
		},
	);

	it("does not search stale bytes when reusing the multiline input buffer across files", async () => {
		writeFileSync(join(root, "a.txt"), "a\nb\n".repeat(5));
		writeFileSync(join(root, "b.txt"), "other\n");
		const result = await createGrepTool(root).execute("reused-input", { pattern: "a\\nb", context: 0 });
		expect(result.details?.files).toEqual(["a.txt"]);
		expect(result.details?.matchCount).toBe(5);
	});

	it("discards context belonging to excluded multiline spans and keeps context inside the block", async () => {
		writeFileSync(join(root, "source.txt"), "before\nalpha\nbeta\nalpha\nbeta\nafter\n");
		const grep = createGrepTool(root);
		const adjacent = await grep.execute("multiline-context", {
			pattern: "alpha\\nbeta",
			path: "source.txt:3-5",
			context: 1,
		});
		expect(adjacent.content).toEqual([
			{ type: "text", text: "source.txt-3- beta\nsource.txt:4: alpha\nsource.txt:5: beta" },
		]);
		const disjoint = await grep.execute("multiline-context-rollback", {
			pattern: "alpha\\nbeta",
			path: "source.txt:1-1,4-5",
			context: 1,
		});
		expect(disjoint.content).toEqual([{ type: "text", text: "source.txt:4: alpha\nsource.txt:5: beta" }]);
		const wideBefore = await grep.execute("multiline-context-overlap", {
			pattern: "alpha\\nbeta",
			path: "source.txt:1-1,4-5",
			context: 3,
		});
		expect(wideBefore.content).toEqual([
			{ type: "text", text: "source.txt-1- before\nsource.txt:4: alpha\nsource.txt:5: beta" },
		]);
		writeFileSync(join(root, "partial.txt"), "head one\nhead two\nhead three\nalpha\nbeta\nalpha\nbeta\ntail\n");
		const partialBefore = await grep.execute("multiline-context-partial-overlap", {
			pattern: "alpha\\nbeta",
			path: "partial.txt:1-3,6-7",
			context: 4,
		});
		expect(partialBefore.content).toEqual([
			{
				type: "text",
				text: "partial.txt-2- head two\npartial.txt-3- head three\npartial.txt:6: alpha\npartial.txt:7: beta",
			},
		]);
	});

	it("bounds multiline input buffering while streaming larger short-line files", async () => {
		const file = join(root, "large.txt");
		const fd = openSync(file, "w");
		try {
			const chunk = Buffer.from("x\n".repeat(32 * 1024));
			for (let size = 0; size < 65 * 1024 * 1024; size += chunk.length) writeSync(fd, chunk);
		} finally {
			closeSync(fd);
		}
		const grep = createGrepTool(root);
		await expect(
			grep.execute("buffer-limit", { pattern: "alpha\\nbeta", path: "large.txt", limit: 1, context: 0 }),
		).rejects.toThrow(/allocation limit/i);
		const streamed = await grep.execute("streamed", { pattern: "x", path: "large.txt", limit: 1, context: 0 });
		expect(streamed.details?.matchCount).toBe(1);
		expect(streamed.content[0]).toMatchObject({ text: expect.stringMatching(/^large.txt:1: x\n\n/) });
		const skipped = await grep.execute("buffer-limit-directory", { pattern: "alpha\\nbeta", context: 0 });
		expect(skipped.content[0]).toMatchObject({ text: expect.stringMatching(/Skipped 1 files.*input-buffer limit/) });
		truncateSync(file, 64 * 1024 * 1024);
		const exact = await grep.execute("exact-buffer-limit", {
			pattern: "alpha\\nbeta",
			path: "large.txt",
			context: 0,
		});
		expect(exact.content).toEqual([{ type: "text", text: "No matches found" }]);
	});

	it("does not deduplicate a file rejected by another root's relative glob", async () => {
		mkdirSync(join(root, "src", "sub"), { recursive: true });
		writeFileSync(join(root, "src", "sub", "file.ts"), "needle\n");
		const result = await createGrepTool(root).execute("overlapping-roots", {
			pattern: "needle",
			path: ".;src",
			glob: "sub/*.ts",
			context: 0,
		});
		expect(result.content).toEqual([{ type: "text", text: "src/sub/file.ts:1: needle" }]);
	});

	it("searches meaningful whitespace patterns", async () => {
		writeFileSync(join(root, "source.txt"), "alpha beta\n");
		const result = await createGrepTool(root).execute("space", { pattern: " ", literal: true, context: 0 });
		expect(result.content).toEqual([{ type: "text", text: "source.txt:1: alpha beta" }]);
	});

	it("merges selectors for the same file without duplicate match rows", async () => {
		writeFileSync(join(root, "source.txt"), "needle one\nneedle two\nneedle three\nneedle four\n");
		const result = await createGrepTool(root).execute("overlap", {
			pattern: "needle",
			path: "source.txt:1-2;source.txt:2-3",
			context: 0,
		});
		expect(result.content).toEqual([
			{ type: "text", text: "source.txt:1: needle one\nsource.txt:2: needle two\nsource.txt:3: needle three" },
		]);
	});

	it("does not attach context from matches outside the selected ranges", async () => {
		writeFileSync(
			join(root, "source.txt"),
			"outside needle\nstray context\ngap\ngap\nselected needle\ninside context\noutside needle\n",
		);
		const result = await createGrepTool(root).execute("range-context", {
			pattern: "needle",
			path: "source.txt:2-6",
			context: 1,
		});
		expect(result.content).toEqual([
			{ type: "text", text: "source.txt-4- gap\nsource.txt:5: selected needle\nsource.txt-6- inside context" },
		]);
	});

	it("keeps selected-match context previously consumed by an excluded ordinary match", async () => {
		writeFileSync(join(root, "source.txt"), "needle\nfirst context\nsecond context\nneedle\n");
		const result = await createGrepTool(root).execute("overlapping-context", {
			pattern: "needle",
			path: "source.txt:2-4",
			context: 2,
		});
		expect(result.content).toEqual([
			{ type: "text", text: "source.txt-2- first context\nsource.txt-3- second context\nsource.txt:4: needle" },
		]);
	});

	it("keeps before-context after excluded multiline blocks", async () => {
		writeFileSync(join(root, "source.txt"), "A\nB\nfirst context\nsecond context\nA\nB\n");
		const result = await createGrepTool(root).execute("multiline-block-context", {
			pattern: "A\\nB",
			path: "source.txt:3-6",
			context: 2,
		});
		expect(result.content).toEqual([
			{
				type: "text",
				text: "source.txt-3- first context\nsource.txt-4- second context\nsource.txt:5: A\nsource.txt:6: B",
			},
		]);
	});

	it("retains skipped context across streaming input-buffer rolls", async () => {
		writeFileSync(
			join(root, "source.txt"),
			`needle\nfirst ${"x".repeat(40000)}\nsecond ${"y".repeat(40000)}\nneedle\n`,
		);
		const result = await createGrepTool(root).execute("rolled-context", {
			pattern: "needle",
			path: "source.txt:2-4",
			context: 2,
		});
		expect(result.details).toMatchObject({ matchCount: 1, linesTruncated: true });
		const text = result.content[0];
		if (text.type !== "text") throw new Error("Expected text search results");
		expect([...text.text.matchAll(/source\.txt[:-](\d+)[:-]/g)].map((match) => Number(match[1]))).toEqual([2, 3, 4]);
		expect(text.text).toContain("source.txt-2- first ");
		expect(text.text).toContain("source.txt-3- second ");
	});

	it("locates long-line snippets using the same line subject as boundary assertions", async () => {
		writeFileSync(join(root, "source.txt"), `${"x".repeat(1000)}needle\n`);
		const result = await createGrepTool(root).execute("line-boundary", {
			pattern: "needle\\z",
			path: "source.txt",
			context: 0,
		});
		expect(result.details).toMatchObject({ matchCount: 1, linesTruncated: true });
		expect(result.content[0]).toMatchObject({ text: expect.stringContaining("needle") });
		expect(result.content[0]).toMatchObject({ text: expect.stringContaining("[col 1001]") });
	});

	it("keeps a late Unicode match visible and reports its original character column", async () => {
		writeFileSync(join(root, "long.txt"), `${"😀".repeat(3000)}needle${"界".repeat(1000)}\n`);
		const result = await createGrepTool(root).execute("window", { pattern: "needle", context: 0 });
		const text = result.content[0];
		if (text.type !== "text") throw new Error("Expected text search results");
		expect(text.text).toContain("needle");
		expect(text.text).toContain("[col 3001]");
		expect(text.text).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
		expect(result.details?.linesTruncated).toBe(true);
	});

	it.each([200, 1000])("centres decoded snippets after %i invalid bytes", async (invalidBytes) => {
		writeFileSync(
			join(root, "invalid.txt"),
			Buffer.concat([Buffer.alloc(invalidBytes, 0xff), Buffer.from("needle\n")]),
		);
		const result = await createGrepTool(root).execute("lossy-window", { pattern: "needle", context: 0 });
		expect(result.details).toMatchObject({ matchCount: 1, linesTruncated: true });
		expect(result.content[0]).toMatchObject({ text: expect.stringContaining("needle") });
		expect(result.content[0]).toMatchObject({ text: expect.stringContaining(`[col ${invalidBytes + 1}]`) });
	});

	it("paginates matching files deterministically and prevents a hot file from starving other files", async () => {
		for (let i = 0; i < 23; i++) {
			writeFileSync(
				join(root, `${String(i).padStart(2, "0")}.txt`),
				i === 0 ? `${"needle\n".repeat(250)}` : `needle ${i}\n`,
			);
		}
		const grep = createGrepTool(root);
		const first = await grep.execute("first", { pattern: "needle", context: 0 });
		expect(first.details?.files).toEqual(Array.from({ length: 20 }, (_, i) => `${String(i).padStart(2, "0")}.txt`));
		expect(first.details?.matchCount).toBe(39);
		expect(first.details?.perFileLimitReached).toBe(20);
		expect(first.details?.fileLimitReached).toBe(20);
		const next = await grep.execute("next", { pattern: "needle", context: 0, skip: 20 });
		expect(next.details?.files).toEqual(["20.txt", "21.txt", "22.txt"]);
		expect(next.details?.fileLimitReached).toBeUndefined();
		const single = await grep.execute("single", { pattern: "needle", path: "00.txt", context: 0 });
		expect(single.details?.matchCount).toBe(200);
		expect(single.details?.perFileLimitReached).toBe(200);
	});

	it("reserves final output bytes for bounded per-file notices", async () => {
		const directory = join(root, ...Array.from({ length: 8 }, (_, index) => `${index}${"d".repeat(84)}`));
		mkdirSync(directory, { recursive: true });
		for (let index = 0; index < 20; index++) {
			writeFileSync(join(directory, `${String(index).padStart(2, "0")}.ts`), "needle\n".repeat(21));
		}
		const result = await createGrepTool(root).execute("notice-budget", { pattern: "needle", context: 0 });
		expect(result.details?.perFileLimitReached).toBe(20);
		expect(result.details?.truncation?.truncated).toBe(true);
		const content = result.content[0];
		if (content.type !== "text") throw new Error("Expected text search results");
		expect(Buffer.byteLength(content.text)).toBeLessThanOrEqual(50 * 1024);
		for (let index = 0; index < 20; index++) {
			expect(content.text).toContain(`${String(index).padStart(2, "0")}.ts:1: needle`);
		}
	});

	it("bounds missing-path notices even when the matching output is short", async () => {
		writeFileSync(join(root, "kept.ts"), "needle\n");
		const missing = Array.from({ length: 400 }, (_, index) => `missing-${index}-${"x".repeat(140)}`);
		const result = await createGrepTool(root).execute("missing-notice-budget", {
			pattern: "needle",
			path: ["kept.ts", ...missing].join(";"),
			context: 0,
		});
		expect(result.details?.missingPaths).toEqual(missing);
		expect(result.details?.matchCount).toBe(1);
		const content = result.content[0];
		if (content.type !== "text") throw new Error("Expected text search results");
		expect(Buffer.byteLength(content.text)).toBeLessThanOrEqual(50 * 1024);
		expect(content.text).toContain("kept.ts:1: needle");
	});

	it("keeps explicitly named ignored files, prunes exclusions, and reports partial missing scopes", async () => {
		mkdirSync(join(root, "src"));
		mkdirSync(join(root, "unrequested"));
		writeFileSync(join(root, ".gitignore"), "ignored.txt\n");
		writeFileSync(join(root, "ignored.txt"), "needle ignored\n");
		writeFileSync(join(root, "src", "kept.ts"), "needle kept\n");
		writeFileSync(join(root, "src", "skip.test.ts"), "needle excluded\n");
		writeFileSync(join(root, "unrequested", "other.ts"), "needle unrelated\n");
		const result = await createGrepTool(root).execute("scopes", {
			pattern: "needle",
			path: "src;ignored.txt;missing;!*.test.ts;!ignored.txt",
			context: 0,
		});
		expect(result.details?.files).toEqual(["ignored.txt", "src/kept.ts"]);
		expect(result.details?.missingPaths).toEqual(["missing"]);
	});

	it("preserves negated grep globs for files and directory subtrees", async () => {
		mkdirSync(join(root, "nested"));
		writeFileSync(join(root, "app.ts"), "needle\n");
		writeFileSync(join(root, "app.test.ts"), "needle\n");
		writeFileSync(join(root, "nested", "other.ts"), "needle\n");
		writeFileSync(join(root, "nested", "other.test.ts"), "needle\n");
		const grep = createGrepTool(root);
		const files = await grep.execute("negative-file-glob", { pattern: "needle", glob: "!*.test.ts", context: 0 });
		expect(files.details?.files).toEqual(["app.ts", "nested/other.ts"]);
		const directory = await grep.execute("negative-directory-glob", {
			pattern: "needle",
			glob: "!nested",
			context: 0,
		});
		expect(directory.details?.files).toEqual(["app.test.ts", "app.ts"]);
		writeFileSync(join(root, "!literal.ts"), "");
		expect((await createFindTool(root).execute("literal-bang", { pattern: "!literal.ts" })).content).toEqual([
			{ type: "text", text: "!literal.ts" },
		]);
	});

	it("rejects caller cancellation rather than reporting no matches", async () => {
		writeFileSync(join(root, "source.txt"), "needle\n");
		const controller = new AbortController();
		const pending = createGrepTool(root).execute("cancel", { pattern: "needle" }, controller.signal);
		controller.abort();
		await expect(pending).rejects.toThrow(/abort/i);
	});
});

describe("native find", () => {
	it("distinguishes a bare recursive glob from an explicitly rooted direct-child glob", async () => {
		mkdirSync(join(root, "src", "nested"), { recursive: true });
		writeFileSync(join(root, "src", "one.ts"), "");
		writeFileSync(join(root, "src", "nested", "two.ts"), "");
		const find = createFindTool(root);
		const recursive = await find.execute("recursive", { path: "*.ts" });
		const direct = await find.execute("direct", { path: "src/*.ts" });
		const recursiveText = recursive.content[0];
		if (recursiveText.type !== "text") throw new Error("Expected text search results");
		expect(recursiveText.text.split("\n").sort()).toEqual(["src/nested/two.ts", "src/one.ts"]);
		expect(direct.content).toEqual([{ type: "text", text: "one.ts" }]);
	});

	it("returns the newest files across multiple roots without duplicates or unrelated siblings", async () => {
		for (const directory of ["a", "b", "other"]) mkdirSync(join(root, directory));
		for (const [file, modified] of [
			["a/old.ts", 100],
			["a/new.ts", 300],
			["b/middle.ts", 200],
			["other/unrelated.ts", 400],
		]) {
			writeFileSync(join(root, String(file)), "");
			utimesSync(join(root, String(file)), Number(modified), Number(modified));
		}
		const result = await createFindTool(root).execute("newest", { path: "a;b;a/*.ts", pattern: "*.ts", limit: 2 });
		expect(result.content[0]).toMatchObject({ text: expect.stringMatching(/^a\/new.ts\nb\/middle.ts\n/) });
		expect(result.details?.resultLimitReached).toBe(2);
	});

	it("applies each root's relative filter before deduplication", async () => {
		mkdirSync(join(root, "src", "sub"), { recursive: true });
		writeFileSync(join(root, "src", "sub", "file.ts"), "");
		const result = await createFindTool(root).execute("overlapping-roots", { path: ".;src", pattern: "sub/*.ts" });
		expect(result.content).toEqual([{ type: "text", text: "src/sub/file.ts" }]);
	});

	it.skipIf(process.platform === "win32")(
		"lists symlinks, including dangling links, without traversing them",
		async () => {
			mkdirSync(join(root, "outside"));
			mkdirSync(join(root, "links"));
			writeFileSync(join(root, "outside", "real.ts"), "needle\n");
			symlinkSync(join(root, "outside", "real.ts"), join(root, "links", "linked.ts"));
			symlinkSync(join(root, "absent.ts"), join(root, "links", "missing.ts"));
			symlinkSync(join(root, "outside", "real.ts", "child"), join(root, "links", "not-directory.ts"));
			symlinkSync(join(root, "outside"), join(root, "links", "directory"));
			const result = await createFindTool(root).execute("links", { path: "links" });
			const text = result.content[0];
			if (text.type !== "text") throw new Error("Expected text search results");
			expect(text.text.split("\n").sort()).toEqual(["directory", "linked.ts", "missing.ts", "not-directory.ts"]);
			expect(
				(await createFindTool(root).execute("explicit-dangling", { path: "links/missing.ts" })).content,
			).toEqual([{ type: "text", text: "missing.ts" }]);
			expect(
				(await createFindTool(root).execute("explicit-not-directory", { path: "links/not-directory.ts" })).content,
			).toEqual([{ type: "text", text: "not-directory.ts" }]);
			expect(
				(
					await createFindTool(root).execute("explicit-directory-link", {
						path: "links/directory",
						pattern: "*.ts",
					})
				).content,
			).toEqual([{ type: "text", text: "real.ts" }]);
			const contents = await createGrepTool(root).execute("do-not-follow-links", {
				path: "links",
				pattern: "needle",
				context: 0,
			});
			expect(contents.content).toEqual([{ type: "text", text: "No matches found" }]);
		},
	);

	it("respects hidden and ignore flags independently", async () => {
		writeFileSync(join(root, ".gitignore"), "ignored.txt\n");
		for (const file of [".hidden.txt", "ignored.txt", "visible.txt"]) writeFileSync(join(root, file), "");
		const find = createFindTool(root);
		const normal = await find.execute("normal", { pattern: "*.txt", hidden: false });
		expect(normal.content).toEqual([{ type: "text", text: "visible.txt" }]);
		const all = await find.execute("all", { pattern: "*.txt", gitignore: false });
		const text = all.content[0];
		if (text.type !== "text") throw new Error("Expected text search results");
		expect(text.text.split("\n").sort()).toEqual([".hidden.txt", "ignored.txt", "visible.txt"]);
	});
});

describe("native traversal errors and path identities", () => {
	it.each(["basename", "relative", "absolute"] as const)(
		"keeps existing glob metacharacters literal in %s scope prefixes",
		async (kind) => {
			const cwd = join(root, "repo[1]");
			mkdirSync(join(cwd, "src"), { recursive: true });
			mkdirSync(join(root, "repo1", "src"), { recursive: true });
			writeFileSync(join(cwd, "src", "wanted.ts"), "needle wanted\n");
			writeFileSync(join(root, "repo1", "src", "unrelated.ts"), "needle unrelated\n");
			const path = kind === "basename" ? "*.ts" : kind === "relative" ? "src/*.ts" : join(cwd, "src", "*.ts");
			const expected = kind === "basename" ? "src/wanted.ts" : "wanted.ts";
			expect((await createFindTool(cwd).execute("literal-prefix", { path })).content).toEqual([
				{ type: "text", text: expected },
			]);
			expect(
				(await createGrepTool(cwd).execute("literal-prefix", { path, pattern: "needle", context: 0 })).content,
			).toEqual([{ type: "text", text: `${expected}:1: needle wanted` }]);
			for (const exclusion of ["src/*.ts", join(cwd, "src", "*.ts")]) {
				const excludedPath = `${path};!${exclusion}`;
				expect((await createFindTool(cwd).execute("literal-exclusion", { path: excludedPath })).content).toEqual([
					{ type: "text", text: "No files found matching pattern" },
				]);
				expect(
					(
						await createGrepTool(cwd).execute("literal-exclusion", {
							path: excludedPath,
							pattern: "needle",
							context: 0,
						})
					).content,
				).toEqual([{ type: "text", text: "No matches found" }]);
			}
		},
	);

	it("excludes explicit directory roots while preserving explicit-file bypass", async () => {
		mkdirSync(join(root, "src", "subdir"), { recursive: true });
		writeFileSync(join(root, "src", "a.ts"), "needle\n");
		writeFileSync(join(root, "src", "subdir", "b.ts"), "needle nested\n");
		const grep = createGrepTool(root);
		const find = createFindTool(root);
		for (const path of [
			"src;!src",
			"src/*.ts;!src",
			"src/subdir;!src",
			".;src/subdir;!src",
			"src/subdir/*.ts;!src",
		]) {
			expect((await grep.execute("excluded-root", { pattern: "needle", path, context: 0 })).content).toEqual([
				{ type: "text", text: "No matches found" },
			]);
			expect((await find.execute("excluded-root", { path })).content).toEqual([
				{ type: "text", text: "No files found matching pattern" },
			]);
		}
		expect(
			(await grep.execute("explicit-file", { pattern: "needle", path: "src/a.ts;!src;!a.ts", context: 0 })).content,
		).toEqual([{ type: "text", text: "a.ts:1: needle" }]);
		expect((await find.execute("explicit-file", { path: "src/a.ts;!src;!a.ts" })).content).toEqual([
			{ type: "text", text: "a.ts" },
		]);
	});

	it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
		"does not traverse below shallow glob depth",
		async () => {
			const locked = join(root, "src", "nested", "locked");
			mkdirSync(locked, { recursive: true });
			writeFileSync(join(root, "src", "visible.ts"), "needle direct\n");
			writeFileSync(join(root, "src", "nested", "other.ts"), "needle nested\n");
			chmodSync(locked, 0);
			try {
				const grep = createGrepTool(root);
				const find = createFindTool(root);
				expect((await find.execute("shallow-scope", { path: "src/*.ts" })).content).toEqual([
					{ type: "text", text: "visible.ts" },
				]);
				expect(
					(await grep.execute("shallow-scope", { path: "src/*.ts", pattern: "needle", context: 0 })).content,
				).toEqual([{ type: "text", text: "visible.ts:1: needle direct" }]);
				expect((await find.execute("shallow-filter", { pattern: "src/*.ts" })).content).toEqual([
					{ type: "text", text: "src/visible.ts" },
				]);
				expect(
					(await grep.execute("shallow-filter", { pattern: "needle", glob: "src/*.ts", context: 0 })).details
						?.files,
				).toEqual(["src/visible.ts"]);
				const alternatives = await find.execute("finite-alternatives", { path: "src/{*.ts,nested/*.ts}" });
				const content = alternatives.content[0];
				if (content.type !== "text") throw new Error("Expected text search results");
				expect(content.text.split("\n").sort()).toEqual(["nested/other.ts", "visible.ts"]);
				const sameDepth = await find.execute("same-depth-alternatives", { pattern: "{src/*.ts,src/nested/*.ts}" });
				const sameDepthContent = sameDepth.content[0];
				if (sameDepthContent.type !== "text") throw new Error("Expected text search results");
				expect(sameDepthContent.text.split("\n").sort()).toEqual(["src/nested/other.ts", "src/visible.ts"]);
			} finally {
				chmodSync(locked, 0o700);
			}
		},
	);

	it("preserves separators matched by glob character classes when bounding traversal", async () => {
		mkdirSync(join(root, "src", "a"), { recursive: true });
		writeFileSync(join(root, "src", "a", "x.ts"), "needle\n");
		expect((await createFindTool(root).execute("class-separator", { path: "src/a[!x]*.ts" })).content).toEqual([
			{ type: "text", text: "a/x.ts" },
		]);
		expect(
			(
				await createGrepTool(root).execute("class-separator", {
					path: "src/a[!x]*.ts",
					pattern: "needle",
					context: 0,
				})
			).content,
		).toEqual([{ type: "text", text: "a/x.ts:1: needle" }]);
	});

	it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
		"reports missing fixed glob prefixes without traversing unrelated siblings",
		async () => {
			mkdirSync(join(root, "kept"));
			mkdirSync(join(root, "locked"));
			writeFileSync(join(root, "kept", "a.ts"), "needle\n");
			chmodSync(join(root, "locked"), 0);
			try {
				for (const missing of ["missing/*.ts", join(root, "missing", "*.ts")]) {
					const path = `kept;${missing}`;
					const find = await createFindTool(root).execute("missing-prefix", { path });
					const grep = await createGrepTool(root).execute("missing-prefix", {
						path,
						pattern: "needle",
						context: 0,
					});
					expect(find.details?.missingPaths).toEqual([missing]);
					expect(grep.details?.missingPaths).toEqual([missing]);
					expect(find.content[0]).toMatchObject({ text: expect.stringMatching(/^a\.ts\n\n/) });
					expect(grep.content[0]).toMatchObject({ text: expect.stringMatching(/^a\.ts:1: needle\n\n/) });
				}
			} finally {
				chmodSync(join(root, "locked"), 0o700);
			}
		},
	);

	it.skipIf(process.platform === "win32")(
		"parses wildcard directory components despite a same-named literal file",
		async () => {
			writeFileSync(join(root, "src*"), "not a directory");
			mkdirSync(join(root, "src-one", "nested"), { recursive: true });
			writeFileSync(join(root, "src-one", "a.ts"), "needle\n");
			writeFileSync(join(root, "src-one", "nested", "b.ts"), "needle\n");
			for (const [path, expected] of [
				["src*/*.ts", "src-one/a.ts"],
				["src*/nested/*.ts", "src-one/nested/b.ts"],
			]) {
				expect((await createFindTool(root).execute("file-collision", { path })).content).toEqual([
					{ type: "text", text: expected },
				]);
				expect(
					(await createGrepTool(root).execute("file-collision", { path, pattern: "needle", context: 0 })).content,
				).toEqual([{ type: "text", text: `${expected}:1: needle` }]);
			}
		},
	);

	it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
		"reports unreadable roots and subdirectories instead of claiming no matches",
		async () => {
			const locked = join(root, "locked");
			mkdirSync(locked);
			writeFileSync(join(locked, "hidden.ts"), "needle\n");
			chmodSync(locked, 0);
			try {
				for (const path of ["locked", "."]) {
					await expect(createGrepTool(root).execute("permission", { pattern: "needle", path })).rejects.toThrow(
						/locked/,
					);
					await expect(createFindTool(root).execute("permission", { pattern: "*.ts", path })).rejects.toThrow(
						/locked/,
					);
				}
			} finally {
				chmodSync(locked, 0o700);
			}
		},
	);

	it.skipIf(process.platform === "win32")(
		"preserves literal POSIX backslashes in results and glob scopes",
		async () => {
			writeFileSync(join(root, "file\\"), "needle\n");
			const find = createFindTool(root);
			const grep = createGrepTool(root);
			expect((await find.execute("backslash", {})).content).toEqual([{ type: "text", text: "file\\" }]);
			expect((await grep.execute("backslash", { pattern: "needle", context: 0 })).content).toEqual([
				{ type: "text", text: "file\\:1: needle" },
			]);
			mkdirSync(join(root, "dir\\name"));
			writeFileSync(join(root, "dir\\name", "file\\.ts"), "needle\n");
			expect((await find.execute("backslash-scope", { path: "dir\\name/*.ts" })).content).toEqual([
				{ type: "text", text: "file\\.ts" },
			]);
			expect(
				(
					await grep.execute("backslash-filter", {
						path: "dir\\name",
						pattern: "needle",
						glob: "file\\*.ts",
						context: 0,
					})
				).content,
			).toEqual([{ type: "text", text: "file\\.ts:1: needle" }]);
		},
	);
});

describe("custom find cancellation", () => {
	it.each(["exists", "glob"] as const)("rejects abort while %s is still pending", async (stage) => {
		const { promise: held, resolve: release } = Promise.withResolvers<void>();
		const { promise: started, resolve: markStarted } = Promise.withResolvers<void>();
		const tool = createFindTool(root, {
			operations: {
				exists: async () => {
					if (stage === "exists") {
						markStarted();
						await held;
					}
					return true;
				},
				glob: async () => {
					if (stage === "glob") {
						markStarted();
						await held;
					}
					return ["entry.ts"];
				},
			},
		});
		const controller = new AbortController();
		const pending = tool.execute("adapter-cancel", { pattern: "*.ts" }, controller.signal);
		await started;
		const reason = new Error("caller cancelled the pending adapter");
		const rejected = expect(pending).rejects.toBe(reason);
		controller.abort(reason);
		try {
			await rejected;
		} finally {
			release();
		}
	});
});

import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createGrepToolDefinition, type GrepToolDetails } from "../../../src/core/tools/grep.ts";

/**
 * Regression: the grep tool read `rg --json` through `node:readline`, which grows
 * one line with an unbounded append and offers no line cap. `rg --json` puts the
 * whole matched line, plus one entry per submatch, in a single event, so one match
 * in a minified bundle or a large single-line JSONL record is one enormous line.
 * Past V8's maximum string length that append throws `RangeError: Invalid string
 * length` inside the stream's `data` handler - in the parent, where no
 * tool-level `try` surrounds it, so the whole process exits.
 *
 * `--max-columns` cannot fix it: ripgrep documents `-M/--max-columns` as having
 * no effect under `--json`, and measured output is byte-identical with and
 * without it. The cap has to go at the reader, which is what
 * `attachCappedLineReader` does.
 *
 * These cases run the real `rg` child over real files, so they exercise the pipe
 * rather than a synthetic stream.
 */
describe("grep survives an oversized rg --json event", () => {
	let tempRoot: string;

	beforeEach(() => {
		tempRoot = mkdtempSync(join(tmpdir(), "pi-grep-oversized-"));
	});

	afterEach(() => {
		rmSync(tempRoot, { recursive: true, force: true });
	});

	async function runGrep(
		args: { pattern: string; limit?: number },
		capChars?: number,
	): Promise<{ text: string; details?: GrepToolDetails }> {
		const def = createGrepToolDefinition(tempRoot, capChars === undefined ? undefined : { lineCapChars: capChars });
		const ctx = {} as Parameters<typeof def.execute>[4];
		const result = (await def.execute("call-1", args, undefined, undefined, ctx)) as {
			content: Array<{ type: string; text?: string }>;
			details?: GrepToolDetails;
		};
		return { text: result.content[0]?.text ?? "", details: result.details };
	}

	it("drops the oversized match, keeps the others, and says what is missing", async () => {
		// One line far past the cap, and two ordinary matches around it.
		writeFileSync(join(tempRoot, "small.txt"), "first NEEDLE\nsecond NEEDLE\n");
		writeFileSync(join(tempRoot, "huge.txt"), `${"x".repeat(200_000)}NEEDLE${"y".repeat(200_000)}\n`);

		const { text, details } = await runGrep({ pattern: "NEEDLE" }, 50_000);

		expect(text).toContain("small.txt:1: first NEEDLE");
		expect(text).toContain("small.txt:2: second NEEDLE");
		expect(details?.eventsDiscarded).toBe(1);
		// Named, and named as MISSING rather than empty: a model reading grep output
		// that silently omitted a match would conclude the file has none.
		expect(text).toContain("1 match MISSING in huge.txt");
		expect(text).toContain("line too large to read");
	});

	it("survives a match whose rg event exceeds V8's maximum string length", async () => {
		// The point of this case: at the default cap, `rg --json` emits this match as a
		// single event past V8's ceiling (536,870,888 code units on Node 24), so the
		// uncapped readline append throws and takes the test process with it. If this
		// case reports a result at all, the parent survived.
		//
		// Opt-in because it writes ~600MB: run with `PI_HEAVY_TESTS=1`. The cases above
		// cover the same reader path at a lowered cap on every run.
		if (process.env.PI_HEAVY_TESTS !== "1") return;
		// Appended in chunks: the test process cannot hold this line as one string
		// either, which is the defect restated.
		const file = join(tempRoot, "beyond-v8.txt");
		const chunk = "x".repeat(16 * 1024 * 1024);
		writeFileSync(file, "");
		for (let written = 0; written < 600 * 1024 * 1024; written += chunk.length) appendFileSync(file, chunk);
		appendFileSync(file, "NEEDLE\n");
		writeFileSync(join(tempRoot, "ordinary.txt"), "ordinary NEEDLE\n");

		const { text, details } = await runGrep({ pattern: "NEEDLE" });

		expect(details?.eventsDiscarded).toBe(1);
		expect(text).toContain("beyond-v8.txt");
		expect(text).toContain("ordinary.txt:1: ordinary NEEDLE");
	}, 600_000);

	it("reports a match whose event is ordinary for a real repository", async () => {
		// Regression for the cap DEFAULT, not the reader: an event is the escaped line
		// plus ~53 code units per submatch, so a short pattern on a long line produces
		// a far bigger event than the line. 200k occurrences on one 200KB line gives a
		// ~10.2M-char event - above the 8Mi this originally defaulted to, and ordinary
		// output for a repository holding one minified asset. readline delivered it.
		writeFileSync(join(tempRoot, "dense.txt"), `${"a".repeat(200_000)}\n`);

		const { text, details } = await runGrep({ pattern: "a" });

		expect(details?.eventsDiscarded).toBeUndefined();
		expect(text).toContain("dense.txt:1:");
		expect(text).not.toContain("MISSING");
	});

	it("reports a discarded match even when it was the only one", async () => {
		// Otherwise the tool answers "No matches found", which is a false negative.
		writeFileSync(join(tempRoot, "only.txt"), `${"z".repeat(100_000)}NEEDLE\n`);

		const { text, details } = await runGrep({ pattern: "NEEDLE" }, 20_000);

		expect(text).not.toContain("No matches found");
		expect(details?.eventsDiscarded).toBe(1);
		expect(text).toContain("MISSING in only.txt");
	});

	it("discards an event made oversized by its submatches alone", async () => {
		// A short line can still produce an enormous event: `rg --json` lists every
		// submatch, so many matches on one line blow up the event without any one
		// long line. Measured: 200k matches on a 1.2MB line gave a 12.4M-char event.
		writeFileSync(join(tempRoot, "many.txt"), `${"NEEDLE".repeat(20_000)}\n`);

		const { text, details } = await runGrep({ pattern: "NEEDLE" }, 60_000);

		expect(details?.eventsDiscarded).toBe(1);
		expect(text).toContain("MISSING in many.txt");
	});

	it("leaves ordinary output unmarked", async () => {
		writeFileSync(join(tempRoot, "plain.txt"), "alpha NEEDLE\nbeta NEEDLE\n");

		const { text, details } = await runGrep({ pattern: "NEEDLE" });

		expect(text).toBe("plain.txt:1: alpha NEEDLE\nplain.txt:2: beta NEEDLE");
		expect(details?.eventsDiscarded).toBeUndefined();
	});

	it("does not lose a match on a line containing U+2028", async () => {
		// readline treats U+2028 and U+2029 as line terminators, but they are legal
		// inside a JSON string, so the event carrying one was split into two
		// unparseable fragments and the match vanished.
		writeFileSync(join(tempRoot, "sep.txt"), "alpha NEEDLE\u2028beta\nplain NEEDLE\n", "utf8");

		const { text } = await runGrep({ pattern: "NEEDLE" });

		expect(text).toContain("sep.txt:1:");
		expect(text).toContain("sep.txt:2: plain NEEDLE");
	});
});

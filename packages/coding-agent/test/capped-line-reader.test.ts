import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import {
	attachCappedLineReader,
	DEFAULT_LINE_CAP_CHARS,
	DEFAULT_OVERSIZE_PREFIX_CHARS,
	type OversizedLine,
} from "../src/utils/capped-line-reader.ts";

/**
 * Policy-level cover for the reader. The real-pipe path, where the parent has to
 * survive a line past V8's string limit, lives in
 * test/suite/regressions/grep-oversized-rg-json-event.test.ts.
 */
function collect(
	chunks: Array<string | Buffer>,
	options?: { capChars?: number; prefixChars?: number },
): { lines: string[]; oversize: OversizedLine[]; peakRetained: number } {
	const stream = new Readable({ read() {} });
	const lines: string[] = [];
	const oversize: OversizedLine[] = [];
	let peakRetained = 0;
	const reader = attachCappedLineReader(stream, {
		capChars: options?.capChars,
		prefixChars: options?.prefixChars,
		onLine: (line) => lines.push(line),
		onOversize: (drop) => oversize.push(drop),
	});
	for (const chunk of chunks) {
		// Emitted rather than pushed: `push` delivers on a later tick, which would
		// make the per-chunk retention sample below miss the peak entirely.
		stream.emit("data", chunk);
		// Peak, not end state: an end-state assertion passes with the cap deleted,
		// because a sub-limit line accumulates fine and is only dropped at its
		// terminator.
		peakRetained = Math.max(peakRetained, reader.retainedChars);
	}
	stream.emit("end");
	peakRetained = Math.max(peakRetained, reader.retainedChars);
	reader.detach();
	return { lines, oversize, peakRetained };
}

describe("capped line reader", () => {
	it("splits LF-delimited lines across chunk boundaries", () => {
		const { lines, oversize } = collect(["al", "pha\nbe", "ta\n"]);
		expect(lines).toEqual(["alpha", "beta"]);
		expect(oversize).toEqual([]);
	});

	it("strips a CR terminator but keeps interior CRs", () => {
		const { lines } = collect(["alpha\r\nbe\rta\r\n"]);
		expect(lines).toEqual(["alpha", "be\rta"]);
	});

	it("emits a trailing unterminated line at end of stream", () => {
		const { lines } = collect(["alpha\nbeta"]);
		expect(lines).toEqual(["alpha", "beta"]);
	});

	it("does not split on U+2028 or U+2029, which are legal inside a JSON string", () => {
		// node:readline splits on both, which turns one `rg --json` event into two
		// unparseable fragments and silently loses the match.
		const record = '{"lines":{"text":"a\u2028b\u2029c"}}';
		const { lines } = collect([`${record}\n`]);
		expect(lines).toEqual([record]);
		expect(JSON.parse(lines[0]).lines.text).toBe("a\u2028b\u2029c");
	});

	it("does not split a multi-byte character across chunk boundaries", () => {
		const utf8 = Buffer.from("héllo\n", "utf8");
		const { lines } = collect([utf8.subarray(0, 2), utf8.subarray(2)]);
		expect(lines).toEqual(["héllo"]);
	});

	it("discards a line past the cap and keeps reading after it", () => {
		const { lines, oversize, peakRetained } = collect(["small\n", `${"x".repeat(50)}\n`, "after\n"], {
			capChars: 20,
			prefixChars: 8,
		});
		expect(lines).toEqual(["small", "after"]);
		expect(oversize).toHaveLength(1);
		expect(oversize[0].chars).toBe(50);
		expect(oversize[0].prefix).toBe("xxxxxxxx");
		expect(peakRetained).toBeLessThanOrEqual(20);
	});

	it("caps a line that arrives whole in one chunk with its terminator", () => {
		// The buffered path never sees this line: cap and terminator land together.
		const { lines, oversize, peakRetained } = collect([`${"y".repeat(40)}\nafter\n`], {
			capChars: 10,
			prefixChars: 4,
		});
		expect(lines).toEqual(["after"]);
		expect(oversize).toEqual([{ chars: 40, prefix: "yyyy" }]);
		expect(peakRetained).toBeLessThanOrEqual(10);
	});

	it("holds only the prefix while an oversized line is still streaming", () => {
		const { oversize, peakRetained } = collect(["z".repeat(30), "z".repeat(1000), "z".repeat(1000), "\ntail\n"], {
			capChars: 20,
			prefixChars: 8,
		});
		expect(oversize).toEqual([{ chars: 2030, prefix: "zzzzzzzz" }]);
		// Retention is the prefix, not the line: 2030 code units passed through.
		expect(peakRetained).toBeLessThanOrEqual(20);
	});

	it("reports an oversized line still open at end of stream", () => {
		const { lines, oversize } = collect(["ok\n", "w".repeat(40)], { capChars: 10, prefixChars: 4 });
		expect(lines).toEqual(["ok"]);
		expect(oversize).toEqual([{ chars: 40, prefix: "wwww" }]);
	});

	it("emits a line exactly at the cap rather than discarding it", () => {
		const { lines, oversize } = collect([`${"e".repeat(10)}\n`], { capChars: 10 });
		expect(lines).toEqual(["e".repeat(10)]);
		expect(oversize).toEqual([]);
	});

	it("clamps the retained prefix to the cap", () => {
		const { oversize } = collect([`${"p".repeat(40)}\n`], { capChars: 6, prefixChars: 1000 });
		expect(oversize[0].prefix).toHaveLength(6);
		expect(oversize[0].chars).toBe(40);
	});

	it("stops reading after detach", () => {
		const stream = new Readable({ read() {} });
		const lines: string[] = [];
		const reader = attachCappedLineReader(stream, { onLine: (l) => lines.push(l), onOversize: () => {} });
		stream.emit("data", "first\n");
		reader.detach();
		stream.emit("data", "second\n");
		expect(lines).toEqual(["first"]);
	});

	it("defaults sit above measured legitimate output and below V8's string limit", () => {
		// Worst `rg --json` event measured over a whole real tracked repository,
		// pattern `"` against a 5,089,613-char single-line source file: 25,174,363.
		// An event is the escaped line plus ~53 code units per submatch, so the
		// pattern sets the size and a cap justified against a low-submatch pattern
		// like `function` (5.8M on that same file) is far too low.
		expect(DEFAULT_LINE_CAP_CHARS).toBeGreaterThan(25_174_363);
		// V8 throws past this on Node 24; a held line must never reach it.
		expect(DEFAULT_LINE_CAP_CHARS).toBeLessThan(536_870_888);
		expect(DEFAULT_OVERSIZE_PREFIX_CHARS).toBeLessThan(DEFAULT_LINE_CAP_CHARS);
	});

	it("emits a line the previous 8Mi default would have discarded", () => {
		// Regression for the cap default itself: an event this size is ordinary
		// output from a real repository, so discarding it would lose a match that
		// the uncapped reader delivered.
		const line = "x".repeat(10 * 1024 * 1024);
		const { lines, oversize } = collect([`${line}\n`]);
		expect(lines).toHaveLength(1);
		expect(lines[0]).toHaveLength(line.length);
		expect(oversize).toEqual([]);
	});
});

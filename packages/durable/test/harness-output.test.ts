import { afterEach, describe, expect, it, vi } from "vitest";
import { boundOutput, OutputBuffer, type OutputLimits, Progress, sanitizeOutput } from "../src/harness/output.ts";

const head = (maxLines: number, maxBytes = 1000): OutputLimits => ({ maxBytes, maxLines, retain: "head" });
const tail = (maxLines: number, maxBytes = 1000): OutputLimits => ({ maxBytes, maxLines, retain: "tail" });

function bufferTail(content: string, maxBytes: number): string {
	const bytes = Buffer.from(content, "utf8");
	if (bytes.length <= maxBytes) return content;
	let start = bytes.length - maxBytes;
	while (start < bytes.length && (bytes[start]! & 0xc0) === 0x80) start++;
	return bytes.subarray(start).toString("utf8");
}

/** A single line longer than the byte limit is cut like Buffer's tail slice on a character boundary. */
function assertMatchesBufferTail(input: string, maxByteValues?: readonly number[]): void {
	const totalBytes = Buffer.byteLength(input, "utf8");
	const values = maxByteValues ?? Array.from({ length: totalBytes + 5 }, (_, maxBytes) => maxBytes);
	for (const maxBytes of values) {
		const kept = boundOutput(input, { maxBytes, maxLines: 10, retain: "tail" }).text;
		const expected = bufferTail(input, maxBytes);
		if (kept !== expected) {
			throw new Error(
				`tail mismatch input=${JSON.stringify(input)} maxBytes=${maxBytes} expected=${JSON.stringify(expected)} actual=${JSON.stringify(kept)}`,
			);
		}
		if (Buffer.byteLength(kept, "utf8") > maxBytes) throw new Error(`tail output exceeded ${maxBytes} bytes`);
	}
}

function sampledByteLimits(input: string): number[] {
	const totalBytes = Buffer.byteLength(input, "utf8");
	const candidates = [
		0,
		1,
		2,
		3,
		4,
		5,
		8,
		Math.floor(totalBytes / 2),
		totalBytes - 4,
		totalBytes - 1,
		totalBytes,
		totalBytes + 1,
	];
	return [...new Set(candidates.filter((value) => value >= 0))].sort((a, b) => a - b);
}

function bound(text: string, limits: OutputLimits) {
	const { text: kept, droppedBytes, droppedLines } = boundOutput(text, limits);
	return { kept, droppedBytes, droppedLines };
}

describe("tool output bounds", () => {
	it("removes control characters but keeps tabs, newlines, and other text", () => {
		expect(sanitizeOutput("a\0b\tc\nd\re\u0007f\ufff9g\ufffbh😀")).toBe("ab\tc\ndefgh😀");
	});

	it("keeps output within the limits unchanged", () => {
		expect(bound("a\nb\n", head(2))).toEqual({ kept: "a\nb\n", droppedBytes: 0, droppedLines: 0 });
		expect(bound("a\nb", tail(2))).toEqual({ kept: "a\nb", droppedBytes: 0, droppedLines: 0 });
		expect(bound("", tail(2))).toEqual({ kept: "", droppedBytes: 0, droppedLines: 0 });
	});

	it("keeps nothing with a zero limit", () => {
		expect(bound("ab\ncd\n", head(10, 0))).toEqual({ kept: "", droppedBytes: 6, droppedLines: 2 });
		expect(bound("ab\ncd\n", tail(0))).toEqual({ kept: "", droppedBytes: 6, droppedLines: 2 });
	});

	it("keeps exact slices of whole lines, trailing newline included", () => {
		expect(bound("a\nb\nc\n", head(2))).toEqual({ kept: "a\nb\n", droppedBytes: 2, droppedLines: 1 });
		expect(bound("a\nb\nc\n", tail(2))).toEqual({ kept: "b\nc\n", droppedBytes: 2, droppedLines: 1 });
		expect(bound("a\nb\nc", tail(2))).toEqual({ kept: "b\nc", droppedBytes: 2, droppedLines: 1 });
		// Blank lines are lines.
		expect(bound("a\nb\nc\n\n", tail(3))).toEqual({ kept: "b\nc\n\n", droppedBytes: 2, droppedLines: 1 });
	});

	it("cuts at the byte limit on whole lines when possible", () => {
		expect(bound("aa\nbb\ncc\n", head(10, 7))).toEqual({ kept: "aa\nbb\n", droppedBytes: 3, droppedLines: 1 });
		expect(bound("aa\nbb\ncc\n", tail(10, 7))).toEqual({ kept: "bb\ncc\n", droppedBytes: 3, droppedLines: 1 });
	});

	it("cuts a single line longer than the byte limit on a character boundary", () => {
		// "é" is two bytes; five bytes hold two whole characters.
		expect(bound("ééé\n", head(10, 5))).toEqual({ kept: "éé", droppedBytes: 3, droppedLines: 0 });
		expect(bound("x\néééé", tail(10, 5))).toEqual({ kept: "éé", droppedBytes: 6, droppedLines: 1 });
	});

	it("cuts tails of surrogate edge cases exactly like Buffer", () => {
		const inputs = ["a\ud83d", "\ude42b", "a\ude42b", "\ud83d\ud83d\ude42", "\ud83d\ude42\ude42", "👩‍💻"];
		for (const input of inputs) assertMatchesBufferTail(input);
	});

	it("cuts tails exactly like Buffer across deterministic fuzz cases", () => {
		const alphabet = [
			"a",
			"\u007f",
			"\u0080",
			"é",
			"\u07ff",
			"\u0800",
			"中",
			"\ud7ff",
			"\ud800",
			"\ud83d",
			"\udc00",
			"\ude42",
			"🙂",
			"\ue000",
			"\uffff",
		];
		function checkExhaustive(prefix: string, depth: number): void {
			assertMatchesBufferTail(prefix, sampledByteLimits(prefix));
			if (depth === 0) return;
			for (const character of alphabet) checkExhaustive(prefix + character, depth - 1);
		}
		checkExhaustive("", 3);
		let seed = 0x12345678;
		const random = (): number => {
			seed = (seed * 1664525 + 1013904223) >>> 0;
			return seed / 0x100000000;
		};
		for (let i = 0; i < 1_000; i++) {
			let input = "";
			const length = Math.floor(random() * 80);
			for (let j = 0; j < length; j++) input += alphabet[Math.floor(random() * alphabet.length)];
			assertMatchesBufferTail(input, sampledByteLimits(input));
		}
	});
});

describe("OutputBuffer", () => {
	it("keeps exact totals across chunks and decodes UTF-8 split across byte chunks", () => {
		const buffer = new OutputBuffer(tail(2));
		const bytes = new TextEncoder().encode("😀\n");
		buffer.push("a\nb\n");
		buffer.push(bytes.subarray(0, 2));
		buffer.push(bytes.subarray(2));
		expect(buffer.snapshot()).toEqual({ text: "b\n😀\n", droppedBytes: 2, droppedLines: 1 });
	});

	it("sanitizes the retained text but counts the raw stream", () => {
		const buffer = new OutputBuffer(tail(1));
		buffer.push("a\u0007\n");
		expect(buffer.snapshot()).toEqual({ text: "a\n", droppedBytes: 0, droppedLines: 0 });
		buffer.push("b\u001b\n");
		expect(buffer.snapshot()).toEqual({ text: "b\n", droppedBytes: 3, droppedLines: 1 });
	});

	it("flushes an incomplete character before a string chunk and at the end", () => {
		const buffer = new OutputBuffer(tail(10));
		const euro = new TextEncoder().encode("€");
		buffer.push(euro.subarray(0, 1));
		buffer.push("x");
		buffer.push(euro.subarray(0, 2));
		buffer.end();
		expect(buffer.snapshot().text).toBe("\ufffdx\ufffd");
	});

	it("matches bounding the whole stream when several chunks arrive between snapshots", () => {
		for (const limits of [head(3, 40), tail(3, 40), head(50, 25), tail(50, 25)]) {
			const buffer = new OutputBuffer(limits);
			let stream = "";
			for (let index = 0; index < 300; index++) {
				const chunk = index % 7 === 0 ? `${"é".repeat(index % 30)}\n` : `line ${index}\n`;
				stream += chunk;
				buffer.push(chunk);
				if (index % 5 !== 4) continue;
				const expected = boundOutput(stream, limits);
				expect(buffer.snapshot()).toEqual({
					text: expected.text,
					droppedBytes: expected.droppedBytes,
					droppedLines: expected.droppedLines,
				});
			}
		}
	});

	it("stops storing head output once the window is full", () => {
		const buffer = new OutputBuffer(head(2));
		for (let index = 0; index < 1000; index++) buffer.push(`line ${index}\n`);
		expect(buffer.storedBytes).toBeLessThan(20);
		expect(buffer.snapshot()).toEqual({ text: "line 0\nline 1\n", droppedBytes: 8876, droppedLines: 998 });
	});

	it("stores only the tail window after each snapshot", () => {
		const buffer = new OutputBuffer(tail(3, 100));
		let stream = "";
		for (let index = 0; index < 2000; index++) {
			const chunk = `line ${index}\n\n`;
			stream += chunk;
			buffer.push(chunk);
			const snapshot = buffer.snapshot();
			expect(buffer.storedBytes).toBeLessThanOrEqual(100);
			expect(snapshot.text).toBe(boundOutput(stream, tail(3, 100)).text);
		}
	});
});

describe("Progress", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("commits the first change at once, then waits at least 100 ms and the written size at 100 KiB/s", async () => {
		vi.useFakeTimers({ now: 0 });
		const commits: number[] = [];
		let size = 50 * 1024;
		const progress = new Progress(
			async () => {
				commits.push(Date.now());
				return size;
			},
			() => {},
		);
		progress.mark();
		await vi.advanceTimersByTimeAsync(0);
		expect(commits).toEqual([0]);
		// 50 KiB buys 500 ms; changes meanwhile coalesce into one commit.
		size = 10;
		progress.mark();
		progress.mark();
		await vi.advanceTimersByTimeAsync(499);
		expect(commits).toEqual([0]);
		await vi.advanceTimersByTimeAsync(1);
		expect(commits).toEqual([0, 500]);
		// A small commit still waits the minimum 100 ms.
		progress.mark();
		await vi.advanceTimersByTimeAsync(99);
		expect(commits).toEqual([0, 500]);
		await vi.advanceTimersByTimeAsync(1);
		expect(commits).toEqual([0, 500, 600]);
	});

	it("rejects the waiters of a failed commit and reports its error", async () => {
		const errors: unknown[] = [];
		const failure = new Error("commit failed");
		const progress = new Progress(
			async () => {
				throw failure;
			},
			(error) => errors.push(error),
		);
		await expect(progress.markAndWait()).rejects.toBe(failure);
		expect(errors).toEqual([failure]);
	});

	it("stops: waits for the commit in flight and hands back waiters no commit covered yet", async () => {
		vi.useFakeTimers({ now: 0 });
		let release!: () => void;
		const inFlight = new Promise<void>((resolve) => {
			release = resolve;
		});
		const progress = new Progress(
			async () => {
				await inFlight;
				return 0;
			},
			() => {},
		);
		const first = progress.markAndWait();
		const second = progress.markAndWait();
		const stopped = progress.stop();
		release();
		const pending = await stopped;
		await first;
		expect(pending).toHaveLength(1);
		pending[0]!.resolve();
		await second;
	});
});

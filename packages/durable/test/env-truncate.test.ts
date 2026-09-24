import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { formatSize, truncateHead, truncateLine, truncateTail } from "../src/env/utils/truncate.ts";

const encoder = new TextEncoder();

function byteLength(content: string): number {
	return encoder.encode(content).length;
}

function bufferTail(content: string, maxBytes: number): string {
	const bytes = Buffer.from(content, "utf8");
	if (bytes.length <= maxBytes) return content;
	let start = bytes.length - maxBytes;
	while (start < bytes.length && (bytes[start] & 0xc0) === 0x80) start++;
	return bytes.subarray(start).toString("utf8");
}

function assertMatchesBufferTail(input: string, maxByteValues?: readonly number[]): void {
	const totalBytes = Buffer.byteLength(input, "utf8");
	const values = maxByteValues ?? Array.from({ length: totalBytes + 5 }, (_, maxBytes) => maxBytes);
	for (const maxBytes of values) {
		const result = truncateTail(input, { maxBytes, maxLines: 10 });
		const expected = bufferTail(input, maxBytes);
		if (result.content !== expected) {
			throw new Error(
				`tail mismatch input=${JSON.stringify(input)} maxBytes=${maxBytes} expected=${JSON.stringify(expected)} actual=${JSON.stringify(result.content)}`,
			);
		}
		const outputBytes = Buffer.byteLength(result.content, "utf8");
		if (outputBytes > maxBytes) {
			throw new Error(
				`tail output exceeded byte limit input=${JSON.stringify(input)} maxBytes=${maxBytes} outputBytes=${outputBytes}`,
			);
		}
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
		Math.floor(totalBytes / 2) - 1,
		Math.floor(totalBytes / 2),
		Math.floor(totalBytes / 2) + 1,
		totalBytes - 8,
		totalBytes - 5,
		totalBytes - 4,
		totalBytes - 3,
		totalBytes - 2,
		totalBytes - 1,
		totalBytes,
		totalBytes + 1,
		totalBytes + 4,
	];
	return [...new Set(candidates.filter((value) => value >= 0))].sort((a, b) => a - b);
}

describe("truncate utilities", () => {
	it("reports UTF-8 byte counts in truncation results", () => {
		const content = "aé🙂\nb";
		const result = truncateHead(content, { maxBytes: 100, maxLines: 10 });

		expect(result.truncated).toBe(false);
		expect(result.totalBytes).toBe(byteLength(content));
		expect(result.outputBytes).toBe(byteLength(content));
		expect(result.totalBytes).toBe(9);
	});

	it("counts UTF-8 bytes and truncates correctly in a runtime without Buffer", () => {
		const inputs = ["", "ascii", "é", "中", "🙂", "\ud83d", "\ude42", "a\ud83d\ude42b", "\u07ff\u0800\uffff"];
		const output = execFileSync(
			process.execPath,
			[
				"--import",
				new URL("./fixtures/delete-buffer.ts", import.meta.url).href,
				fileURLToPath(new URL("./fixtures/utf8-byte-length-without-buffer.ts", import.meta.url)),
				JSON.stringify(inputs),
			],
			{ encoding: "utf8" },
		);
		const result = JSON.parse(output) as {
			bufferAvailable: boolean;
			lengths: number[];
			head: { content: string; outputBytes: number; truncatedBy: string | null };
			tail: { content: string; outputBytes: number; lastLinePartial: boolean };
		};
		expect(result.bufferAvailable).toBe(false);
		expect(result.lengths).toEqual(inputs.map(byteLength));
		expect(result.head).toMatchObject({ content: "aé🙂", outputBytes: 7, truncatedBy: "bytes" });
		expect(result.tail).toMatchObject({ content: "🙂b", outputBytes: 5, lastLinePartial: true });
	});

	it("does not count a trailing newline as an extra line", () => {
		const content = `${Array.from({ length: 3 }, () => "line").join("\n")}\n`;
		const head = truncateHead(content, { maxBytes: 100, maxLines: 3 });
		const tail = truncateTail(content, { maxBytes: 100, maxLines: 3 });

		expect(head).toMatchObject({ truncated: false, totalLines: 3, outputLines: 3 });
		expect(tail).toMatchObject({ truncated: false, totalLines: 3, outputLines: 3 });
	});

	it("truncates head and tail by line limits", () => {
		const content = "one\ntwo\nthree\nfour";
		expect(truncateHead(content, { maxBytes: 100, maxLines: 2 })).toMatchObject({
			content: "one\ntwo",
			truncated: true,
			truncatedBy: "lines",
			totalLines: 4,
			outputLines: 2,
		});
		expect(truncateTail(content, { maxBytes: 100, maxLines: 2 })).toMatchObject({
			content: "three\nfour",
			truncated: true,
			truncatedBy: "lines",
			totalLines: 4,
			outputLines: 2,
		});
	});

	it("reports bytes when only a trailing newline or oversized line exceeds limits at the line cap", () => {
		expect(truncateHead("hello\nworld\n", { maxBytes: 11, maxLines: 2 })).toMatchObject({
			content: "hello\nworld",
			truncated: true,
			truncatedBy: "bytes",
			totalLines: 2,
			outputLines: 2,
		});
		expect(truncateTail("hello\nworld\n", { maxBytes: 11, maxLines: 2 })).toMatchObject({
			content: "hello\nworld",
			truncated: true,
			truncatedBy: "bytes",
			totalLines: 2,
			outputLines: 2,
		});
		expect(truncateTail("x".repeat(100), { maxBytes: 10, maxLines: 1 })).toMatchObject({
			content: "x".repeat(10),
			truncatedBy: "bytes",
			lastLinePartial: true,
			outputLines: 1,
		});
	});

	it("truncates head on UTF-8 byte limits without partial lines", () => {
		const content = "éé\nabc";
		const result = truncateHead(content, { maxBytes: 4, maxLines: 10 });

		expect(result.content).toBe("éé");
		expect(result.truncated).toBe(true);
		expect(result.truncatedBy).toBe("bytes");
		expect(result.outputBytes).toBe(4);
		expect(result.firstLineExceedsLimit).toBe(false);
	});

	it("reports head truncation when the first line exceeds the byte limit", () => {
		const result = truncateHead("éé\nabc", { maxBytes: 3, maxLines: 10 });

		expect(result.content).toBe("");
		expect(result.truncated).toBe(true);
		expect(result.truncatedBy).toBe("bytes");
		expect(result.firstLineExceedsLimit).toBe(true);
	});

	it("truncates tail on UTF-8 boundaries when only a partial last line fits", () => {
		const result = truncateTail("aé🙂b", { maxBytes: 5, maxLines: 10 });

		expect(result.content).toBe("🙂b");
		expect(result.truncated).toBe(true);
		expect(result.truncatedBy).toBe("bytes");
		expect(result.lastLinePartial).toBe(true);
		expect(result.outputBytes).toBe(5);
	});

	it("truncates an oversized single line with a trailing newline", () => {
		const input = `${"X".repeat(300_000)}\n`;
		const result = truncateTail(input, { maxBytes: 1024, maxLines: 100 });

		expect(result.content).toBe("X".repeat(1024));
		expect(result.outputBytes).toBe(1024);
		expect(result.outputLines).toBe(1);
		expect(result.lastLinePartial).toBe(true);
		expect(result.truncatedBy).toBe("bytes");
	});

	it("drops an oversized trailing character when it cannot fit in tail byte limit", () => {
		const result = truncateTail("abc🙂", { maxBytes: 3, maxLines: 10 });

		expect(result.content).toBe("");
		expect(result.truncated).toBe(true);
		expect(result.truncatedBy).toBe("bytes");
		expect(result.lastLinePartial).toBe(true);
		expect(result.outputBytes).toBe(0);
	});

	it("matches Buffer tail truncation semantics for surrogate edge cases", () => {
		const inputs = ["a\ud83d", "\ude42b", "a\ude42b", "\ud83d\ud83d\ude42", "\ud83d\ude42\ude42", "👩‍💻"];
		for (const input of inputs) assertMatchesBufferTail(input);
	});

	it("matches Buffer tail truncation semantics across deterministic fuzz cases", () => {
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
		function random(): number {
			seed = (seed * 1664525 + 1013904223) >>> 0;
			return seed / 0x100000000;
		}
		for (let i = 0; i < 1_000; i++) {
			let input = "";
			const length = Math.floor(random() * 80);
			for (let j = 0; j < length; j++) input += alphabet[Math.floor(random() * alphabet.length)];
			assertMatchesBufferTail(input, sampledByteLimits(input));
		}
	});

	it("formats sizes and truncates long single lines", () => {
		expect(formatSize(1023)).toBe("1023B");
		expect(formatSize(1536)).toBe("1.5KB");
		expect(formatSize(3 * 1024 * 1024)).toBe("3.0MB");
		expect(truncateLine("abc", 3)).toEqual({ text: "abc", wasTruncated: false });
		expect(truncateLine("abcdef", 3)).toEqual({ text: "abc... [truncated]", wasTruncated: true });
	});
});

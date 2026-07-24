import { describe, expect, it } from "vitest";
import { truncateHead, truncateTail } from "../../src/harness/utils/truncate.ts";

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
	it("counts UTF-8 bytes without Node Buffer", () => {
		const content = "aé🙂\nb";
		const result = truncateHead(content, { maxBytes: 100, maxLines: 10 });

		expect(result.truncated).toBe(false);
		expect(result.totalBytes).toBe(byteLength(content));
		expect(result.outputBytes).toBe(byteLength(content));
		expect(result.totalBytes).toBe(9);
	});

	it("does not count a trailing newline as an extra line", () => {
		const content = `${Array.from({ length: 3 }, () => "line").join("\n")}\n`;
		const head = truncateHead(content, { maxBytes: 100, maxLines: 3 });
		const tail = truncateTail(content, { maxBytes: 100, maxLines: 3 });

		expect(head).toMatchObject({ truncated: false, totalLines: 3, outputLines: 3 });
		expect(tail).toMatchObject({ truncated: false, totalLines: 3, outputLines: 3 });
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
});

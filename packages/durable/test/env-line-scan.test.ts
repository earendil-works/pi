import { describe, expect, it } from "vitest";
import { StreamDecoder } from "../src/env/decode.ts";
import { LineScanner } from "../src/env/line-scan.ts";

function random(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

// Newlines, ASCII, a byte-order mark, valid multi-byte sequences, and bytes that form invalid or truncated sequences.
const PIECES = [
	[0x0a],
	[0x0a],
	[0x61],
	[0x62, 0x63],
	[0xef, 0xbb, 0xbf],
	[0xc3, 0xa9],
	[0xe2, 0x82, 0xac],
	[0xf0, 0x9f, 0x98, 0x80],
	[0xe2, 0x82],
	[0xff],
	[0x80],
	[0xf0, 0x9f],
	[0x0d, 0x0a],
];

function randomFile(next: () => number): Uint8Array {
	const bytes: number[] = [];
	const pieces = Math.floor(next() * 60);
	for (let index = 0; index < pieces; index++) bytes.push(...PIECES[Math.floor(next() * PIECES.length)]!);
	return Uint8Array.from(bytes);
}

const utf8 = (text: string): number => new TextEncoder().encode(text).length;

describe("StreamDecoder", () => {
	// Node's streaming TextDecoder with BOM handling dropped this U+FEFF, which follows an invalid sequence.
	it("keeps a U+FEFF that does not start the stream", () => {
		const bytes = Uint8Array.from([0xe2, 0x82, 0xef, 0xbb, 0xbf, 0x61]);
		const decoder = new StreamDecoder();
		const text = [...bytes].map((byte) => decoder.decode(Uint8Array.of(byte))).join("") + decoder.decode();
		expect(text).toBe(new TextDecoder().decode(bytes));
		expect(text).toBe("\ufffd\ufeffa");
	});

	it("decodes any chunking like decoding the whole stream", () => {
		for (let seed = 1; seed <= 5000; seed++) {
			const next = random(seed);
			const bytes = randomFile(next);
			const decoder = new StreamDecoder();
			let text = "";
			for (let offset = 0; offset < bytes.length; ) {
				const size = 1 + Math.floor(next() * 7);
				text += decoder.decode(bytes.subarray(offset, offset + size));
				offset += size;
			}
			expect(text + decoder.decode(), `seed ${seed}`).toBe(new TextDecoder().decode(bytes));
		}
	});
});

describe("LineScanner", () => {
	it("agrees with decoding and splitting the whole file", () => {
		for (let seed = 1; seed <= 5000; seed++) {
			const next = random(seed);
			const file = randomFile(next);
			const lines = new TextDecoder().decode(file).split("\n");
			const startLine = Math.floor(next() * (lines.length + 2));
			const endLine = next() < 0.3 ? undefined : startLine + 1 + Math.floor(next() * (lines.length + 1));
			const scanner = new LineScanner(startLine, endLine);
			for (let offset = 0; offset < file.length; ) {
				const size = 1 + Math.floor(next() * 7);
				scanner.push(file.subarray(offset, offset + size));
				offset += size;
			}
			const scan = scanner.finish();
			const message = `seed ${seed}`;
			expect(scan.newlines, message).toBe(lines.length - 1);
			const selected = lines.slice(startLine, endLine);
			const decode = (from: number, to: number) =>
				new TextDecoder("utf-8", { ignoreBOM: from > 0 }).decode(file.subarray(from, to));
			expect(decode(scan.start, scan.end), message).toBe(selected.join("\n"));
			expect(scan.selectedBytes, message).toBe(utf8(selected.join("\n")));
			if (startLine < lines.length) {
				expect(decode(scan.start, scan.firstLineEnd), message).toBe(lines[startLine]);
				expect(scan.firstLineBytes, message).toBe(utf8(lines[startLine]!));
				const lastLine = Math.min(endLine ?? lines.length, lines.length) - 1;
				const lastEnd = lastLine + 1 < lines.length ? file.indexOf(0x0a, scan.lastLineStart) : file.length;
				expect(decode(scan.lastLineStart, lastEnd), message).toBe(lines[lastLine]);
			} else {
				expect(scan, message).toMatchObject({ start: file.length, end: file.length, selectedBytes: 0 });
			}
		}
	});

	it("rejects empty or invalid ranges", () => {
		expect(() => new LineScanner(2, 2)).toThrow(RangeError);
		expect(() => new LineScanner(-1)).toThrow(RangeError);
		expect(() => new LineScanner(1.5)).toThrow(RangeError);
	});
});

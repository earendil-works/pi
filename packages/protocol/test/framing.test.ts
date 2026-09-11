import { describe, expect, test } from "vitest";
import { DEFAULT_MAX_FRAME_LENGTH, encodeFrame, FrameDecoder, FrameError } from "../src/index.ts";

function concatenate(...chunks: Uint8Array[]): Uint8Array {
	const result = new Uint8Array(chunks.reduce((length, chunk) => length + chunk.byteLength, 0));
	let offset = 0;
	for (const chunk of chunks) {
		result.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return result;
}

describe("binary framing", () => {
	test("prefixes payloads with a four-byte big-endian length", () => {
		expect(encodeFrame(new Uint8Array([0xaa, 0xbb, 0xcc]))).toEqual(
			new Uint8Array([0x00, 0x00, 0x00, 0x03, 0xaa, 0xbb, 0xcc]),
		);
		expect(encodeFrame(new Uint8Array())).toEqual(new Uint8Array([0, 0, 0, 0]));
	});

	test("decodes fragmented, coalesced, and empty frames in order", () => {
		const wire = concatenate(
			encodeFrame(new Uint8Array([1, 2, 3])),
			encodeFrame(new Uint8Array()),
			encodeFrame(new Uint8Array([4])),
		);
		const decoder = new FrameDecoder();
		const frames: Uint8Array[] = [];
		for (const byte of wire) frames.push(...decoder.push(new Uint8Array([byte])));
		decoder.end();
		expect(frames).toEqual([new Uint8Array([1, 2, 3]), new Uint8Array(), new Uint8Array([4])]);

		const coalesced = new FrameDecoder();
		expect(coalesced.push(wire)).toEqual(frames);
		coalesced.end();
	});

	test("assembles payloads spanning multiple internal blocks", () => {
		const payload = Uint8Array.from({ length: 70_000 }, (_, index) => index % 251);
		const wire = encodeFrame(payload);
		const decoder = new FrameDecoder();
		const frames = [
			...decoder.push(wire.subarray(0, 101)),
			...decoder.push(wire.subarray(101, 65_541)),
			...decoder.push(wire.subarray(65_541)),
		];
		decoder.end();
		expect(frames).toEqual([payload]);
	});

	test("handles every split point across a frame", () => {
		const wire = encodeFrame(new Uint8Array([10, 20, 30, 40]));
		for (let split = 0; split <= wire.byteLength; split++) {
			const decoder = new FrameDecoder();
			const frames = [...decoder.push(wire.subarray(0, split)), ...decoder.push(wire.subarray(split))];
			decoder.end();
			expect(frames).toEqual([new Uint8Array([10, 20, 30, 40])]);
		}
	});

	test("copies payload bytes instead of retaining or aliasing input chunks", () => {
		const chunk = encodeFrame(new Uint8Array([1, 2, 3]));
		const decoder = new FrameDecoder();
		const frames = decoder.push(chunk);
		chunk.fill(9);
		expect(frames).toEqual([new Uint8Array([1, 2, 3])]);
	});

	test("accepts empty chunks and a clean empty stream", () => {
		const decoder = new FrameDecoder();
		expect(decoder.push(new Uint8Array())).toEqual([]);
		expect(() => decoder.end()).not.toThrow();
	});

	test.each([
		["partial header", new Uint8Array([0, 0, 0])],
		["partial payload", new Uint8Array([0, 0, 0, 2, 1])],
	] as const)("rejects a truncated stream at end: %s", (_label, wire) => {
		const decoder = new FrameDecoder();
		expect(decoder.push(wire)).toEqual([]);
		expect(() => decoder.end()).toThrow(FrameError);
	});

	test("rejects an oversized declared length as soon as its header is complete", () => {
		const decoder = new FrameDecoder({ maxFrameLength: 3 });
		expect(() => decoder.push(new Uint8Array([0, 0, 0, 4]))).toThrow(/limit/i);
		expect(() => decoder.push(new Uint8Array([1]))).toThrow(/failed/i);
	});

	test("accepts a frame exactly at the configured maximum", () => {
		const decoder = new FrameDecoder({ maxFrameLength: 3 });
		expect(decoder.push(encodeFrame(new Uint8Array([1, 2, 3])))).toEqual([new Uint8Array([1, 2, 3])]);
		decoder.end();
	});

	test("cannot be pushed after end", () => {
		const decoder = new FrameDecoder();
		decoder.end();
		expect(() => decoder.push(new Uint8Array())).toThrow(/ended/i);
		expect(() => decoder.end()).toThrow(/ended/i);
	});

	test.each([-1, 1.5, Number.NaN, DEFAULT_MAX_FRAME_LENGTH * 1_000])(
		"rejects invalid maximum frame length: %s",
		(maxFrameLength) => {
			expect(() => new FrameDecoder({ maxFrameLength })).toThrow(RangeError);
		},
	);
});

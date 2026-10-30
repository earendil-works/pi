// Tests of nodeCompression: raw deflate and the bounded inflate with its tagged outcomes, a limit of 0 included.

import { describe, expect, it } from "vitest";
import type { Inflated } from "../../src/next/link/part.ts";
import { nodeCompression } from "../../src/next-node/compression.ts";

const UTF8 = new TextEncoder();

const bytesOf = (inflated: Inflated) => (inflated.kind === "bytes" ? new Uint8Array(inflated.bytes) : inflated);

describe("nodeCompression", () => {
	it("deflates raw at level 1 and inflates back", () => {
		const bytes = UTF8.encode(JSON.stringify({ text: "lorem ipsum ".repeat(5000) }));
		const deflated = nodeCompression.deflate(bytes);
		expect(deflated.byteLength).toBeLessThan(bytes.byteLength / 10);
		expect(bytesOf(nodeCompression.inflate(deflated, bytes.byteLength))).toEqual(bytes);
		expect(bytesOf(nodeCompression.inflate(deflated, Number.POSITIVE_INFINITY))).toEqual(bytes);
	});

	it("gives too_large past the limit, without inflating the rest (a bomb)", () => {
		const bomb = nodeCompression.deflate(new Uint8Array(256 * 1024 * 1024));
		expect(nodeCompression.inflate(bomb, 1024 * 1024)).toEqual({ kind: "too_large" });
	});

	it("takes a limit of 0: an empty stream inflates, anything else is too_large (never zlib's range error)", () => {
		expect(bytesOf(nodeCompression.inflate(nodeCompression.deflate(new Uint8Array(0)), 0))).toEqual(
			new Uint8Array(0),
		);
		expect(nodeCompression.inflate(nodeCompression.deflate(new Uint8Array(1)), 0)).toEqual({ kind: "too_large" });
		expect(nodeCompression.inflate(nodeCompression.deflate(new Uint8Array(100)), 0)).toEqual({ kind: "too_large" });
		expect(bytesOf(nodeCompression.inflate(nodeCompression.deflate(new Uint8Array(1)), 1))).toEqual(
			new Uint8Array(1),
		);
	});

	it("gives corrupt for data that is no raw deflate stream", () => {
		expect(nodeCompression.inflate(new Uint8Array([255, 1, 2, 3]), 100)).toMatchObject({ kind: "corrupt" });
	});
});

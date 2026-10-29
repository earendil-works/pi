// Tests of parts on links: the limits per part (in UTF-8 bytes), compression at the origin, opening a part where it is
// owned, and the asynchronous inflate with its limit, its corrupt outcome and its stop when the link closes.

import { describe, expect, it } from "vitest";
import {
	COMPRESS_ABOVE,
	type Compression,
	DeflatedPart,
	inflateAsync,
	linkLimits,
	openPart,
	originPart,
	oversized,
} from "../../../src/next/link/part.ts";
import { nodeCompression } from "../../../src/next-node/compression.ts";
import { metered } from "../support.ts";

const UTF8 = new TextEncoder();

const NONE = { part: Number.POSITIVE_INFINITY, decoded: Number.POSITIVE_INFINITY };

/** A link that never closes. */
const NEVER = new AbortController().signal;

/** A JSON text of `length` characters that deflates well. */
const json = (length: number) => JSON.stringify("x".repeat(length - 2));

/** What `fn` threw. */
function thrown(fn: () => unknown): unknown {
	try {
		fn();
	} catch (error) {
		return error;
	}
	throw new Error("expected a throw");
}

describe("limits per part", () => {
	it("default to none on trusted links and to 16 MiB on the wire, 64 MiB decoded on untrusted ones", () => {
		expect(linkLimits(true)).toEqual(NONE);
		expect(linkLimits(false)).toEqual({ part: 16 * 1024 * 1024, decoded: 64 * 1024 * 1024 });
		expect(linkLimits(false, { part: 10 })).toEqual({ part: 10, decoded: 64 * 1024 * 1024 });
		expect(linkLimits(true, { decoded: 5 })).toEqual({ part: Number.POSITIVE_INFINITY, decoded: 5 });
	});

	it("check a part's size on the wire with one comparison, nothing parsed", () => {
		expect(oversized("[1,2]", 5)).toBeUndefined();
		expect(oversized("[1,2,3]", 5)?.toJSON()).toEqual({
			code: "too_large",
			reason: "part",
			message: "a part of 7 bytes is over the wire limit of 5 bytes",
		});
		expect(oversized(new Uint8Array(6), 5)?.code).toBe("too_large");
		expect(oversized(new DeflatedPart(new Uint8Array(5)), 5)).toBeUndefined();
	});

	it("count text in UTF-8 bytes, not UTF-16 units (a text link bounds what a binary link does)", () => {
		const text = JSON.stringify("界".repeat(6000));
		expect(UTF8.encode(text).byteLength).toBe(18_002);
		expect(oversized(text, 18_002)).toBeUndefined();
		expect(oversized(text, 18_001)?.message).toBe("a part of 18002 bytes is over the wire limit of 18001 bytes");
		// Two-byte characters and surrogate pairs (four bytes for two units).
		expect(oversized('"é😀"', 8)).toBeUndefined();
		expect(oversized('"é😀"', 7)?.code).toBe("too_large");
	});
});

describe("compression at the origin", () => {
	it("deflates a JSON part above 16 KiB when the host compresses, and counts it", async () => {
		const { context, counts } = await metered();
		const small = json(COMPRESS_ABOVE / 3);
		expect(originPart(small, nodeCompression, context)).toBe(small);
		const large = json(COMPRESS_ABOVE + 1);
		const part = originPart(large, nodeCompression, context);
		expect(part).toBeInstanceOf(DeflatedPart);
		expect((part as DeflatedPart).bytes.byteLength).toBeLessThan(200);
		expect(counts()["chord.link.deflates"]).toBe(1);
	});

	it("measures the threshold in UTF-8 bytes: a text of few units but many bytes is compressed", async () => {
		const { context } = await metered();
		const text = JSON.stringify("界".repeat(6000));
		expect(text.length).toBeLessThan(COMPRESS_ABOVE);
		expect(originPart(text, nodeCompression, context)).toBeInstanceOf(DeflatedPart);
		// Within the threshold in bytes: its bytes, encoded once (the codec copies them).
		const within = json(COMPRESS_ABOVE);
		expect(originPart(within, nodeCompression, context)).toEqual(UTF8.encode(within));
	});

	it("sends a part as it is without a compressor, and its bytes when deflating does not make it smaller", async () => {
		const { context } = await metered();
		const large = json(COMPRESS_ABOVE * 2);
		expect(originPart(large, undefined, context)).toBe(large);
		const useless: Compression = {
			deflate: (bytes) => bytes,
			inflate: (bytes) => ({ kind: "bytes", bytes }),
		};
		expect(originPart(large, useless, context)).toEqual(UTF8.encode(large));
	});
});

describe("opening a part", () => {
	it("returns a plain part within its limits; past either it throws too_large/part", async () => {
		const { context } = await metered();
		expect(openPart("[1]", NONE, undefined, context)).toBe("[1]");
		expect(() => openPart("[1,2]", { part: 4, decoded: 100 }, undefined, context)).toThrow(
			"a part of 5 bytes is over the wire limit of 4 bytes",
		);
		// Not deflated: its decoded size is its size.
		expect(() => openPart(UTF8.encode("[1,2]"), { part: 100, decoded: 4 }, undefined, context)).toThrow(
			"a part of 5 bytes is over the decoded limit of 4 bytes",
		);
	});

	it("inflates a deflated part synchronously within the decoded limit, and counts it", async () => {
		const { context, counts } = await metered();
		const text = json(100_000);
		const part = new DeflatedPart(nodeCompression.deflate(UTF8.encode(text)));
		const opened = openPart(part, { part: 1000, decoded: 100_000 }, nodeCompression, context);
		expect(new TextDecoder().decode(opened as Uint8Array)).toBe(text);
		expect(counts()["chord.link.inflates"]).toBe(1);
	});

	it("refuses a compression bomb: a small part inflating past the decoded limit", async () => {
		const { context } = await metered();
		const bomb = new DeflatedPart(nodeCompression.deflate(new Uint8Array(10 * 1024 * 1024)));
		expect(bomb.bytes.byteLength).toBeLessThan(50_000);
		const error = thrown(() => openPart(bomb, { part: 1_000_000, decoded: 1024 * 1024 }, nodeCompression, context));
		expect(error).toMatchObject({ code: "too_large", reason: "part" });
	});

	it("checks the wire size before inflating anything", async () => {
		const { context, counts } = await metered();
		const part = new DeflatedPart(nodeCompression.deflate(UTF8.encode(json(100_000))));
		const error = thrown(() => openPart(part, { part: 10, decoded: 1_000_000 }, nodeCompression, context));
		expect(error).toMatchObject({ code: "too_large", message: expect.stringContaining("wire limit") });
		expect(counts()["chord.link.inflates"]).toBeUndefined();
	});

	it("opens what an asynchronous inflate left on the part", async () => {
		const { context } = await metered();
		const part = new DeflatedPart(nodeCompression.deflate(UTF8.encode(json(1000))));
		await inflateAsync(part, 2000, NEVER, context);
		expect(openPart(part, { part: 1000, decoded: 2000 }, undefined, context)).toHaveLength(1000);
		const bomb = new DeflatedPart(nodeCompression.deflate(UTF8.encode(json(1000))));
		await inflateAsync(bomb, 999, NEVER, context);
		expect(() => openPart(bomb, { part: 1000, decoded: 999 }, undefined, context)).toThrow("decoded limit of 999");
	});

	it("throws a plain error for a deflated part nothing inflated, or no raw deflate stream (a protocol error)", async () => {
		const { context } = await metered();
		const part = new DeflatedPart(new Uint8Array([255, 255, 255]));
		expect(() => openPart(part, NONE, undefined, context)).toThrow("a deflated part this host did not inflate");
		expect(() => openPart(part, NONE, nodeCompression, context)).toThrow("no raw deflate stream");
		expect(thrown(() => openPart(part, NONE, nodeCompression, context))).not.toMatchObject({ code: "too_large" });
	});
});

describe("the asynchronous inflate", () => {
	it("inflates with DecompressionStream, counting output bytes", async () => {
		const { context, counts } = await metered();
		const text = json(200_000);
		const part = new DeflatedPart(nodeCompression.deflate(UTF8.encode(text)));
		await inflateAsync(part, Number.POSITIVE_INFINITY, NEVER, context);
		expect(part.inflated?.kind).toBe("bytes");
		expect(new TextDecoder().decode(openPart(part, NONE, undefined, context) as Uint8Array)).toBe(text);
		expect(counts()["chord.link.inflates"]).toBe(1);
	});

	it("stops past the limit: a bomb leaves too_large, never the whole output; a limit of 0 too", async () => {
		const { context } = await metered();
		const bomb = new DeflatedPart(nodeCompression.deflate(new Uint8Array(64 * 1024 * 1024)));
		await inflateAsync(bomb, 1024 * 1024, NEVER, context);
		expect(bomb.inflated).toEqual({ kind: "too_large" });
		const one = new DeflatedPart(nodeCompression.deflate(new Uint8Array(1)));
		await inflateAsync(one, 0, NEVER, context);
		expect(one.inflated).toEqual({ kind: "too_large" });
	});

	it("leaves corrupt for data that is no raw deflate stream", async () => {
		const { context } = await metered();
		const part = new DeflatedPart(new Uint8Array([255, 255, 255]));
		await inflateAsync(part, 100, NEVER, context);
		expect(part.inflated?.kind).toBe("corrupt");
	});

	it("stops at once when its link closes (the signal), leaving no outcome", async () => {
		const { context } = await metered();
		const closing = new AbortController();
		const part = new DeflatedPart(nodeCompression.deflate(new Uint8Array(64 * 1024 * 1024)));
		const inflating = inflateAsync(part, Number.POSITIVE_INFINITY, closing.signal, context);
		closing.abort();
		await inflating;
		expect(part.inflated).toBeUndefined();
	});
});

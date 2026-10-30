import { describe, expect, it } from "vitest";
import { isChordError } from "../../../src/next/data/index.ts";
import { jsonPart, parsePart, parsePayload, payloadPart, resolveSegments } from "../../../src/next/link/values.ts";

describe("parts", () => {
	it("are JSON text at their origin, parsed from text or from UTF-8 bytes where they are owned", () => {
		expect(jsonPart({ a: [1, "x"] })).toBe('{"a":[1,"x"]}');
		expect(jsonPart(undefined)).toBe("null");
		expect(parsePart('{"a":1}')).toEqual({ a: 1 });
		expect(parsePart(new TextEncoder().encode('{"a":"\u00e9"}'))).toEqual({ a: "\u00e9" });
	});

	it("that are no strict UTF-8 JSON throw (a protocol error where they are parsed)", () => {
		expect(() => parsePart("{")).toThrow();
		expect(() => parsePart(new Uint8Array([0x22, 0xff, 0x22]))).toThrow();
	});
});

describe("payloads", () => {
	it("marked as carrying bytes write each byte leaf as a segment referenced by {$bytes: i}", () => {
		const data = new Uint8Array(1024).fill(7);
		const thumbs = [new Uint8Array([1, 2]), new Uint8Array([3])];
		const { json, segments } = payloadPart({ name: "chart.png", data, thumbs }, true);
		expect(json).toBe('{"name":"chart.png","data":{"$bytes":0},"thumbs":[{"$bytes":1},{"$bytes":2}]}');
		expect(segments).toEqual([data, ...thumbs]);
		expect(segments![0]).toBe(data);
		const read = parsePayload(json, segments) as { data: Uint8Array; thumbs: Uint8Array[] };
		expect(read.data).toBe(data);
		expect(read.thumbs).toEqual(thumbs);
	});

	it("marked as carrying bytes refuse the reserved key $bytes with invalid/args", () => {
		let thrown: unknown;
		try {
			payloadPart({ meta: { $bytes: 0 }, data: new Uint8Array(1) }, true);
		} catch (error) {
			thrown = error;
		}
		expect(isChordError(thrown, "invalid") && thrown.reason).toBe("args");
	});

	it("not marked are plain JSON, $bytes included; undefined is null", () => {
		expect(payloadPart({ $bytes: 0 }, false)).toEqual({ json: '{"$bytes":0}', segments: undefined });
		expect(payloadPart(undefined, false).json).toBe("null");
		expect(parsePayload('{"$bytes":0}', undefined)).toEqual({ $bytes: 0 });
	});

	it.each([
		["an index past the segments", { $bytes: 1 }],
		["a non-integer index", { $bytes: "0" }],
		["other keys next to $bytes", { $bytes: 0, x: 1 }],
	])("refuse a malformed reference: %s", (_, value) => {
		expect(() => resolveSegments({ a: [value] }, [new Uint8Array(1)])).toThrow(
			"payload: a malformed byte segment reference",
		);
	});

	it("define a resolved key __proto__ as an own property", () => {
		const parsed = JSON.parse('{"__proto__":{"$bytes":0}}');
		const resolved = resolveSegments(parsed, [new Uint8Array(1)]) as object;
		expect(Object.getPrototypeOf(resolved)).toBe(Object.prototype);
		expect(Object.getOwnPropertyDescriptor(resolved, "__proto__")?.value).toEqual(new Uint8Array(1));
	});
});

import { describe, expect, test } from "vitest";
import {
	CborError,
	DEFAULT_MAX_CBOR_BYTE_LENGTH,
	DEFAULT_MAX_CBOR_CONTAINER_LENGTH,
	DEFAULT_MAX_CBOR_DEPTH,
	decodeCbor,
	encodeCbor,
} from "../../src/index.ts";

function fromHex(hex: string): Uint8Array {
	if (hex.length % 2 !== 0) throw new Error("Hex fixture must contain whole bytes");
	const bytes = new Uint8Array(hex.length / 2);
	for (let index = 0; index < bytes.length; index++)
		bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
	return bytes;
}

function toHex(bytes: Uint8Array): string {
	return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

const knownVectors: ReadonlyArray<readonly [unknown, string]> = [
	[null, "f6"],
	[false, "f4"],
	[true, "f5"],
	[0, "00"],
	[1, "01"],
	[10, "0a"],
	[23, "17"],
	[24, "1818"],
	[25, "1819"],
	[100, "1864"],
	[1000, "1903e8"],
	[1_000_000, "1a000f4240"],
	[1_000_000_000_000, "1b000000e8d4a51000"],
	[Number.MAX_SAFE_INTEGER, "1b001fffffffffffff"],
	[-1, "20"],
	[-10, "29"],
	[-24, "37"],
	[-25, "3818"],
	[-100, "3863"],
	[-1000, "3903e7"],
	[-1_000_000, "3a000f423f"],
	[Number.MIN_SAFE_INTEGER, "3b001ffffffffffffe"],
	[1.1, "fb3ff199999999999a"],
	[-0, "fb8000000000000000"],
	[new Uint8Array([1, 2, 3, 4]), "4401020304"],
	["", "60"],
	["IETF", "6449455446"],
	["ü", "62c3bc"],
	["水", "63e6b0b4"],
	["𐅑", "64f0908591"],
	[[], "80"],
	[[1, 2, 3], "83010203"],
	[[1, [2, 3], [4, 5]], "8301820203820405"],
	[{ a: 1, b: [2, 3] }, "a26161016162820203"],
];

describe("CBOR codec", () => {
	test.each(knownVectors)("encodes and decodes RFC 8949 vector %#", (value, wire) => {
		const encoded = encodeCbor(value);
		expect(toHex(encoded)).toBe(wire);
		const decoded = decodeCbor(fromHex(wire));
		if (typeof value === "number" && Object.is(value, -0)) expect(Object.is(decoded, -0)).toBe(true);
		else expect(decoded).toEqual(value);
	});

	test("omits undefined object properties without omitting falsey values", () => {
		const value = { omitted: undefined, zero: 0, empty: "", no: false, nil: null };
		expect(decodeCbor(encodeCbor(value))).toEqual({ zero: 0, empty: "", no: false, nil: null });
	});

	test("preserves a leading Unicode BOM and treats __proto__ as data", () => {
		expect(decodeCbor(fromHex("63efbbbf"))).toBe("\ufeff");
		const value: Record<string, unknown> = {};
		Object.defineProperty(value, "__proto__", { enumerable: true, value: "safe" });
		const decoded = decodeCbor(encodeCbor(value));
		expect(decoded).toEqual(value);
		expect(Object.getPrototypeOf(decoded)).toBe(Object.prototype);
		expect(Object.hasOwn(decoded as object, "__proto__")).toBe(true);
	});

	test.each([
		["top-level undefined", undefined],
		["undefined array element", [undefined]],
		["array hole", new Array(1)],
		["NaN", Number.NaN],
		["positive infinity", Number.POSITIVE_INFINITY],
		["negative infinity", Number.NEGATIVE_INFINITY],
		["unsafe positive integer", Number.MAX_SAFE_INTEGER + 1],
		["unsafe negative integer", Number.MIN_SAFE_INTEGER - 1],
		["bigint", 1n],
		["symbol", Symbol("unsupported")],
		["function", () => undefined],
		["Date", new Date(0)],
		["Map", new Map<string, unknown>()],
	] as const)("rejects unsupported encoder value: %s", (_label, value) => {
		expect(() => encodeCbor(value)).toThrow(CborError);
	});

	test("rejects maps with enumerable symbol keys", () => {
		const value = { valid: true };
		Object.defineProperty(value, Symbol("key"), { enumerable: true, value: false });
		expect(() => encodeCbor(value)).toThrow(CborError);
	});

	test("rejects lossy strings, cycles, and excessive encoder depth", () => {
		expect(() => encodeCbor("\ud800")).toThrow(/Unicode/i);

		const cyclic: unknown[] = [];
		cyclic.push(cyclic);
		expect(() => encodeCbor(cyclic)).toThrow(/cycles/i);

		let tooDeep: unknown = null;
		for (let depth = 0; depth <= DEFAULT_MAX_CBOR_DEPTH; depth++) tooDeep = [tooDeep];
		expect(() => encodeCbor(tooDeep)).toThrow(/depth/i);
	});

	test.each([
		["empty input", ""],
		["truncated integer", "18"],
		["reserved additional information", "1c"],
		["indefinite byte string", "5f"],
		["indefinite text string", "7f"],
		["indefinite array", "9f"],
		["indefinite map", "bf"],
		["tag", "c000"],
		["undefined", "f7"],
		["unsupported simple value", "e0"],
		["break outside an indefinite item", "ff"],
		["float16", "f93c00"],
		["float32", "fa3f800000"],
		["positive infinity", "fb7ff0000000000000"],
		["NaN", "fb7ff8000000000000"],
		["truncated float64", "fb3ff00000"],
		["truncated byte string", "44010203"],
		["truncated text string", "636162"],
		["truncated array", "8201"],
		["truncated map", "a16161"],
		["trailing data", "0000"],
		["non-string map key", "a10102"],
		["duplicate map key", "a2616101616102"],
		["invalid UTF-8 byte", "61ff"],
		["overlong UTF-8", "62c080"],
		["UTF-8 surrogate", "63eda080"],
		["unsafe positive integer", "1b0020000000000000"],
		["unsafe negative integer", "3b001fffffffffffff"],
		["unsafe integer encoded as float64", "fb4340000000000000"],
	] as const)("rejects invalid decoder input: %s", (_label, wire) => {
		expect(() => decodeCbor(fromHex(wire))).toThrow(CborError);
	});

	test("enforces depth and declared length limits before traversing values", () => {
		const tooDeep = new Uint8Array(DEFAULT_MAX_CBOR_DEPTH + 2);
		tooDeep.fill(0x81, 0, -1);
		tooDeep[tooDeep.length - 1] = 0xf6;
		expect(() => decodeCbor(tooDeep)).toThrow(/depth/i);

		const oversizedBytes = fromHex(`5a${(DEFAULT_MAX_CBOR_BYTE_LENGTH + 1).toString(16).padStart(8, "0")}`);
		const oversizedText = fromHex(`7a${(DEFAULT_MAX_CBOR_BYTE_LENGTH + 1).toString(16).padStart(8, "0")}`);
		const oversizedArray = fromHex(`9a${(DEFAULT_MAX_CBOR_CONTAINER_LENGTH + 1).toString(16).padStart(8, "0")}`);
		const oversizedMap = fromHex(`ba${(DEFAULT_MAX_CBOR_CONTAINER_LENGTH + 1).toString(16).padStart(8, "0")}`);
		for (const wire of [oversizedBytes, oversizedText, oversizedArray, oversizedMap]) {
			expect(() => decodeCbor(wire)).toThrow(/limit/i);
		}
	});

	test("supports stricter caller-provided limits", () => {
		expect(() => decodeCbor(fromHex("83010203"), { maxContainerLength: 2 })).toThrow(/limit/i);
		expect(() => decodeCbor(fromHex("626162"), { maxByteLength: 2 })).toThrow(/limit/i);
		expect(() => encodeCbor([1, 2, 3], { maxContainerLength: 2 })).toThrow(/limit/i);
		expect(() => encodeCbor("ab", { maxByteLength: 2 })).toThrow(/limit/i);
	});
});

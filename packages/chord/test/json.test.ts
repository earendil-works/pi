import { describe, expect, test } from "vitest";
import { isJsonValue } from "../src/index.ts";

describe("isJsonValue", () => {
	test("checks strict JSON without normalizing it", () => {
		expect(isJsonValue({ nested: [1, true, null] })).toBe(true);
		expect(isJsonValue({ omitted: undefined })).toBe(false);
		expect(isJsonValue(new Uint8Array([1]))).toBe(false);
		expect(isJsonValue(Number.POSITIVE_INFINITY)).toBe(false);
		const cyclic: { self?: unknown } = {};
		cyclic.self = cyclic;
		expect(isJsonValue(cyclic)).toBe(false);
	});
});

import Type from "typebox";
import { describe, expect, it } from "vitest";
import { arr, bool, bytes, int, num, obj, oneOf, opt, remote, str } from "../../../src/next/contracts/index.ts";

const variants = { a: { state: { s: str() } } };

describe("params policy", () => {
	it("accepts required str, int, bool and oneOf of strings, with constraints", () => {
		expect(() =>
			remote("n", {
				version: 1,
				params: {
					a: str({ min: 1, max: 9, pattern: "^x" }),
					b: int({ min: 0 }),
					c: bool(),
					d: oneOf("chat", "agent"),
				},
				variants,
			}),
		).not.toThrow();
	});

	it("refuses optional fields, in the types and at declaration", () => {
		// @ts-expect-error: params fields are required
		expect(() => remote("n", { version: 1, params: { a: opt(str()) }, variants })).toThrow(
			"n.params.a: a param is a required str(), int(), bool() or oneOf(...) of strings",
		);
	});

	it.each([
		["a number", num()],
		["nested objects", obj({ a: str() })],
		["arrays", arr(str())],
		["bytes", bytes()],
		["numeric literals", oneOf(1, 2)],
		["defaults", Type.String({ default: "x" })],
	])("refuses %s, in the types and at declaration", (_case, schema) => {
		// @ts-expect-error: not a params field schema
		expect(() => remote("n", { version: 1, params: { p: schema }, variants })).toThrow("n.params.p: a param is");
	});
});

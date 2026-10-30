import Type from "typebox";
import { describe, expect, it } from "vitest";
import {
	arr,
	bool,
	bytes,
	hostKind,
	int,
	num,
	obj,
	oneOf,
	opt,
	remote,
	str,
} from "../../../src/next/contracts/index.ts";

const Server = hostKind("server");

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
				hostAddress: () => Server(),
				variants,
			}),
		).not.toThrow();
	});

	it("refuses optional fields, in the types and at declaration", () => {
		expect(() =>
			// @ts-expect-error: params fields are required
			remote("n", { version: 1, params: { a: opt(str()) }, hostAddress: () => Server(), variants }),
		).toThrow("n.params.a: a param is a required str(), int(), bool() or oneOf(...) of strings");
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
		expect(() => remote("n", { version: 1, params: { p: schema }, hostAddress: () => Server(), variants })).toThrow(
			"n.params.p: a param is",
		);
	});
});

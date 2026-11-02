// Tests of the schema helpers: the JSON Schema they build over pi-schema's builders, their types, `bytes()`, `method`.

import { compile } from "@earendil-works/pi-schema";
import { describe, expect, expectTypeOf, it } from "vitest";
import {
	arr,
	bool,
	bytes,
	int,
	lit,
	map,
	method,
	nul,
	num,
	obj,
	oneOf,
	opt,
	type Static,
	str,
	union,
	unknown,
} from "../../../src/next/contracts/index.ts";
import { Method } from "../../../src/next/contracts/internal.ts";
import type { Equal } from "../support.ts";

describe("schema helpers", () => {
	it("produce plain JSON Schema with bounds under their JSON Schema names", () => {
		expect(str({ min: 1, max: 3, pattern: "^a" })).toEqual({
			type: "string",
			minLength: 1,
			maxLength: 3,
			pattern: "^a",
		});
		expect(num({ min: 0 })).toEqual({ type: "number", minimum: 0 });
		expect(int({ max: 9 })).toEqual({ type: "integer", maximum: 9 });
		expect(arr(bool(), { min: 1, max: 2 })).toEqual({
			type: "array",
			items: { type: "boolean" },
			minItems: 1,
			maxItems: 2,
		});
		expect(nul()).toEqual({ type: "null" });
		expect(lit(3)).toEqual({ type: "number", const: 3 });
		expect(oneOf("a", "b")).toEqual({ anyOf: [lit("a"), lit("b")] });
		expect(union([str(), nul()])).toEqual({ anyOf: [str(), nul()] });
		expect(map(int())).toEqual({ type: "object", patternProperties: { "^.*$": int() } });
		expect(unknown()).toEqual({});
	});

	it("leave absent bounds out instead of writing undefined", () => {
		expect(Object.keys(str())).toEqual(["type"]);
		expect(Object.keys(bytes())).toEqual(["type"]);
	});

	it("obj() is always closed and opt() makes a field optional", () => {
		const schema = obj({ a: str(), b: opt(int()) });
		expect(schema).toEqual({
			type: "object",
			required: ["a"],
			properties: { a: str(), b: int() },
			additionalProperties: false,
		});
		expect(compile(schema).check({ a: "x" })).toBe(true);
		expect(compile(schema).check({ a: "x", c: 1 })).toBe(false);
	});

	it("Static gives the values' type; pi-schema's compiler checks them", () => {
		const schema = obj({ kind: oneOf("chat", "agent"), n: opt(int()), tags: arr(str()), data: bytes() });
		type Expected = { kind: "chat" | "agent"; n?: number; tags: string[]; data: Uint8Array };
		expectTypeOf<Equal<Static<typeof schema>, Expected>>().toEqualTypeOf<true>();
		expect(compile(schema).check({ kind: "chat", tags: [], data: new Uint8Array(1) })).toBe(true);
	});
});

describe("bytes", () => {
	it("is plain data: the marker and nothing else", () => {
		const schema = bytes({ min: 1, max: 2 });
		expect(Reflect.ownKeys(schema)).toEqual(["type", "minLength", "maxLength"]);
		expect(schema).toEqual({ type: "bytes", minLength: 1, maxLength: 2 });
	});

	it("checks instanceof Uint8Array and the length bounds", () => {
		const validator = compile(bytes({ min: 1, max: 2 }));
		expect(validator.check(new Uint8Array(1))).toBe(true);
		expect(validator.check(new Uint8Array(2))).toBe(true);
		expect(validator.check(new Uint8Array(0))).toBe(false);
		expect(validator.check(new Uint8Array(3))).toBe(false);
		expect(validator.check([1])).toBe(false);
		expect(validator.check("ab")).toBe(false);
	});

	it("checks inside a record (slices.md L1 carry-over)", () => {
		const validator = compile(map(bytes({ max: 1 })));
		expect(validator.check({ a: new Uint8Array(1) })).toBe(true);
		expect(validator.check({ a: new Uint8Array(2) })).toBe(false);
	});
});

describe("method", () => {
	it("an omitted side is null", () => {
		expect(method()).toEqual(new Method(nul(), nul()));
		expect(method(str())).toEqual(new Method(str(), nul()));
		expect(method(undefined, int())).toEqual(new Method(nul(), int()));
		expectTypeOf(method(undefined, int())).toEqualTypeOf<Method<ReturnType<typeof nul>, ReturnType<typeof int>>>();
	});
});

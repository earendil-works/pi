// The builders: the JSON Schema they produce, the static types they carry, and how they compile.

import { describe, expect, expectTypeOf, it } from "vitest";
import {
	arr,
	bool,
	bytes,
	compile,
	int,
	lit,
	map,
	nul,
	nullable,
	num,
	obj,
	oneOf,
	opt,
	type Static,
	str,
	tuple,
	union,
	unknown,
} from "../src/index.ts";

describe("builders", () => {
	it("produce plain JSON Schema", () => {
		const schema = obj({
			path: str({ description: "File path", minLength: 1 }),
			offset: opt(int({ minimum: 1 })),
			mode: oneOf(["read", "write"]),
		});
		expect(JSON.parse(JSON.stringify(schema))).toEqual({
			type: "object",
			properties: {
				path: { type: "string", description: "File path", minLength: 1 },
				offset: { type: "integer", minimum: 1 },
				mode: { enum: ["read", "write"] },
			},
			required: ["path", "mode"],
			additionalProperties: false,
		});
	});

	it("produce every leaf", () => {
		expect([str(), num(), int(), bool(), nul(), unknown(), lit(3), bytes({ maxLength: 8 })]).toEqual([
			{ type: "string" },
			{ type: "number" },
			{ type: "integer" },
			{ type: "boolean" },
			{ type: "null" },
			{},
			{ const: 3 },
			{ type: "bytes", maxLength: 8 },
		]);
		expect(arr(str(), { maxItems: 2 })).toEqual({ type: "array", items: { type: "string" }, maxItems: 2 });
		expect(map(num())).toEqual({ type: "object", additionalProperties: { type: "number" } });
		expect(tuple([str(), num()])).toEqual({
			type: "array",
			prefixItems: [{ type: "string" }, { type: "number" }],
			items: false,
			minItems: 2,
		});
		expect(nullable(str())).toEqual({ anyOf: [{ type: "string" }, { type: "null" }] });
		expect(obj({ a: str() }, { open: true })).toEqual({
			type: "object",
			properties: { a: { type: "string" } },
			required: ["a"],
		});
	});

	it("carry the static type of valid values", () => {
		const message = union([
			obj({ kind: lit("text"), text: str() }),
			obj({ kind: lit("image"), url: str(), alt: opt(str()) }),
		]);
		expectTypeOf<Static<typeof message>>().toEqualTypeOf<
			{ kind: "text"; text: string } | { kind: "image"; url: string; alt?: string }
		>();
		const pair = tuple([str(), arr(int())]);
		expectTypeOf<Static<typeof pair>>().toEqualTypeOf<[string, number[]]>();
		expectTypeOf<Static<ReturnType<typeof nullable<string>>>>().toEqualTypeOf<string | null>();
		expectTypeOf<Static<{ type: "string" }>>().toEqualTypeOf<unknown>();
	});

	it("narrow values through a compiled check", () => {
		const point = obj({ x: num(), y: num(), label: opt(str()) });
		const value: unknown = { x: 1, y: 2 };
		const { check } = compile(point);
		if (!check(value)) throw new Error("expected a point");
		expectTypeOf(value).toEqualTypeOf<{ x: number; y: number; label?: string }>();
		expect(value.x + value.y).toBe(3);
	});

	it("compile into checks with the declared semantics", () => {
		const validator = compile(obj({ name: str({ minLength: 1 }), tags: opt(arr(str(), { uniqueItems: true })) }));
		expect(validator.check({ name: "a" })).toBe(true);
		expect(validator.check({ name: "a", tags: ["x", "y"] })).toBe(true);
		expect(validator.errors({ name: "", tags: ["x", "x"], other: 1 })).toEqual([
			{ path: "/name", keyword: "minLength", message: "expected at least 1 characters" },
			{ path: "/tags", keyword: "uniqueItems", message: "expected unique items" },
			{ path: "/other", keyword: "additionalProperties", message: "unknown field" },
		]);
	});
});

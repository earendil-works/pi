// The builders: the JSON Schema they produce, the static types they carry, and how they compile.

import { describe, expect, expectTypeOf, it } from "vitest";
import {
	arr,
	bigint,
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
	recursive,
	type Schema,
	type Static,
	str,
	tuple,
	union,
	unknown,
	unsafe,
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

	it("build a bigint with bounds, typed bigint", () => {
		const metric = nullable(bigint({ minimum: 0n }));
		expect(metric).toEqual({ anyOf: [{ type: "bigint", minimum: 0n }, { type: "null" }] });
		expectTypeOf<Static<typeof metric>>().toEqualTypeOf<bigint | null>();
		expect(compile(metric).check(3n)).toBe(true);
		expect(compile(metric).check(-1n)).toBe(false);
		expect(compile(metric).check(3)).toBe(false);
	});

	it("type a schema as given with unsafe", () => {
		type Usage = { input: number; output: number };
		const usage = unsafe<Usage>();
		const level = unsafe<"low" | "high">({ type: "string", enum: ["low", "high"] });
		expect(usage).toEqual({});
		expect(level).toEqual({ type: "string", enum: ["low", "high"] });
		const status = obj({ usage: nullable(usage), level });
		expectTypeOf<Static<typeof status>>().toEqualTypeOf<{ usage: Usage | null; level: "low" | "high" }>();
		// Nothing checks the given type: an unconstrained schema accepts any value.
		expect(compile(usage).check("not usage")).toBe(true);
		expect(compile(level).check("medium")).toBe(false);
	});

	it("build a recursive schema that checks every level", () => {
		type Tree = { name: string; children: Tree[] };
		const tree = recursive<Tree>("Tree", (self) => obj({ name: str(), children: arr(self) }));
		expect(tree).toEqual({
			type: "object",
			properties: { name: { type: "string" }, children: { type: "array", items: { $ref: "Tree" } } },
			required: ["name", "children"],
			additionalProperties: false,
			$id: "Tree",
		});
		expectTypeOf(tree).toEqualTypeOf<Schema<Tree>>();
		const validator = compile(tree);
		expect(validator.check({ name: "a", children: [{ name: "b", children: [] }] })).toBe(true);
		const deep = { name: "a", children: [{ name: "b", children: [{ name: 1, children: [] }] }] };
		expect(validator.errors(deep)).toEqual([
			{ path: "/children/0/children/0/name", keyword: "type", message: "expected string, got integer" },
		]);
	});

	it("nest recursive schemas with distinct ids inside other schemas", () => {
		type Tree = { name: string; children: Tree[] };
		type List = { value: number; next: List | null };
		const tree = recursive<Tree>("Tree", (self) => obj({ name: str(), children: arr(self) }));
		const list = recursive<List>("List", (self) => obj({ value: num(), next: nullable(self) }));
		const both = obj({ tree, list: opt(list) });
		expectTypeOf<Static<typeof both>>().toEqualTypeOf<{ tree: Tree; list?: List }>();
		const { check } = compile(both);
		const root = { name: "a", children: [{ name: "b", children: [] }] };
		expect(check({ tree: root, list: { value: 1, next: { value: 2, next: null } } })).toBe(true);
		expect(check({ tree: root, list: { value: 1, next: { value: "2", next: null } } })).toBe(false);
		expect(check({ tree: { name: "a", children: [{ name: "b", children: [{ name: 3 }] }] } })).toBe(false);
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

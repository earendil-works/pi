// compile(schema, { coerce: true }): coerce() and parse(), the three coercion passes (optional nulls, TypeBox's
// conversion rules, primitive coercion by type), their order where they conflict, and the guarantees around them.
// Ports pi-ai's tool argument coercion tests.

import Type from "typebox";
import { describe, expect, expectTypeOf, it } from "vitest";
import { formats } from "../src/formats/index.ts";
import {
	arr,
	compile,
	int,
	map,
	nullable,
	num,
	obj,
	opt,
	str,
	tuple,
	type ValidationError,
	type Validator,
} from "../src/index.ts";

function coerce(schema: object, value: unknown): unknown {
	return compile(schema, { formats, coerce: true }).coerce(value);
}

/** The coerced `value` property of `{ value }` under an object schema with one required property `value`. */
function coerceValue(schema: unknown, value: unknown): unknown {
	const root = { type: "object", properties: { value: schema }, required: ["value"] };
	return (coerce(root, { value }) as { value: unknown }).value;
}

describe("compile options", () => {
	it("adds coerce and parse only with coerce: true", () => {
		const plain = compile(obj({ n: num() }));
		expectTypeOf(plain).toEqualTypeOf<Validator<{ n: number }>>();
		expect("coerce" in plain).toBe(false);
		expect("parse" in plain).toBe(false);
		const coercing = compile(obj({ n: num() }), { coerce: true });
		expectTypeOf(coercing.parse).returns.toEqualTypeOf<
			| { readonly ok: true; readonly value: { n: number } }
			| { readonly ok: false; readonly errors: ValidationError[] }
		>();
		expect(coercing.check({ n: 1 })).toBe(true);
	});
});

describe("coerce", () => {
	it("never modifies the value", () => {
		const value = { count: "42", tags: "a" };
		const schema = obj({ count: num(), tags: arr(str()) });
		expect(coerce(schema, value)).toEqual({ count: 42, tags: ["a"] });
		expect(value).toEqual({ count: "42", tags: "a" });
	});

	it("returns the value itself when nothing changes", () => {
		const value = { a: { b: [1, 2] }, c: "x" };
		const schema = obj({ a: obj({ b: arr(num()) }), c: str() });
		expect(coerce(schema, value)).toBe(value);
	});

	it("copies only the changed paths", () => {
		const unchanged = { b: [1, 2] };
		const value = { a: unchanged, c: { d: "1" } };
		const schema = obj({ a: obj({ b: arr(num()) }), c: obj({ d: num() }) });
		const coerced = coerce(schema, value) as typeof value;
		expect(coerced).toEqual({ a: { b: [1, 2] }, c: { d: 1 } });
		expect(coerced).not.toBe(value);
		expect(coerced.a).toBe(unchanged);
		expect(value.c).toEqual({ d: "1" });
	});

	it("works on frozen schemas", () => {
		const schema = Object.freeze({
			type: "object",
			properties: Object.freeze({ n: Object.freeze({ type: "integer" }) }),
		});
		expect(coerce(schema, { n: "7" })).toEqual({ n: 7 });
	});

	it("still coerces when the Function constructor is unavailable", () => {
		const original = globalThis.Function;
		globalThis.Function = (() => {
			throw new EvalError("Code generation from strings disallowed for this context");
		}) as unknown as FunctionConstructor;
		try {
			expect(coerce(obj({ count: num() }), { count: "42" })).toEqual({ count: 42 });
		} finally {
			globalThis.Function = original;
		}
	});

	it("leaves values it cannot coerce for the check to report", () => {
		const validator = compile(obj({ count: num() }), { coerce: true });
		const coerced = validator.coerce({ count: "many" });
		expect(coerced).toEqual({ count: "many" });
		expect(validator.check(coerced)).toBe(false);
	});
});

describe("parse", () => {
	it("returns the coerced value when it is valid", () => {
		const validator = compile(obj({ count: num(), tags: arr(str()) }), { coerce: true });
		const result = validator.parse({ count: "42", tags: "a" });
		expect(result).toEqual({ ok: true, value: { count: 42, tags: ["a"] } });
		if (result.ok) expectTypeOf(result.value).toEqualTypeOf<{ count: number; tags: string[] }>();
	});

	it("returns the errors of the coerced value when it is invalid", () => {
		const validator = compile(obj({ count: num(), name: str() }), { coerce: true });
		expect(validator.parse({ count: "many", name: 7 })).toEqual({
			ok: false,
			errors: [{ path: "/count", keyword: "type", message: "expected number, got string" }],
		});
	});
});

describe("pass 1: optional nulls", () => {
	it("drops null in optional non-nullable properties, also nested", () => {
		const schema = obj(
			{
				path: str(),
				offset: opt(num()),
				nullable: opt(nullable(str())),
				metadata: obj({ enabled: opt({ type: "boolean" }) }),
			},
			{ open: true },
		);
		expect(coerce(schema, { path: "file.txt", offset: null, nullable: null, metadata: { enabled: null } })).toEqual({
			path: "file.txt",
			nullable: null,
			metadata: {},
		});
	});

	it("keeps a null whose property is a $ref (the reference may allow it)", () => {
		const schema = {
			type: "object",
			properties: { value: { $ref: "#/$defs/value" } },
			$defs: { value: { anyOf: [{ type: "number" }, { type: "null" }] } },
		};
		expect(coerce(schema, { value: null })).toEqual({ value: null });
	});

	it("walks array items", () => {
		const schema = { type: "array", items: obj({ a: str(), b: opt(int()) }) };
		expect(coerce(schema, [{ a: "x", b: null }])).toEqual([{ a: "x" }]);
	});
});

describe("pass 2: TypeBox's conversion rules on JSON Schema", () => {
	it("converts primitives by type", () => {
		expect(coerceValue({ type: "number" }, "42")).toBe(42);
		expect(coerceValue({ type: "number" }, "")).toBe(0);
		expect(coerceValue({ type: "number" }, "true")).toBe(1);
		expect(coerceValue({ type: "integer" }, "3.5")).toBe(3);
		expect(coerceValue({ type: "integer" }, 1.5)).toBe(1);
		expect(coerceValue({ type: "boolean" }, "1")).toBe(true);
		expect(coerceValue({ type: "boolean" }, "FALSE")).toBe(false);
		expect(coerceValue({ type: "null" }, "null")).toBe(null);
		expect(coerceValue({ type: "string" }, 42)).toBe("42");
	});

	it("wraps a single value into an array and converts the items", () => {
		expect(coerceValue({ type: "array", items: { type: "number" } }, "1")).toEqual([1]);
		expect(coerceValue({ type: "array", items: { type: "string" } }, null)).toEqual(["null"]);
	});

	it("converts tuple items in place and never wraps for a tuple", () => {
		const tuple = { type: "array", prefixItems: [{ type: "number" }, { type: "boolean" }], items: false };
		expect(coerceValue(tuple, ["1", "true"])).toEqual([1, true]);
		expect(coerceValue(tuple, "1")).toBe("1");
	});

	it("converts const and enum values only when the result is a member", () => {
		expect(coerceValue({ const: 1 }, "1")).toBe(1);
		expect(coerceValue({ const: 1 }, "2")).toBe("2");
		expect(coerceValue({ enum: [1, 2, "hello"] }, "2")).toBe(2);
		expect(coerceValue({ enum: [1, 2, "hello"] }, "world")).toBe("world");
	});

	it("keeps a value one union branch accepts, else takes the first branch whose conversion the union accepts", () => {
		const union = { anyOf: [{ type: "number" }, { type: "null" }] };
		expect(coerceValue(union, null)).toBe(null);
		expect(coerceValue(union, "42")).toBe(42);
		expect(coerceValue(union, "null")).toBe(null);
		expect(coerceValue({ oneOf: [{ type: "boolean" }, { type: "number" }] }, "1")).toBe(true);
	});

	it("converts allOf with each member in turn", () => {
		const schema = { allOf: [obj({ a: num() }, { open: true }), obj({ b: { type: "boolean" } }, { open: true })] };
		expect(coerce(schema, { a: "1", b: "true" })).toEqual({ a: 1, b: true });
	});

	it("follows $ref", () => {
		const schema = {
			type: "object",
			properties: { item: { $ref: "#/$defs/item" } },
			$defs: { item: { type: "object", properties: { id: { type: "integer" } } } },
		};
		expect(coerce(schema, { item: { id: "7" } })).toEqual({ item: { id: 7 } });
	});

	it("converts patternProperties and additionalProperties", () => {
		const schema = {
			type: "object",
			properties: { a: { type: "number" } },
			patternProperties: { "^n_": { type: "number" } },
			additionalProperties: { type: "boolean" },
		};
		expect(coerce(schema, { a: "1", n_x: "2", other: "true" })).toEqual({ a: 1, n_x: 2, other: true });
	});
});

describe("pass 3: primitive coercion by type", () => {
	it("coerces like Ajv's coerceTypes", () => {
		const cases: Array<[unknown, unknown, unknown]> = [
			[{ type: "number" }, true, 1],
			[{ type: "number" }, null, 0],
			[{ type: "integer" }, "42", 42],
			[{ type: "boolean" }, "true", true],
			[{ type: "boolean" }, 0, false],
			[{ type: "string" }, true, "true"],
			[{ type: "null" }, "", null],
			[{ type: "null" }, 0, null],
			[{ type: "null" }, false, null],
		];
		for (const [schema, input, expected] of cases) expect(coerceValue(schema, input)).toEqual(expected);
	});

	it("leaves a value that matches one of a type array's types, else takes the first coercible type", () => {
		expect(coerceValue({ type: ["number", "string"] }, "1")).toBe("1");
		expect(coerceValue({ type: ["boolean", "number"] }, "1")).toBe(1);
		expect(coerceValue({ type: ["integer", "null"] }, "5")).toBe(5);
	});

	it("accepts null for nullable array schemas with items", () => {
		expect(coerceValue({ type: ["array", "null"], items: { type: "string" } }, null)).toBe(null);
	});

	it("coerces nullable unions when the value matches no branch", () => {
		expect(coerceValue({ anyOf: [{ type: "number" }, { type: "null" }] }, "42")).toBe(42);
		expect(coerceValue({ oneOf: [{ type: "number" }, { type: "null" }] }, null)).toBe(null);
	});

	it("leaves values no rule coerces", () => {
		const validator = compile(
			{ type: "object", properties: { value: { type: "integer" } }, required: ["value"] },
			{ coerce: true },
		);
		for (const input of ["abc", "4x", {}, ["1", "2"]]) {
			const coerced = validator.coerce({ value: input });
			expect(validator.check(coerced)).toBe(false);
		}
	});
});

describe("where the passes conflict, the conversion rules win", () => {
	it("turns null into 'null' for a required string (pass 3 alone would give '')", () => {
		expect(coerceValue({ type: "string" }, null)).toBe("null");
	});

	it("turns '' into 0 for a number (pass 3 leaves an empty string)", () => {
		expect(coerceValue({ type: "number" }, "")).toBe(0);
	});

	it("turns '1' and '0' into booleans (pass 3 takes only 'true', 'false', 1 and 0)", () => {
		expect(coerceValue({ type: "boolean" }, "0")).toBe(false);
	});

	it("truncates '42.1' for an integer (pass 3 rejects it)", () => {
		expect(coerceValue({ type: "integer" }, "42.1")).toBe(42);
	});

	it("drops an optional null before converting it (pass 2 alone would give 'null')", () => {
		expect(coerce(obj({ name: opt(str()) }), { name: null })).toEqual({});
	});
});

describe("recursive schemas", () => {
	const tree = {
		type: "object",
		properties: { t: { $ref: "#/$defs/Tree" } },
		$defs: { Tree: { anyOf: [{ type: "string" }, { type: "array", items: { $ref: "#/$defs/Tree" } }] } },
	};
	const json = {
		type: "object",
		properties: { data: { $ref: "#/$defs/Json" } },
		required: ["data"],
		$defs: {
			Json: {
				anyOf: [
					{ type: "string" },
					{ type: "number" },
					{ type: "boolean" },
					{ type: "array", items: { $ref: "#/$defs/Json" } },
					{ type: "object", additionalProperties: { $ref: "#/$defs/Json" } },
				],
			},
		},
	};

	it("convert through a recursive union by its first accepting branch", () => {
		const validator = compile(tree, { coerce: true });
		expect(validator.parse({ t: ["a", ["b"]] })).toEqual({ ok: true, value: { t: ["a", ["b"]] } });
		expect(validator.parse({ t: 5 })).toEqual({ ok: true, value: { t: "5" } });
		expect(validator.parse({ t: [5] })).toEqual({ ok: true, value: { t: ["5"] } });
		expect(compile(json, { coerce: true }).parse({ data: { a: [1, null] } })).toEqual({
			ok: true,
			value: { data: { a: [1, "null"] } },
		});
	});

	it("leave a value a recursive schema cannot convert as it is, for the check to report", () => {
		const validator = compile(tree, { coerce: true });
		const result = validator.parse({ t: {} });
		expect(result.ok).toBe(false);
		expect(validator.coerce({ t: { a: 1 } })).toEqual({ t: { a: 1 } });
	});

	it("convert a scalar-or-array schema that refers to itself", () => {
		const schema = {
			type: "object",
			properties: {
				value: { anyOf: [{ type: "number" }, { type: "array", items: { $ref: "#/properties/value" } }] },
			},
			required: ["value"],
		};
		const validator = compile(schema, { coerce: true });
		expect(validator.parse({ value: "42" })).toEqual({ ok: true, value: { value: 42 } });
		expect(validator.parse({ value: ["1", ["2"]] })).toEqual({ ok: true, value: { value: [1, [2]] } });
		expect(validator.parse({ value: {} }).ok).toBe(false);
	});

	it("stop at a schema that cycles through shared JS objects instead of $ref", () => {
		const node: { anyOf: unknown[] } = { anyOf: [{ type: "number" }] };
		node.anyOf.push({ type: "array", items: node });
		const validator = compile(node, { coerce: true });
		expect(validator.parse("42")).toEqual({ ok: true, value: 42 });
		expect(validator.parse(["1", ["2"]])).toEqual({ ok: true, value: [1, [2]] });
		expect(validator.parse({}).ok).toBe(false);
	});

	it("reset the re-entry state between calls and leave the input unchanged", () => {
		const validator = compile(
			{ anyOf: [{ type: "number" }, { type: "array", items: { $ref: "#" } }] },
			{ coerce: true },
		);
		for (let i = 0; i < 20; i++) {
			expect(validator.parse({}).ok).toBe(false);
			expect(validator.parse("42")).toEqual({ ok: true, value: 42 });
			const input = [1, "2", ["3"]];
			expect(validator.parse(input)).toEqual({ ok: true, value: [1, 2, [3]] });
			expect(input).toEqual([1, "2", ["3"]]);
		}
	});

	it("convert and explain a deep value that every branch of a recursive union rejects, in linear time", () => {
		// Each object branch converts and explains every child: without memoizing per call this is 2^depth work.
		const S = {
			anyOf: [
				{ type: "object", additionalProperties: { $ref: "#/$defs/S" }, required: ["a"] },
				{ type: "object", additionalProperties: { $ref: "#/$defs/S" }, required: ["b"] },
			],
		};
		const validator = compile(
			{ type: "object", properties: { s: { $ref: "#/$defs/S" } }, $defs: { S } },
			{ coerce: true },
		);
		let value: unknown = { x: 1 };
		for (let i = 0; i < 40; i++) value = { c: value };
		const result = validator.parse({ s: value });
		expect(result.ok).toBe(false);
		const missing = Array.from({ length: 41 }, (_, i) => ({
			path: `/s${"/c".repeat(i)}/a`,
			keyword: "required",
			message: "missing",
		}));
		const leaf = { path: `/s${"/c".repeat(40)}/x`, keyword: "type", message: "expected object, got integer" };
		expect(result).toEqual({ ok: false, errors: [...missing, leaf] });
	});

	it("convert a TypeBox Cyclic union", () => {
		const Tree = Type.Cyclic({ Tree: Type.Union([Type.String(), Type.Array(Type.Ref("Tree"))]) }, "Tree");
		const validator = compile(Type.Object({ t: Tree }), { coerce: true });
		expect(validator.parse({ t: [5] })).toEqual({ ok: true, value: { t: ["5"] } });
		expect(validator.parse({ t: { a: 1 } }).ok).toBe(false);
	});
});

describe("member keywords across the passes", () => {
	it("keep a pattern-matched property from additionalProperties in every pass", () => {
		const record = Type.Record(Type.String(), Type.Number(), { additionalProperties: Type.String() });
		expect(compile(record, { coerce: true }).parse({ n1: "1" })).toEqual({ ok: true, value: { n1: 1 } });
		const plain = {
			type: "object",
			patternProperties: { "^n_": { type: ["integer", "null"] } },
			additionalProperties: { type: "string" },
		};
		expect(coerce(plain, { n_a: "5", other: 7 })).toEqual({ n_a: 5, other: "7" });
	});

	it("drop optional nulls inside declared, pattern and additional property values alike", () => {
		const item = obj({ n: opt(int({ minimum: 1 })) });
		const schemas = [
			obj({ entry: item }),
			map(item),
			{ type: "object", patternProperties: { "^entry$": item }, additionalProperties: false },
		];
		for (const schema of schemas) {
			const input = { entry: { n: null } };
			expect(compile(schema, { coerce: true }).parse(input)).toEqual({ ok: true, value: { entry: {} } });
			expect(input).toEqual({ entry: { n: null } });
		}
	});

	it("keep a null under pattern and additional properties: their keys are not optional properties", () => {
		const schema = { type: "object", additionalProperties: { type: ["integer", "null"] } };
		expect(compile(schema, { coerce: true }).parse({ n: null })).toEqual({ ok: true, value: { n: null } });
	});

	it("drop optional nulls in tuple items as in array items", () => {
		const item = obj({ n: opt(int()) });
		expect(compile(arr(item), { coerce: true }).coerce([{ n: null }])).toEqual([{}]);
		expect(compile(tuple([item]), { coerce: true }).coerce([{ n: null }])).toEqual([{}]);
	});

	it("coerce tuple items by type in pass 3", () => {
		const schema = { type: "array", prefixItems: [{ type: ["integer", "null"] }, { type: ["boolean", "null"] }] };
		expect(coerce(schema, ["5", "true"])).toEqual([5, true]);
	});

	it("convert the properties a union node declares besides its branches", () => {
		const schema = {
			type: "object",
			properties: { a: { type: "integer" }, b: { type: "integer" } },
			anyOf: [{ required: ["a"] }, { required: ["b"] }],
		};
		expect(compile(schema, { coerce: true }).parse({ a: "3.5" })).toEqual({ ok: true, value: { a: 3 } });
	});

	for (const keyword of ["anyOf", "oneOf"]) {
		it(`check ${keyword} candidates after the node's own properties convert`, () => {
			const schema = {
				type: "object",
				[keyword]: [
					{ type: "object", properties: { a: { type: "array", items: { type: "integer" } } }, required: ["a"] },
					{ type: "object", properties: { b: { type: "boolean" } }, required: ["b"] },
				],
				properties: { c: { type: "integer" } },
				required: ["c"],
			};
			const input = { a: "3", c: "2" };
			expect(compile(schema, { coerce: true }).parse(input)).toEqual({ ok: true, value: { a: [3], c: 2 } });
			expect(input).toEqual({ a: "3", c: "2" });
		});
	}
});

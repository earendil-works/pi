// Tests of schema snapshots: the vocabulary, closed arguments, copies and their normal forms, bytes leaves.

import { compile } from "@earendil-works/pi-schema";
import { describe, expect, it } from "vitest";
import { arr, bytes, int, map, obj, opt, str, union } from "../../../src/next/contracts/schema.ts";
import { snapshotArguments, snapshotSchema } from "../../../src/next/contracts/snapshot.ts";

describe("vocabulary", () => {
	it("accepts primitives, arrays, tuples, objects, records, unions, intersections, $defs/$ref, constraints", () => {
		const recursive = {
			$defs: {
				Node: {
					type: "object",
					properties: { value: { type: "number" }, next: { anyOf: [{ type: "null" }, { $ref: "#/$defs/Node" }] } },
					required: ["value", "next"],
				},
			},
			$ref: "#/$defs/Node",
		};
		const schemas = [
			{ type: "array", prefixItems: [{ type: "string" }, { type: "integer" }], items: false },
			{ allOf: [obj({ a: str() }), obj({ b: str() })] },
			{ enum: ["a", "b"] },
			recursive,
			str({ min: 1, pattern: "^x" }),
			{ type: "string", format: "email", default: "a@b.c", readOnly: true, title: "t", description: "d" },
			{ type: "number", multipleOf: 2, exclusiveMinimum: 0 },
			{ type: "array", items: { type: "string" }, uniqueItems: true },
			{ type: "object", minProperties: 1, maxProperties: 2, $comment: "c", deprecated: true, examples: [{}] },
			map(int()),
			bytes({ max: 4 }),
			map(bytes()),
		];
		for (const schema of schemas) expect(() => snapshotSchema(schema, "s")).not.toThrow();
	});

	it.each([
		["conditional", { if: { type: "string" }, else: { minLength: 1 } }, 'unsupported keyword "else"'],
		["dependent", { type: "object", dependentSchemas: { a: {} } }, 'unsupported keyword "dependentSchemas"'],
		[
			"dependentRequired",
			{ type: "object", dependentRequired: { a: ["b"] } },
			'unsupported keyword "dependentRequired"',
		],
		["not", { not: { type: "string" } }, 'unsupported keyword "not"'],
		["contains", { type: "array", contains: { type: "string" } }, 'unsupported keyword "contains"'],
		["propertyNames", { type: "object", propertyNames: { pattern: "^a" } }, 'unsupported keyword "propertyNames"'],
		["unevaluatedProperties", { unevaluatedProperties: false }, 'unsupported keyword "unevaluatedProperties"'],
		["unevaluatedItems", { unevaluatedItems: false }, 'unsupported keyword "unevaluatedItems"'],
		["contentSchema", { type: "string", contentSchema: {} }, 'unsupported keyword "contentSchema"'],
		["definitions", { definitions: {} }, 'unsupported keyword "definitions"'],
		["oneOf", { oneOf: [{ type: "string" }] }, 'unsupported keyword "oneOf"'],
		["unknown keyword", { type: "string", flavour: "x" }, 'unsupported keyword "flavour"'],
		["non-JSON type", { type: "bigint" }, 'unsupported type "bigint"'],
		["undefined", { type: "undefined" }, 'unsupported type "undefined"'],
		["function", { type: "function", parameters: [], returnType: { type: "null" } }, "s: unsupported"],
		[
			"non-enumerable key (a TypeBox refinement)",
			Object.defineProperty({ type: "string" }, "~refine", { value: [{ check: () => true }] }),
			"s.~refine: non-enumerable keys are not supported",
		],
		["opt(...) outside an object", opt(str()), "s: expected a schema"],
		["non-JSON data", { type: "number", default: Number.NaN }, "s.default: expected JSON data"],
		["undefined data", { type: "number", maximum: undefined }, "s.maximum: expected JSON data"],
		["foreign prototype", new (class Schema {})(), "s: expected a schema"],
		["array as schema", [], "s: expected a schema"],
	])("refuses %s", (_name, schema, message) => {
		expect(() => snapshotSchema(schema, "s")).toThrow(message);
	});

	it("refuses symbol keys, accessors and cycles, naming the path", () => {
		expect(() => snapshotSchema({ type: "string", [Symbol("x")]: 1 }, "s")).toThrow(
			"s: symbol keys are not supported",
		);
		const accessor = Object.defineProperty({ type: "object" }, "properties", { get: () => ({}), enumerable: true });
		expect(() => snapshotSchema(accessor, "s")).toThrow("s.properties: accessors are not supported");
		const cyclic: { type: string; items?: object } = { type: "array" };
		cyclic.items = cyclic;
		expect(() => snapshotSchema(cyclic, "s")).toThrow("s.items: cyclic schema");
		expect(() => snapshotSchema({ type: "object", properties: { a: { type: 1 } } }, "s")).toThrow(
			"s.properties.a.type: unsupported type 1",
		);
	});

	it("allows a schema object shared by two places (not a cycle)", () => {
		const shared = str();
		expect(() => snapshotSchema(obj({ a: shared, b: shared }), "s")).not.toThrow();
	});
});

describe("closed arguments", () => {
	it("requires every object, nested ones included, to be closed", () => {
		expect(() => snapshotArguments(obj({ a: obj({ b: str() }) }), "m.args")).not.toThrow();
		const open = (properties: object) => ({ type: "object", properties });
		expect(() => snapshotArguments(obj({ a: open({ b: str() }) }), "m.args")).toThrow(
			"m.args.properties.a: argument objects must be closed (additionalProperties: false)",
		);
		expect(() => snapshotArguments(open({}), "m.args")).toThrow("m.args: argument objects must be closed");
		expect(() => snapshotArguments(obj({ list: arr(open({})) }), "m.args")).toThrow(
			"m.args.properties.list.items: argument objects must be closed",
		);
		expect(() => snapshotArguments({ type: "object" }, "m.args")).toThrow("argument objects must be closed");
	});

	it("accepts a raw closed object schema and records", () => {
		const closed = { type: "object", properties: { a: str() }, additionalProperties: false };
		expect(() => snapshotArguments(closed, "m")).not.toThrow();
		expect(() => snapshotArguments(obj({ tags: map(str()) }), "m")).not.toThrow();
	});

	it("checks objects inside $defs, unions and tuples", () => {
		const open = { type: "object", properties: { a: str() } };
		expect(() => snapshotArguments(union([open, str()]), "m")).toThrow("m.anyOf[0]: argument objects");
		expect(() => snapshotArguments({ type: "array", items: [open] }, "m")).toThrow("m.items[0]: argument objects");
		expect(() => snapshotArguments({ $defs: { A: open }, $ref: "A" }, "m")).toThrow("m.$defs.A: argument objects");
	});

	it("does not apply to state or results", () => {
		expect(() => snapshotSchema({ type: "object", properties: { a: str() } }, "state")).not.toThrow();
	});
});

describe("snapshots", () => {
	it("are copies, independent of later changes to the app's schema objects", () => {
		const app = obj({ text: str(), tags: arr(str()) }) as { properties: { text: object }; required: string[] };
		const { schema } = snapshotSchema(app, "s");
		(app.properties.text as { minLength?: number }).minLength = 5;
		app.required.push("x");
		expect(schema).not.toBe(app);
		expect(compile(schema).check({ text: "", tags: [] })).toBe(true);
	});

	it("copy data values (defaults, consts)", () => {
		const fallback = { a: [1] };
		const { schema } = snapshotSchema({ type: "object", default: fallback, additionalProperties: false }, "s");
		fallback.a.push(2);
		const copied = (schema as { default: { a: number[] } }).default;
		expect(copied).toEqual({ a: [1] });
	});

	it("copy a bytes leaf as data: the compiled check comes from its keywords", () => {
		const { schema } = snapshotSchema(bytes({ max: 2 }), "s");
		expect(schema).toEqual({ type: "bytes", maxLength: 2 });
		expect(compile(schema).check(new Uint8Array(2))).toBe(true);
		expect(compile(schema).check(new Uint8Array(3))).toBe(false);
		// A record of bytes (slices.md L1 carry-over: refused while bytes carried a TypeBox refinement).
		const record = snapshotSchema(map(bytes({ min: 1 })), "s").schema;
		expect(compile(record).check({ a: new Uint8Array(1) })).toBe(true);
		expect(compile(record).check({ a: new Uint8Array(0) })).toBe(false);
	});

	it("refuse a bytes marker with other keywords or bad bounds", () => {
		expect(() => snapshotSchema({ type: "bytes", items: {} }, "s")).toThrow('s: unsupported keyword "items"');
		expect(() => snapshotSchema({ type: "bytes", maxLength: -1 }, "s")).toThrow(
			"s: bytes bounds must be non-negative integers",
		);
	});

	it("normal form: sorted keys, sorted required and enum, annotations dropped on schema nodes only", () => {
		const { normal } = snapshotSchema(
			{
				title: "T",
				type: "object",
				required: ["b", "a"],
				properties: { b: { enum: ["y", "x"] }, a: { type: "string", default: { title: "kept", z: 1, a: 2 } } },
				additionalProperties: false,
			},
			"s",
		);
		expect(JSON.stringify(normal)).toBe(
			JSON.stringify({
				additionalProperties: false,
				properties: { a: { default: { a: 2, title: "kept", z: 1 }, type: "string" }, b: { enum: ["x", "y"] } },
				required: ["a", "b"],
				type: "object",
			}),
		);
	});

	it("normal form keeps union and tuple order", () => {
		const ab = snapshotSchema(union([str(), int()]), "s").normal;
		const ba = snapshotSchema(union([int(), str()]), "s").normal;
		expect(ab).not.toEqual(ba);
	});
});

describe("bytes", () => {
	it("mark a snapshot with a bytes leaf anywhere inside", () => {
		expect(snapshotSchema(str(), "s").bytes).toBe(false);
		expect(snapshotSchema(obj({ a: arr(obj({ b: bytes() })) }), "s").bytes).toBe(true);
		expect(snapshotSchema(union([str(), bytes()]), "s").bytes).toBe(true);
		expect(snapshotSchema({ type: "object", default: { type: "bytes" } }, "s").bytes).toBe(false);
	});
});

// The reviewers' probes of the schema switch (round 1) as regression tests: TypeBox-built and plain JSON
// (MCP-shaped) tool schemas with arguments through validateToolArguments. Each case's outcome is "ok <coerced
// arguments>", "REJECT <first error line>" or "THROW <message>". Cases marked as TypeBox-only record the documented
// differences from TypeBox (see the CHANGELOG): Refine and BigInt.

// biome-ignore-all lint/suspicious/noTemplateCurlyInString: TypeBox template literal syntax.
// biome-ignore-all lint/suspicious/noThenProperty: JSON Schema's `then` keyword.
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import type { Tool, ToolCall } from "../src/types.ts";
import { validateToolArguments } from "../src/utils/validation.ts";

/** The outcome of one call, in the probes' format. */
function outcome(name: string, schema: object, args: unknown): string {
	const tool = { name, description: "", parameters: schema } as Tool;
	const call = { type: "toolCall", id: "1", name, arguments: args } as ToolCall;
	try {
		return `ok ${JSON.stringify(validateToolArguments(tool, call), (_key, value) => (typeof value === "bigint" ? `${value}n` : value))}`;
	} catch (error) {
		const message = (error as Error).message;
		return message.startsWith("Validation failed")
			? `REJECT ${message.split("\n")[1]?.trim()}`
			: `THROW ${message.split("\n")[0]}`;
	}
}

type Case = { name: string; schema: object; args: unknown[] };

const Node = Type.Cyclic(
	{ Node: Type.Object({ name: Type.String(), children: Type.Array(Type.Ref("Node")) }) },
	"Node",
);

const cases: Case[] = [
	{
		name: "cyclic",
		schema: Type.Object({ tree: Node }),
		args: [{ tree: { name: "a", children: [{ name: "b", children: [] }] } }, { tree: { name: 1, children: [] } }],
	},
	{ name: "ref-with-$id", schema: Type.Object({ a: Type.Ref("A") }), args: [{ a: { x: "1" } }] },
	{
		name: "function",
		schema: Type.Object({ f: Type.Optional(Type.Function([], Type.Void())) }),
		args: [{}, { f: "x" }],
	},
	{
		name: "codec",
		schema: Type.Object({
			c: Type.Codec(Type.String())
				.Decode((s) => Number(s))
				.Encode((n) => String(n)),
		}),
		args: [{ c: "12" }, { c: 12 }],
	},
	{ name: "undefined-optional", schema: Type.Object({ u: Type.Optional(Type.Undefined()) }), args: [{}, { u: null }] },
	{ name: "bigint", schema: Type.Object({ n: Type.BigInt() }), args: [{ n: 1 }, { n: "12" }] },
	{
		name: "refine",
		schema: Type.Object({ n: Type.Refine(Type.Number(), (v) => v > 0) }),
		args: [{ n: 5 }, { n: -5 }],
	},
	{
		name: "template-literal",
		schema: Type.Object({ t: Type.TemplateLiteral("id-${number}") }),
		args: [{ t: "id-12" }, { t: "id-x" }, { t: 3 }],
	},
	{
		name: "record-string",
		schema: Type.Object({ r: Type.Record(Type.String(), Type.Number()) }),
		args: [{ r: { a: "1" } }, { r: { a: 1, b: "x" } }],
	},
	{
		name: "record-literal-keys",
		schema: Type.Object({ r: Type.Record(Type.Union([Type.Literal("a"), Type.Literal("b")]), Type.Number()) }),
		args: [{ r: { a: 1, b: 2 } }, { r: { a: 1 } }, { r: { a: 1, b: 2, c: 3 } }],
	},
	{
		name: "intersect",
		schema: Type.Intersect([Type.Object({ a: Type.Number() }), Type.Object({ b: Type.Boolean() })]),
		args: [
			{ a: "1", b: "true" },
			{ a: 1, b: true, c: 1 },
		],
	},
	{
		name: "union-objects",
		schema: Type.Object({
			v: Type.Union([
				Type.Object({ k: Type.Literal("x"), n: Type.Number() }),
				Type.Object({ k: Type.Literal("y"), s: Type.String() }),
			]),
		}),
		args: [{ v: { k: "x", n: "2" } }, { v: { k: "y", s: 2 } }],
	},
	{ name: "minLength-astral", schema: Type.Object({ s: Type.String({ minLength: 2 }) }), args: [{ s: "😀" }] },
	{ name: "maxLength-astral", schema: Type.Object({ s: Type.String({ maxLength: 1 }) }), args: [{ s: "😀" }] },
	{ name: "pattern-astral", schema: Type.Object({ s: Type.String({ pattern: "^.$" }) }), args: [{ s: "😀" }] },
	{
		name: "pattern-class-dash",
		schema: Type.Object({ s: Type.String({ pattern: "^[\\w-]+$" }) }),
		args: [{ s: "a-b" }],
	},
	{
		name: "pattern-unicode-prop",
		schema: Type.Object({ s: Type.String({ pattern: "^\\p{L}+$" }) }),
		args: [{ s: "äb" }, { s: "p{L}" }],
	},
	{
		name: "multipleOf-float",
		schema: Type.Object({ n: Type.Number({ multipleOf: 0.01 }) }),
		args: [{ n: 0.07 }, { n: 1.1 }],
	},
	{
		name: "uniqueItems-keyorder",
		schema: Type.Object({ a: Type.Array(Type.Unknown(), { uniqueItems: true }) }),
		args: [
			{
				a: [
					{ x: 1, y: 2 },
					{ y: 2, x: 1 },
				],
			},
			{ a: [1, 1.0] },
		],
	},
	{ name: "const-object", schema: Type.Object({ c: Type.Literal("a") }), args: [{ c: "a" }] },
	{
		name: "formats",
		schema: Type.Object({
			e: Type.Optional(Type.String({ format: "email" })),
			u: Type.Optional(Type.String({ format: "uri" })),
			d: Type.Optional(Type.String({ format: "date-time" })),
			x: Type.Optional(Type.String({ format: "made-up" })),
			h: Type.Optional(Type.String({ format: "hostname" })),
			r: Type.Optional(Type.String({ format: "regex" })),
			i: Type.Optional(Type.String({ format: "uuid" })),
			ip: Type.Optional(Type.String({ format: "ipv4" })),
		}),
		args: [
			{ e: "a@b.co" },
			{ e: "not-an-email" },
			{ u: "relative/path" },
			{ u: "https://x.y/z" },
			{ d: "2024-01-01T00:00:00Z" },
			{ d: "2024-01-01" },
			{ x: "anything" },
			{ h: "under_score.example" },
			{ r: "[" },
			{ i: "00000000-0000-0000-0000-000000000000" },
			{ i: "not" },
			{ ip: "999.1.1.1" },
		],
	},
	{ name: "integer-big", schema: Type.Object({ n: Type.Integer() }), args: [{ n: 1e21 }, { n: 2 ** 53 + 2 }] },
	{
		name: "additional-false",
		schema: Type.Object({ a: Type.String() }, { additionalProperties: false }),
		args: [{ a: "x", b: 1 }],
	},
	{
		name: "prototype-key",
		schema: Type.Object({ constructor: Type.Optional(Type.String()), toString: Type.Optional(Type.Number()) }),
		args: [{}, { constructor: 1 }],
	},
	{
		name: "proto-key-value",
		schema: Type.Object({}, { additionalProperties: Type.Array(Type.String()) }),
		args: [JSON.parse('{"__proto__": "x", "a": "y"}')],
	},
	// Plain JSON (MCP-shaped)
	{
		name: "mcp-draft7-ref-definitions",
		schema: {
			$schema: "http://json-schema.org/draft-07/schema#",
			type: "object",
			properties: { t: { $ref: "#/definitions/T" } },
			required: ["t"],
			definitions: { T: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } },
		},
		args: [{ t: { path: "a" } }, { t: { path: 42 } }],
	},
	{
		name: "mcp-ref-unresolved",
		schema: { type: "object", properties: { t: { $ref: "#/definitions/Missing" } } },
		args: [{ t: 1 }, {}],
	},
	{
		name: "mcp-ref-external",
		schema: { type: "object", properties: { t: { $ref: "https://example.com/schemas/t.json" } } },
		args: [{ t: 1 }],
	},
	{
		name: "mcp-nullable-openapi",
		schema: { type: "object", properties: { s: { type: "string", nullable: true } }, required: ["s"] },
		args: [{ s: null }, { s: "x" }],
	},
	{
		name: "mcp-draft7-tuple",
		schema: {
			$schema: "http://json-schema.org/draft-07/schema#",
			type: "object",
			properties: { p: { type: "array", items: [{ type: "number" }, { type: "string" }], additionalItems: false } },
		},
		args: [{ p: [1, "a"] }, { p: [1, "a", 3] }, { p: ["1", 2] }],
	},
	{
		name: "mcp-draft7-ref-sibling",
		schema: {
			$schema: "http://json-schema.org/draft-07/schema#",
			type: "object",
			properties: { s: { $ref: "#/definitions/S", maxLength: 1 } },
			definitions: { S: { type: "string" } },
		},
		args: [{ s: "abc" }],
	},
	{
		name: "mcp-draft4-exclusive-bool",
		schema: {
			$schema: "http://json-schema.org/draft-04/schema#",
			type: "object",
			properties: { n: { type: "number", minimum: 0, exclusiveMinimum: true } },
		},
		args: [{ n: 0 }, { n: 1 }],
	},
	{
		name: "mcp-id-draft4",
		schema: {
			$schema: "http://json-schema.org/draft-04/schema#",
			id: "http://x/y",
			type: "object",
			properties: { a: { type: "string" } },
		},
		args: [{ a: "x" }],
	},
	{
		name: "mcp-bad-pattern",
		schema: { type: "object", properties: { s: { type: "string", pattern: "(?<!x)y" } } },
		args: [{ s: "y" }],
	},
	{
		name: "mcp-invalid-regex",
		schema: { type: "object", properties: { s: { type: "string", pattern: "[" } } },
		args: [{ s: "y" }],
	},
	{
		name: "mcp-type-integer-float-0",
		schema: { type: "object", properties: { n: { type: "integer" } } },
		args: [{ n: 1.0 }, { n: 1.5 }],
	},
	{
		name: "mcp-format-unknown",
		schema: { type: "object", properties: { s: { type: "string", format: "binary" } } },
		args: [{ s: "xx" }],
	},
	{
		name: "mcp-required-null-string",
		schema: { type: "object", properties: { q: { type: "string" } }, required: ["q"] },
		args: [{ q: null }],
	},
	{
		name: "mcp-array-json-string",
		schema: { type: "object", properties: { p: { type: "array", items: { type: "string" } } }, required: ["p"] },
		args: [{ p: '["a","b"]' }],
	},
	{
		name: "mcp-integer-float",
		schema: { type: "object", properties: { n: { type: "integer" } }, required: ["n"] },
		args: [{ n: 3.7 }, { n: "3.7" }],
	},
	{ name: "mcp-empty-schema", schema: {}, args: [{ a: 1 }] },
	{ name: "mcp-type-object-no-props", schema: { type: "object" }, args: [{ a: 1 }] },
	{
		name: "mcp-boolean-true-prop",
		schema: { type: "object", properties: { a: true, b: false } },
		args: [{ a: 1 }, { b: 1 }],
	},
	{
		name: "mcp-huge-enum",
		schema: {
			type: "object",
			properties: { e: { type: "string", enum: Array.from({ length: 5000 }, (_, i) => `v${i}`) } },
		},
		args: [{ e: "v4999" }, { e: "v5000" }],
	},
];

const o = (properties: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
	type: "object",
	properties,
	...extra,
});
const keywordCases: [string, object, unknown[]][] = [
	[
		"oneOf-overlap",
		o({ v: { oneOf: [{ type: "string" }, { type: "string", maxLength: 5 }] } }),
		[{ v: "abc" }, { v: "abcdefgh" }],
	],
	["oneOf-number-integer", o({ v: { oneOf: [{ type: "number" }, { type: "integer" }] } }), [{ v: 2 }, { v: 2.5 }]],
	[
		"oneOf-objects-open",
		o({
			v: {
				oneOf: [
					{ type: "object", properties: { a: { type: "string" } } },
					{ type: "object", properties: { b: { type: "string" } } },
				],
			},
		}),
		[{ v: { a: "x" } }, { v: {} }],
	],
	[
		"if-then-else",
		o(
			{ kind: { type: "string" }, n: { type: "number" } },
			{ if: { properties: { kind: { const: "a" } } }, then: { required: ["n"] } },
		),
		[{ kind: "a" }, { kind: "b" }],
	],
	[
		"dependentRequired",
		o({ a: { type: "string" }, b: { type: "string" } }, { dependentRequired: { a: ["b"] } }),
		[{ a: "x" }],
	],
	[
		"dependencies-d7",
		o({ a: { type: "string" }, b: { type: "string" } }, { dependencies: { a: ["b"] } }),
		[{ a: "x" }],
	],
	["propertyNames", o({}, { propertyNames: { pattern: "^[a-z]+$" } }), [{ abc: 1 }, { ABC: 1 }]],
	["contains", o({ l: { type: "array", contains: { type: "number" } } }), [{ l: ["a"] }, { l: ["a", 1] }]],
	["not", o({ s: { not: { type: "null" } } }), [{ s: "x" }, { s: null }]],
	["minProperties", o({ m: { type: "object", minProperties: 1 } }), [{ m: {} }]],
	[
		"unevaluatedProperties",
		o({ a: { type: "string" } }, { unevaluatedProperties: false }),
		[{ a: "x" }, { a: "x", b: 1 }],
	],
	[
		"allOf-additional-false",
		{ allOf: [o({ a: { type: "string" } }, { additionalProperties: false }), o({ b: { type: "string" } })] },
		[{ a: "x" }, { a: "x", b: "y" }],
	],
	["const-object", o({ c: { const: { x: 1, y: 2 } } }), [{ c: { y: 2, x: 1 } }]],
	["enum-object", o({ e: { enum: [{ x: 1, y: 2 }] } }), [{ e: { y: 2, x: 1 } }]],
	["type-array-multi", o({ v: { type: ["string", "number"] } }), [{ v: true }, { v: null }]],
	["nullable-type-array", o({ v: { type: ["string", "null"] } }, { required: ["v"] }), [{ v: null }, { v: 5 }]],
	["exclusiveMinimum-number", o({ n: { type: "number", exclusiveMinimum: 0 } }), [{ n: 0 }, { n: "0" }]],
	["maxItems", o({ l: { type: "array", maxItems: 1 } }), [{ l: [1, 2] }, { l: "x" }]],
	[
		"discriminator-openapi",
		o({
			p: {
				oneOf: [
					o({ kind: { type: "string", enum: ["a"] }, x: { type: "number" } }, { required: ["kind"] }),
					o({ kind: { type: "string", enum: ["b"] } }, { required: ["kind"] }),
				],
				discriminator: { propertyName: "kind" },
			},
		}),
		[{ p: { kind: "a", x: "1" } }, { p: { kind: "b" } }],
	],
	[
		"ref-root-defs",
		{ $ref: "#/$defs/Root", $defs: { Root: o({ a: { type: "string" } }, { required: ["a"] }) } },
		[{ a: "x" }, { a: 1 }, {}],
	],
	[
		"ref-recursive",
		{
			$defs: { N: o({ c: { type: "array", items: { $ref: "#/$defs/N" } }, v: { type: "integer" } }) },
			...o({ root: { $ref: "#/$defs/N" } }),
		},
		[{ root: { v: "2", c: [{ v: "3", c: [] }] } }],
	],
	[
		"ref-percent",
		{ ...o({ a: { $ref: "#/$defs/a%20b" } }), $defs: { "a b": { type: "string" } } },
		[{ a: "x" }, { a: 1 }],
	],
	["ref-tilde", { ...o({ a: { $ref: "#/$defs/a~1b" } }), $defs: { "a/b": { type: "string" } } }, [{ a: "x" }]],
	[
		"defs-with-$id",
		{ ...o({ a: { $ref: "item.json" } }), $defs: { item: { $id: "item.json", type: "string" } } },
		[{ a: "x" }, { a: 2 }],
	],
	[
		"anyOf-null-default",
		o({ v: { anyOf: [{ type: "string" }, { type: "null" }], default: null } }),
		[{ v: null }, {}],
	],
	[
		"format-date-time-lower",
		o({ d: { type: "string", format: "date-time" } }),
		[{ d: "2024-01-01t00:00:00z" }, { d: "2024-01-01 00:00:00Z" }],
	],
	["format-url", o({ u: { type: "string", format: "url" } }), [{ u: "not a url" }]],
	["integer-as-float-1e0", o({ n: { type: "integer" } }), [{ n: 1e3 }]],
	["required-missing-props", { type: "object", required: ["a"] }, [{}, { a: null }]],
	["string-to-number-trim", o({ n: { type: "number" } }), [{ n: " 12 " }, { n: "0x10" }, { n: "1e3" }, { n: "" }]],
];

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
const filter = {
	type: "object",
	properties: { where: { $ref: "#/$defs/F" } },
	$defs: {
		F: {
			oneOf: [
				{
					type: "object",
					properties: { field: { type: "string" }, eq: { type: "string" } },
					required: ["field", "eq"],
					additionalProperties: false,
				},
				{
					type: "object",
					properties: { and: { type: "array", items: { $ref: "#/$defs/F" } } },
					required: ["and"],
					additionalProperties: false,
				},
			],
		},
	},
};
const recursionCases: [string, object, unknown][] = [
	["tree valid", tree, { t: ["a", ["b"]] }],
	["tree number", tree, { t: 5 }],
	["tree [5]", tree, { t: [5] }],
	["json valid", json, { data: { a: [1, "x", { b: true }] } }],
	["json null", json, { data: null }],
	["json nested null", json, { data: { a: [1, null] } }],
	["filter valid", filter, { where: { and: [{ field: "a", eq: "b" }] } }],
	["filter bad leaf", filter, { where: { and: [{ field: "a", eq: 1, x: 2 }] } }],
	["filter deep bad", filter, { where: { and: [{ and: [{ and: [{ and: [{ and: [{ field: 1 }] }] }] }] }] } }],
];

const expected: Record<string, string> = {
	'cyclic {"tree":{"name":"a","children":[{"name":"b","children":[]}]}}':
		'ok {"tree":{"name":"a","children":[{"name":"b","children":[]}]}}',
	'cyclic {"tree":{"name":1,"children":[]}}': 'ok {"tree":{"name":"1","children":[]}}',
	'ref-with-$id {"a":{"x":"1"}}': "REJECT - a: unresolved reference A",
	"function {}": "ok {}",
	'function {"f":"x"}': "REJECT - f: expected function, got string",
	'codec {"c":"12"}': 'ok {"c":"12"}',
	'codec {"c":12}': 'ok {"c":"12"}',
	"undefined-optional {}": "ok {}",
	'undefined-optional {"u":null}': "ok {}",
	'bigint {"n":1}': "REJECT - n: expected bigint, got integer",
	'bigint {"n":"12"}': "REJECT - n: expected bigint, got string",
	'refine {"n":5}': 'ok {"n":5}',
	'refine {"n":-5}': 'ok {"n":-5}',
	'template-literal {"t":"id-12"}': 'ok {"t":"id-12"}',
	'template-literal {"t":"id-x"}': "REJECT - t: expected to match ^id--?(?:0|[1-9][0-9]*)(?:\\.[0-9]+)?$",
	'template-literal {"t":3}': "REJECT - t: expected to match ^id--?(?:0|[1-9][0-9]*)(?:\\.[0-9]+)?$",
	'record-string {"r":{"a":"1"}}': 'ok {"r":{"a":1}}',
	'record-string {"r":{"a":1,"b":"x"}}': "REJECT - r.b: expected number, got string",
	'record-literal-keys {"r":{"a":1,"b":2}}': 'ok {"r":{"a":1,"b":2}}',
	'record-literal-keys {"r":{"a":1}}': "REJECT - r.b: missing",
	'record-literal-keys {"r":{"a":1,"b":2,"c":3}}': 'ok {"r":{"a":1,"b":2,"c":3}}',
	'intersect {"a":"1","b":"true"}': 'ok {"a":1,"b":true}',
	'intersect {"a":1,"b":true,"c":1}': 'ok {"a":1,"b":true,"c":1}',
	'union-objects {"v":{"k":"x","n":"2"}}': 'ok {"v":{"k":"x","n":2}}',
	'union-objects {"v":{"k":"y","s":2}}': 'ok {"v":{"k":"y","s":"2"}}',
	'minLength-astral {"s":"😀"}': "REJECT - s: expected at least 2 characters",
	'maxLength-astral {"s":"😀"}': 'ok {"s":"😀"}',
	'pattern-astral {"s":"😀"}': 'ok {"s":"😀"}',
	'pattern-class-dash {"s":"a-b"}': 'ok {"s":"a-b"}',
	'pattern-unicode-prop {"s":"äb"}': 'ok {"s":"äb"}',
	'pattern-unicode-prop {"s":"p{L}"}': "REJECT - s: expected to match ^\\p{L}+$",
	'multipleOf-float {"n":0.07}': 'ok {"n":0.07}',
	'multipleOf-float {"n":1.1}': 'ok {"n":1.1}',
	'uniqueItems-keyorder {"a":[{"x":1,"y":2},{"y":2,"x":1}]}': "REJECT - a: expected unique items",
	'uniqueItems-keyorder {"a":[1,1]}': "REJECT - a: expected unique items",
	'const-object {"c":"a"}': 'ok {"c":"a"}',
	'formats {"e":"a@b.co"}': 'ok {"e":"a@b.co"}',
	'formats {"e":"not-an-email"}': "REJECT - e: expected format email",
	'formats {"u":"relative/path"}': "REJECT - u: expected format uri",
	'formats {"u":"https://x.y/z"}': 'ok {"u":"https://x.y/z"}',
	'formats {"d":"2024-01-01T00:00:00Z"}': 'ok {"d":"2024-01-01T00:00:00Z"}',
	'formats {"d":"2024-01-01"}': "REJECT - d: expected format date-time",
	'formats {"x":"anything"}': 'ok {"x":"anything"}',
	'formats {"h":"under_score.example"}': "REJECT - h: expected format hostname",
	'formats {"r":"["}': "REJECT - r: expected format regex",
	'formats {"i":"00000000-0000-0000-0000-000000000000"}': 'ok {"i":"00000000-0000-0000-0000-000000000000"}',
	'formats {"i":"not"}': "REJECT - i: expected format uuid",
	'formats {"ip":"999.1.1.1"}': "REJECT - ip: expected format ipv4",
	'integer-big {"n":1e+21}': 'ok {"n":1e+21}',
	'integer-big {"n":9007199254740994}': 'ok {"n":9007199254740994}',
	'additional-false {"a":"x","b":1}': "REJECT - b: unknown field",
	"prototype-key {}": "ok {}",
	'prototype-key {"constructor":1}': 'ok {"constructor":"1"}',
	'proto-key-value {"__proto__":"x","a":"y"}': 'ok {"__proto__":["x"],"a":["y"]}',
	'mcp-draft7-ref-definitions {"t":{"path":"a"}}': 'ok {"t":{"path":"a"}}',
	'mcp-draft7-ref-definitions {"t":{"path":42}}': 'ok {"t":{"path":"42"}}',
	'mcp-ref-unresolved {"t":1}': "REJECT - t: unresolved reference #/definitions/Missing",
	"mcp-ref-unresolved {}": "ok {}",
	'mcp-ref-external {"t":1}': "REJECT - t: unresolved reference https://example.com/schemas/t.json",
	'mcp-nullable-openapi {"s":null}': 'ok {"s":"null"}',
	'mcp-nullable-openapi {"s":"x"}': 'ok {"s":"x"}',
	'mcp-draft7-tuple {"p":[1,"a"]}': 'ok {"p":[1,"a"]}',
	'mcp-draft7-tuple {"p":[1,"a",3]}': "REJECT - p.2: no value is allowed here",
	'mcp-draft7-tuple {"p":["1",2]}': 'ok {"p":[1,"2"]}',
	'mcp-draft7-ref-sibling {"s":"abc"}': "REJECT - s: expected at most 1 characters",
	'mcp-draft4-exclusive-bool {"n":0}': 'ok {"n":0}',
	'mcp-draft4-exclusive-bool {"n":1}': 'ok {"n":1}',
	'mcp-id-draft4 {"a":"x"}': 'ok {"a":"x"}',
	'mcp-bad-pattern {"s":"y"}': 'ok {"s":"y"}',
	'mcp-invalid-regex {"s":"y"}': "THROW Invalid regular expression: /[/: Unterminated character class",
	'mcp-type-integer-float-0 {"n":1}': 'ok {"n":1}',
	'mcp-type-integer-float-0 {"n":1.5}': 'ok {"n":1}',
	'mcp-format-unknown {"s":"xx"}': 'ok {"s":"xx"}',
	'mcp-required-null-string {"q":null}': 'ok {"q":"null"}',
	'mcp-array-json-string {"p":"[\\"a\\",\\"b\\"]"}': 'ok {"p":["[\\"a\\",\\"b\\"]"]}',
	'mcp-integer-float {"n":3.7}': 'ok {"n":3}',
	'mcp-integer-float {"n":"3.7"}': 'ok {"n":3}',
	'mcp-empty-schema {"a":1}': 'ok {"a":1}',
	'mcp-type-object-no-props {"a":1}': 'ok {"a":1}',
	'mcp-boolean-true-prop {"a":1}': 'ok {"a":1}',
	'mcp-boolean-true-prop {"b":1}': "REJECT - b: no value is allowed here",
	'mcp-huge-enum {"e":"v4999"}': 'ok {"e":"v4999"}',
	'mcp-huge-enum {"e":"v5000"}':
		'REJECT - e: expected one of ["v0","v1","v2","v3","v4","v5","v6","v7","v8","v9","v10","v11","v12","v13","v14","v15","v16","v17","v18","v19", ... and 4980 more]',
	'oneOf-overlap {"v":"abc"}': "REJECT - v: matches more than one alternative",
	'oneOf-overlap {"v":"abcdefgh"}': 'ok {"v":"abcdefgh"}',
	'oneOf-number-integer {"v":2}': "REJECT - v: matches more than one alternative",
	'oneOf-number-integer {"v":2.5}': 'ok {"v":2.5}',
	'oneOf-objects-open {"v":{"a":"x"}}': "REJECT - v: matches more than one alternative",
	'oneOf-objects-open {"v":{}}': "REJECT - v: matches more than one alternative",
	'if-then-else {"kind":"a"}': "REJECT - n: missing",
	'if-then-else {"kind":"b"}': 'ok {"kind":"b"}',
	'dependentRequired {"a":"x"}': "REJECT - b: required when a is present",
	'dependencies-d7 {"a":"x"}': "REJECT - b: required when a is present",
	'propertyNames {"abc":1}': 'ok {"abc":1}',
	'propertyNames {"ABC":1}': "REJECT - ABC: invalid property name",
	'contains {"l":["a"]}': "REJECT - l: expected at least 1 matching item",
	'contains {"l":["a",1]}': 'ok {"l":["a",1]}',
	'not {"s":"x"}': 'ok {"s":"x"}',
	'not {"s":null}': "ok {}",
	'minProperties {"m":{}}': "REJECT - m: expected at least 1 properties",
	'unevaluatedProperties {"a":"x"}': 'ok {"a":"x"}',
	'unevaluatedProperties {"a":"x","b":1}': "REJECT - b: unknown field",
	'allOf-additional-false {"a":"x"}': 'ok {"a":"x"}',
	'allOf-additional-false {"a":"x","b":"y"}': "REJECT - b: unknown field",
	'const-object {"c":{"y":2,"x":1}}': 'ok {"c":{"y":2,"x":1}}',
	'enum-object {"e":{"y":2,"x":1}}': 'ok {"e":{"y":2,"x":1}}',
	'type-array-multi {"v":true}': 'ok {"v":"true"}',
	'type-array-multi {"v":null}': "ok {}",
	'nullable-type-array {"v":null}': 'ok {"v":null}',
	'nullable-type-array {"v":5}': 'ok {"v":"5"}',
	'exclusiveMinimum-number {"n":0}': "REJECT - n: expected > 0",
	'exclusiveMinimum-number {"n":"0"}': "REJECT - n: expected > 0",
	'maxItems {"l":[1,2]}': "REJECT - l: expected at most 1 items",
	'maxItems {"l":"x"}': 'ok {"l":["x"]}',
	'discriminator-openapi {"p":{"kind":"a","x":"1"}}': 'ok {"p":{"kind":"a","x":1}}',
	'discriminator-openapi {"p":{"kind":"b"}}': 'ok {"p":{"kind":"b"}}',
	'ref-root-defs {"a":"x"}': 'ok {"a":"x"}',
	'ref-root-defs {"a":1}': 'ok {"a":"1"}',
	"ref-root-defs {}": "REJECT - a: missing",
	'ref-recursive {"root":{"v":"2","c":[{"v":"3","c":[]}]}}': 'ok {"root":{"v":2,"c":[{"v":3,"c":[]}]}}',
	'ref-percent {"a":"x"}': 'ok {"a":"x"}',
	'ref-percent {"a":1}': 'ok {"a":"1"}',
	'ref-tilde {"a":"x"}': 'ok {"a":"x"}',
	'defs-with-$id {"a":"x"}': 'ok {"a":"x"}',
	'defs-with-$id {"a":2}': 'ok {"a":"2"}',
	'anyOf-null-default {"v":null}': 'ok {"v":null}',
	"anyOf-null-default {}": "ok {}",
	'format-date-time-lower {"d":"2024-01-01t00:00:00z"}': 'ok {"d":"2024-01-01t00:00:00z"}',
	'format-date-time-lower {"d":"2024-01-01 00:00:00Z"}': "REJECT - d: expected format date-time",
	'format-url {"u":"not a url"}': "REJECT - u: expected format url",
	'integer-as-float-1e0 {"n":1000}': 'ok {"n":1000}',
	"required-missing-props {}": "REJECT - a: missing",
	'required-missing-props {"a":null}': 'ok {"a":null}',
	'string-to-number-trim {"n":" 12 "}': 'ok {"n":12}',
	'string-to-number-trim {"n":"0x10"}': 'ok {"n":16}',
	'string-to-number-trim {"n":"1e3"}': 'ok {"n":1000}',
	'string-to-number-trim {"n":""}': 'ok {"n":0}',
	"tree valid": 'ok {"t":["a",["b"]]}',
	"tree number": 'ok {"t":"5"}',
	"tree [5]": 'ok {"t":["5"]}',
	"json valid": 'ok {"data":{"a":[1,"x",{"b":true}]}}',
	"json null": 'ok {"data":"null"}',
	"json nested null": 'ok {"data":{"a":[1,"null"]}}',
	"filter valid": 'ok {"where":{"and":[{"field":"a","eq":"b"}]}}',
	"filter bad leaf": "REJECT - where.and.0.eq: expected string, got integer",
	"filter deep bad": "REJECT - where.and.0.and.0.and.0.and.0.and.0.eq: missing",
};

/** Every case with the key of its expected outcome: the name and the arguments, or the name alone for recursion. */
const all: Array<[string, string, object, unknown]> = [
	...cases.flatMap(({ name, schema, args }) =>
		args.map((arg): [string, string, object, unknown] => [`${name} ${JSON.stringify(arg)}`, name, schema, arg]),
	),
	...keywordCases.flatMap(([name, schema, args]) =>
		args.map((arg): [string, string, object, unknown] => [`${name} ${JSON.stringify(arg)}`, name, schema, arg]),
	),
	...recursionCases.map(([name, schema, arg]): [string, string, object, unknown] => [name, name, schema, arg]),
];

describe("reviewer probes", () => {
	for (const [key, name, schema, arg] of all) {
		it(key, () => {
			expect(outcome(name, schema, arg)).toBe(expected[key]);
		});
	}
});

describe("reviewer probes (Sol)", () => {
	const tree = {
		type: "object",
		properties: { t: { $ref: "#/$defs/Tree" } },
		$defs: { Tree: { anyOf: [{ type: "string" }, { type: "array", items: { $ref: "#/$defs/Tree" } }] } },
	};
	const solCases: Array<[string, object, unknown, string]> = [
		// TypeBox-only: Type.BigInt and Type.Undefined have no JSON form; TypeBox converted to them.
		[
			"BigInt from a JSON string",
			Type.Object({ n: Type.BigInt() }),
			{ n: "42" },
			"REJECT - n: expected bigint, got string",
		],
		[
			"Undefined from JSON null",
			Type.Object({ n: Type.Undefined() }),
			{ n: null },
			"REJECT - n: expected undefined, got null",
		],
		// TypeBox-only: its additionalProperties also converted declared properties; pi-schema converts only undeclared ones.
		[
			"additionalProperties on declared properties",
			Type.Object({ amount: Type.Number(), label: Type.String() }, { additionalProperties: Type.Integer() }),
			{ amount: 3.5, label: "7" },
			'ok {"amount":3.5,"label":"7"}',
		],
		// TypeBox-only: property names are names, not regular expressions.
		[
			"property names are not patterns",
			Type.Object({ "a.b": Type.Integer(), axb: Type.String() }),
			{ "a.b": "4", axb: "5.8" },
			'ok {"a.b":4,"axb":"5.8"}',
		],
		// TypeBox-only: Refine runs only in TypeBox's own validator.
		[
			"Refine is not run",
			Type.Object({ mode: Type.Refine(Type.String(), (value) => value === "safe") }),
			{ mode: "unsafe" },
			'ok {"mode":"unsafe"}',
		],
		[
			"scalar-or-array that refers to itself",
			{
				type: "object",
				properties: {
					value: { anyOf: [{ type: "number" }, { type: "array", items: { $ref: "#/properties/value" } }] },
				},
				required: ["value"],
			},
			{ value: "42" },
			'ok {"value":42}',
		],
		[
			"StringEnum with an empty member from null",
			Type.Object({ mode: Type.Unsafe({ type: "string", enum: ["", "x"] }) }),
			{ mode: null },
			'ok {"mode":""}',
		],
		[
			"Cyclic with named local definitions",
			Type.Object({
				node: Type.Cyclic(
					{ Node: Type.Object({ n: Type.Number(), next: Type.Optional(Type.Ref("Node")) }) },
					"Node",
				),
			}),
			{ node: { n: 1 } },
			'ok {"node":{"n":1}}',
		],
		[
			"unpaired high surrogate, minLength 2",
			Type.Object({ s: Type.String({ minLength: 2 }) }),
			{ s: "\ud800A" },
			'ok {"s":"\\ud800A"}',
		],
		[
			"unpaired high surrogate, maxLength 1",
			Type.Object({ s: Type.String({ maxLength: 1 }) }),
			{ s: "\ud800A" },
			"REJECT - s: expected at most 1 characters",
		],
		["integer from a string", Type.Object({ n: Type.Integer() }), { n: "42" }, 'ok {"n":42}'],
		["recursive union with a value no branch converts", tree, { t: {} }, "REJECT - t: expected string, got object"],
	];
	for (const [name, schema, arg, result] of solCases) {
		it(name, () => {
			expect(outcome(name, schema, arg)).toBe(result);
		});
	}

	it("accepts the last member of a 10,000-value enum", () => {
		const values = Array.from({ length: 10_000 }, (_, i) => `member${i}`);
		const schema = { type: "object", properties: { choice: { type: "string", enum: values } }, required: ["choice"] };
		expect(outcome("enum", schema, { choice: "member9999" })).toBe('ok {"choice":"member9999"}');
		expect(outcome("enum", schema, { choice: "x" })).toBe(
			`REJECT - choice: expected one of ${JSON.stringify(values.slice(0, 20)).slice(0, -1)}, ... and 9980 more]`,
		);
	});

	it("keeps the validator of a schema object, as before, also when the schema is changed later", () => {
		const parameters = Type.Object({ n: Type.Number({ minimum: 0 }) });
		expect(outcome("late", parameters, { n: "4" })).toBe('ok {"n":4}');
		Object.assign(parameters.properties.n, { minimum: 10 });
		expect(outcome("late", parameters, { n: "4" })).toBe('ok {"n":4}');
	});
});

describe("reviewer probes (round 2)", () => {
	const item = { type: "object", properties: { n: { type: "integer", minimum: 1 } } };
	const nested: Case[] = [
		{ name: "declared", schema: { type: "object", properties: { entry: item } }, args: [{ entry: { n: null } }] },
		{ name: "additional", schema: { type: "object", additionalProperties: item }, args: [{ entry: { n: null } }] },
		{
			name: "pattern",
			schema: { type: "object", patternProperties: { "^entry$": item }, additionalProperties: false },
			args: [{ entry: { n: null } }],
		},
	];
	for (const { name, schema, args } of nested) {
		it(`drops an optional null inside ${name} property values`, () => {
			expect(outcome(name, schema, args[0])).toBe('ok {"entry":{}}');
		});
	}

	for (const keyword of ["anyOf", "oneOf"]) {
		it(`converts a ${keyword} branch together with the node's sibling properties`, () => {
			const schema = {
				type: "object",
				[keyword]: [
					{ type: "object", properties: { a: { type: "array", items: { type: "integer" } } }, required: ["a"] },
					{ type: "object", properties: { b: { type: "boolean" } }, required: ["b"] },
				],
				properties: { c: { type: "integer" } },
				required: ["c"],
			};
			expect(outcome(keyword, schema, { a: "3", c: "2" })).toBe('ok {"a":[3],"c":2}');
		});
	}

	it("rejects a deep value every branch of a recursive object union rejects, without exponential work", () => {
		const S = {
			anyOf: [
				{ type: "object", additionalProperties: { $ref: "#/$defs/S" }, required: ["a"] },
				{ type: "object", additionalProperties: { $ref: "#/$defs/S" }, required: ["b"] },
			],
		};
		const schema = { type: "object", properties: { s: { $ref: "#/$defs/S" } }, $defs: { S } };
		let value: unknown = { x: 1 };
		for (let i = 0; i < 40; i++) value = { c: value };
		expect(outcome("deep", schema, { s: value })).toBe("REJECT - s.a: missing");
	});
});

import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import type { Tool } from "../src/types.ts";
import { inlineLocalSchemaRefs } from "../src/utils/json-schema-refs.ts";

const settings = {
	type: "object",
	properties: { notifications: { type: "boolean" } },
	required: ["notifications"],
	additionalProperties: false,
};

function schema(value: Record<string, unknown>): Tool["parameters"] {
	return value as Tool["parameters"];
}

describe("inlineLocalSchemaRefs", () => {
	it("inlines $defs and definitions references and drops the unused definitions", () => {
		const parameters = schema({
			type: "object",
			properties: {
				settings: { $ref: "#/$defs/Settings", description: "Check settings" },
				legacy: { $ref: "#/definitions/Legacy" },
				escaped: { $ref: "#/$defs/a~1b~0c" },
			},
			$defs: { Settings: settings, "a/b~c": { type: "string" } },
			definitions: { Legacy: { type: "number" } },
		});
		const original = structuredClone(parameters);

		expect(inlineLocalSchemaRefs(parameters)).toEqual({
			type: "object",
			properties: {
				settings: { ...settings, description: "Check settings" },
				legacy: { type: "number" },
				escaped: { type: "string" },
			},
		});
		expect(parameters).toEqual(original);
	});

	it("follows chained references and pointers outside $defs", () => {
		const parameters = schema({
			type: "object",
			properties: {
				billing: { $ref: "#/$defs/Address" },
				shipping: { $ref: "#/properties/billing" },
			},
			$defs: {
				Address: { type: "object", properties: { country: { $ref: "#/$defs/Country" } } },
				Country: { type: "string" },
			},
		});
		const address = { type: "object", properties: { country: { type: "string" } } };

		expect(inlineLocalSchemaRefs(parameters)).toEqual({
			type: "object",
			properties: { billing: address, shipping: address },
		});
	});

	it("inlines properties whose names are keywords and nested definitions", () => {
		const parameters = schema({
			type: "object",
			properties: {
				default: { $ref: "#/$defs/Value" },
				enum: { $ref: "#/$defs/Value" },
				nested: { $defs: { Inner: { $ref: "#/$defs/Value" } }, $ref: "#/$defs/Value" },
			},
			$defs: { Value: { type: "string" } },
		});

		expect(inlineLocalSchemaRefs(parameters)).toEqual({
			type: "object",
			properties: {
				default: { type: "string" },
				enum: { type: "string" },
				nested: { $defs: { Inner: { type: "string" } }, $ref: "#/$defs/Value" },
			},
			$defs: { Value: { type: "string" } },
		});
	});

	it("builds a separate copy for every expansion", () => {
		const inlined = inlineLocalSchemaRefs(
			schema({
				type: "object",
				properties: { a: { $ref: "#/$defs/Item" }, b: { $ref: "#/$defs/Item" } },
				$defs: { Item: { type: "object", properties: {} } },
			}),
		) as { properties: Record<string, unknown> };

		expect(inlined.properties.a).toEqual(inlined.properties.b);
		expect(inlined.properties.a).not.toBe(inlined.properties.b);
	});

	it("keeps recursive and non-annotation references with the definitions they need", () => {
		const parameters = schema({
			type: "object",
			properties: {
				tree: { $ref: "#/$defs/Node" },
				narrowed: { $ref: "#/$defs/Leaf", minLength: 1 },
			},
			$defs: {
				Node: { type: "object", properties: { children: { type: "array", items: { $ref: "#/$defs/Node" } } } },
				Leaf: { type: "string" },
			},
		});

		expect(inlineLocalSchemaRefs(parameters)).toEqual({
			type: "object",
			properties: {
				tree: { type: "object", properties: { children: { type: "array", items: { $ref: "#/$defs/Node" } } } },
				narrowed: { $ref: "#/$defs/Leaf", minLength: 1 },
			},
			$defs: (parameters as { $defs: unknown }).$defs,
		});
	});

	it("keeps definitions for anchor references", () => {
		const $defs = { A: { type: "string" }, B: { $anchor: "b", type: "number" } };
		const parameters = schema({
			type: "object",
			properties: { a: { $ref: "#/$defs/A" }, b: { $ref: "#b" } },
			$defs,
		});

		expect(inlineLocalSchemaRefs(parameters)).toEqual({
			type: "object",
			properties: { a: { type: "string" }, b: { $ref: "#b" } },
			$defs,
		});
	});

	it("returns the input when nothing can be inlined", () => {
		const cases = [
			Type.Object({ value: Type.String() }),
			schema({ type: "object", properties: { child: { $ref: "https://example.com/child.json" } } }),
			schema({ type: "object", properties: { missing: { $ref: "#/$defs/Missing" } } }),
			schema({ type: "object", properties: { self: { $ref: "#" } } }),
			schema({
				type: "object",
				properties: {
					value: { $ref: "#/$defs/Value" },
					scoped: { $id: "https://example.com/scoped", type: "object" },
				},
				$defs: { Value: { type: "string" } },
			}),
			schema({
				type: "object",
				properties: { a: { $ref: "#/$defs/Anchored" }, b: { $ref: "#/$defs/Anchored" } },
				$defs: { Anchored: { $anchor: "anchored", type: "string" } },
			}),
		];
		for (const parameters of cases) expect(inlineLocalSchemaRefs(parameters)).toBe(parameters);
	});

	it("does not treat data keywords as schemas", () => {
		const constant = { $ref: "#/$defs/Value" };
		const inlined = inlineLocalSchemaRefs(
			schema({
				type: "object",
				properties: { value: { $ref: "#/$defs/Value" }, literal: { const: constant } },
				$defs: { Value: { type: "string" } },
			}),
		) as { properties: { literal: { const: unknown } } };

		expect(inlined.properties.literal.const).toBe(constant);
	});

	it("returns the input when references expand exponentially", () => {
		const $defs: Record<string, unknown> = { D25: { type: "string" } };
		for (let index = 0; index < 25; index++) {
			$defs[`D${index}`] = {
				type: "object",
				properties: { a: { $ref: `#/$defs/D${index + 1}` }, b: { $ref: `#/$defs/D${index + 1}` } },
			};
		}
		const parameters = schema({ type: "object", properties: { root: { $ref: "#/$defs/D0" } }, $defs });

		expect(inlineLocalSchemaRefs(parameters)).toBe(parameters);
	});

	it("returns the same result for the same schema object", () => {
		const parameters = schema({
			type: "object",
			properties: { value: { $ref: "#/$defs/V" } },
			$defs: { V: { type: "string" } },
		});
		expect(inlineLocalSchemaRefs(parameters)).toBe(inlineLocalSchemaRefs(parameters));
	});
});

import { describe, expect, it } from "vitest";
import { normalizeToolSchemaForOpenAI } from "../src/utils/normalize-json-schema.ts";

describe("normalizeToolSchemaForOpenAI", () => {
	it("adds an empty required array to an object schema that omits it", () => {
		const schema = {
			type: "object",
			properties: { a: { type: "string" }, b: { type: "number" } },
		};
		expect(normalizeToolSchemaForOpenAI(schema)).toEqual({
			type: "object",
			properties: { a: { type: "string" }, b: { type: "number" } },
			required: [],
		});
	});

	it("normalizes required: null to an empty array", () => {
		const schema = { type: "object", properties: {}, required: null };
		expect(normalizeToolSchemaForOpenAI(schema)).toEqual({
			type: "object",
			properties: {},
			required: [],
		});
	});

	it("preserves an existing non-empty required array", () => {
		const schema = {
			type: "object",
			properties: { a: { type: "string" } },
			required: ["a"],
		};
		expect(normalizeToolSchemaForOpenAI(schema)).toEqual(schema);
	});

	it("recurses into nested object properties", () => {
		const schema = {
			type: "object",
			properties: {
				nested: { type: "object", properties: { x: { type: "string" } } },
			},
			required: ["nested"],
		};
		const result = normalizeToolSchemaForOpenAI(schema) as {
			properties: { nested: { required: unknown } };
		};
		expect(result.properties.nested.required).toEqual([]);
	});

	it("recurses into items, anyOf, oneOf, allOf and $defs", () => {
		const schema = {
			type: "object",
			properties: {
				list: { type: "array", items: { type: "object", properties: {} } },
				choice: {
					anyOf: [{ type: "object", properties: {} }, { type: "null" }],
				},
			},
			required: ["list", "choice"],
			$defs: {
				Ref: { type: "object", properties: { y: { type: "number" } } },
			},
		};
		const result = normalizeToolSchemaForOpenAI(schema) as {
			properties: {
				list: { items: { required: unknown } };
				choice: { anyOf: Array<{ required?: unknown }> };
			};
			$defs: { Ref: { required: unknown } };
		};
		expect(result.properties.list.items.required).toEqual([]);
		expect(result.properties.choice.anyOf[0].required).toEqual([]);
		expect(result.properties.choice.anyOf[1].required).toBeUndefined();
		expect(result.$defs.Ref.required).toEqual([]);
	});

	it("does not touch non-object schemas", () => {
		expect(normalizeToolSchemaForOpenAI({ type: "string" })).toEqual({ type: "string" });
		expect(normalizeToolSchemaForOpenAI({ type: "array", items: { type: "number" } })).toEqual({
			type: "array",
			items: { type: "number" },
		});
	});

	it("does not mutate the input schema", () => {
		const schema = { type: "object", properties: {} };
		const snapshot = JSON.stringify(schema);
		normalizeToolSchemaForOpenAI(schema);
		expect(JSON.stringify(schema)).toEqual(snapshot);
	});
});

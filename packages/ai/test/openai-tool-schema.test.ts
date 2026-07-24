import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { normalizeOpenAIToolParameters } from "../src/api/tool-schema.ts";

describe("normalizeOpenAIToolParameters", () => {
	it("adds empty required arrays for all-optional object schemas", () => {
		const schema = Type.Object({
			action: Type.Optional(Type.Union([Type.Literal("read"), Type.Literal("write")])),
			content: Type.Optional(Type.String()),
		});

		const normalized = normalizeOpenAIToolParameters(schema);

		expect(normalized.required).toEqual([]);
		expect(schema).not.toHaveProperty("required");
	});

	it("preserves existing required arrays", () => {
		const schema = Type.Object({
			path: Type.String(),
			limit: Type.Optional(Type.Number()),
		});

		const normalized = normalizeOpenAIToolParameters(schema);

		expect(normalized.required).toEqual(["path"]);
	});

	it("normalizes nested object schemas in properties, unions, arrays, and definitions", () => {
		const schema = {
			type: "object",
			properties: {
				child: {
					type: "object",
					properties: {
						name: { type: "string" },
					},
				},
				union: {
					anyOf: [
						{
							type: "object",
							properties: {
								value: { type: "string" },
							},
							required: null,
						},
					],
				},
				list: {
					type: "array",
					items: {
						type: "object",
						properties: {
							id: { type: "string" },
						},
					},
				},
			},
			$defs: {
				Metadata: {
					type: "object",
					properties: {
						label: { type: "string" },
					},
				},
			},
		} as unknown as Parameters<typeof normalizeOpenAIToolParameters>[0];

		const normalized = normalizeOpenAIToolParameters(schema) as {
			required?: unknown;
			properties: {
				child: { required?: unknown };
				union: { anyOf: Array<{ required?: unknown }> };
				list: { items: { required?: unknown } };
			};
			$defs: { Metadata: { required?: unknown } };
		};

		expect(normalized.required).toEqual([]);
		expect(normalized.properties.child.required).toEqual([]);
		expect(normalized.properties.union.anyOf[0].required).toEqual([]);
		expect(normalized.properties.list.items.required).toEqual([]);
		expect(normalized.$defs.Metadata.required).toEqual([]);
	});
});

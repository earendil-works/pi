import { type Static, Type } from "@sinclair/typebox";
import { describe, expect, it } from "vitest";
import { validateToolArguments } from "../src/utils/validation.js";

const findSchema = Type.Object({
	pattern: Type.String(),
	path: Type.Optional(Type.String()),
	limit: Type.Optional(Type.Number()),
});

type FindArgs = Static<typeof findSchema>;

describe("validateToolArguments", () => {
	it("repairs a leading-dot key when the schema expects the undotted name", () => {
		const validated = validateToolArguments(
			{
				name: "find",
				description: "Find files",
				parameters: findSchema,
			},
			{
				type: "toolCall",
				id: "call-1",
				name: "find",
				arguments: {
					path: "tc-web-client-v2",
					".pattern": "**/*",
					limit: 20,
				},
			},
		) as FindArgs;

		expect(validated).toEqual({
			path: "tc-web-client-v2",
			pattern: "**/*",
			limit: 20,
		});
	});

	it("drops the dotted duplicate when the canonical key is already present", () => {
		const validated = validateToolArguments(
			{
				name: "find",
				description: "Find files",
				parameters: findSchema,
			},
			{
				type: "toolCall",
				id: "call-2",
				name: "find",
				arguments: {
					path: "tc-web-client-v2",
					pattern: "src/**/*.ts",
					".pattern": "**/*",
					limit: 20,
				},
			},
		) as FindArgs;

		expect(validated).toEqual({
			path: "tc-web-client-v2",
			pattern: "src/**/*.ts",
			limit: 20,
		});
	});
});

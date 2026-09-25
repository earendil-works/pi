import { describe, expect, it } from "vitest";
import { renderDeclarations, schemaToType } from "../src/index.ts";

const execute = () => undefined;

describe("schemaToType", () => {
	it("renders primitives, literals, and unions", () => {
		expect(schemaToType({ type: "string" })).toBe("string");
		expect(schemaToType({ type: "integer" })).toBe("number");
		expect(schemaToType({ type: ["string", "null"] })).toBe("string | null");
		expect(schemaToType({ const: "a" })).toBe('"a"');
		expect(schemaToType({ enum: ["a", 1, null] })).toBe('"a" | 1 | null');
		expect(schemaToType({ anyOf: [{ type: "string" }, { type: "number" }] })).toBe("string | number");
		expect(schemaToType({ anyOf: [{ type: "string" }, {}] })).toBe("unknown");
		expect(schemaToType({ $ref: "#/defs/x" })).toBe("unknown");
		expect(schemaToType(true)).toBe("unknown");
		expect(schemaToType(false)).toBe("never");
	});

	it("renders arrays and tuples", () => {
		expect(schemaToType({ type: "array", items: { type: "string" } })).toBe("string[]");
		expect(schemaToType({ type: "array", items: { anyOf: [{ type: "string" }, { type: "number" }] } })).toBe(
			"(string | number)[]",
		);
		expect(schemaToType({ type: "array", prefixItems: [{ type: "string" }, { type: "number" }] })).toBe(
			"[string, number]",
		);
		expect(schemaToType({ type: "array" })).toBe("unknown[]");
	});

	it("renders objects with optional members, doc comments, and index signatures", () => {
		const type = schemaToType({
			type: "object",
			properties: {
				path: { type: "string", description: "Path to read" },
				"max-lines": { type: "number" },
			},
			required: ["path"],
		});
		expect(type).toBe('{\n  /** Path to read */\n  path: string;\n  "max-lines"?: number;\n}');
		expect(schemaToType({ type: "object", additionalProperties: { type: "number" } })).toBe(
			"{\n  [key: string]: number;\n}",
		);
		expect(schemaToType({ type: "object" })).toBe("Record<string, unknown>");
		expect(schemaToType({ type: "object", properties: {}, additionalProperties: false })).toBe("{}");
	});
});

describe("renderDeclarations", () => {
	it("renders tools and globals", () => {
		const text = renderDeclarations({
			tools: [
				{
					name: "read",
					description: "Read a file.\nSecond line.",
					inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
					outputSchema: { type: "string" },
					execute,
				},
				{ name: "remote-api", execute },
				{ name: "noargs", inputSchema: { type: "object", properties: {} }, execute },
			],
			globals: [{ name: "image", description: "Attach an image.", inputSchema: { type: "string" }, execute }],
		});
		expect(text).toBe(
			[
				"declare const tools: {",
				"  /**",
				"   * Read a file.",
				"   * Second line.",
				"   */",
				"  read(args: {",
				"    path: string;",
				"  }): Promise<string>;",
				'  "remote-api"(args?: unknown): Promise<unknown>;',
				"  noargs(args?: Record<string, unknown>): Promise<unknown>;",
				"};",
				"",
				"/** Attach an image. */",
				"declare function image(args: string): Promise<unknown>;",
			].join("\n"),
		);
	});

	it("renders namespaced globals and explicit signatures", () => {
		const text = renderDeclarations({
			globals: [
				{
					name: "models.list",
					description: "List models.",
					signature: "(type: string): Promise<string[]>",
					execute,
				},
				{ name: "models.get", inputSchema: { type: "string" }, execute },
				{ name: "plain", signature: "(): void", execute },
			],
		});
		expect(text).toBe(
			[
				"declare function plain(): void;",
				"",
				"declare const models: {",
				"  /** List models. */",
				"  list(type: string): Promise<string[]>;",
				"  get(args: string): Promise<unknown>;",
				"};",
			].join("\n"),
		);
	});

	it("escapes comment terminators in descriptions", () => {
		const text = renderDeclarations({ tools: [{ name: "x", description: "a */ b", execute }] });
		expect(text).toContain("/** a *\\/ b */");
	});
});

import { describe, expect, it } from "vitest";
import { renderDeclarations, renderToolSample, renderToolSignature, schemaToType } from "../src/index.ts";

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
		expect(schemaToType({ allOf: [{ anyOf: [{ type: "string" }, { type: "number" }] }, { const: 1 }] })).toBe(
			"(string | number) & 1",
		);
		expect(schemaToType({ $ref: "#/defs/x" })).toBe("unknown");
		expect(schemaToType(true)).toBe("unknown");
		expect(schemaToType(false)).toBe("never");
	});

	it("renders objects on one line with sorted properties", () => {
		expect(
			schemaToType({
				type: "object",
				properties: { city: { type: "string" }, "max-lines": { type: "number" } },
				required: ["city"],
				additionalProperties: false,
			}),
		).toBe('{ city: string; "max-lines"?: number; }');
		expect(schemaToType({ type: "object", additionalProperties: { type: "number" } })).toBe(
			"{ [key: string]: number; }",
		);
		expect(schemaToType({ type: "object" })).toBe("{ [key: string]: unknown; }");
		expect(schemaToType({ type: "object", properties: {}, additionalProperties: false })).toBe("{}");
	});

	it("puts property descriptions on comment lines", () => {
		expect(
			schemaToType({
				type: "object",
				properties: {
					weather: {
						type: "array",
						description: "look up weather for a given list of locations",
						items: { type: "object", properties: { location: { type: "string" } }, required: ["location"] },
					},
				},
				required: ["weather"],
			}),
		).toBe("{\n  // look up weather for a given list of locations\n  weather: Array<{ location: string; }>;\n}");
		expect(
			schemaToType({
				type: "object",
				properties: {
					outer: {
						type: "object",
						description: "Outer",
						properties: { inner: { type: "string", description: "Inner" } },
					},
				},
			}),
		).toBe("{\n  // Outer\n  outer?: {\n    // Inner\n    inner?: string;\n  };\n}");
	});

	// https://github.com/earendil-works/pi/issues/10707
	it("puts constraints the type cannot express on property comment lines", () => {
		expect(
			schemaToType({
				type: "object",
				properties: {
					timeoutMs: {
						type: "integer",
						minimum: 0,
						maximum: 30000,
						default: 0,
						description: "Wait in milliseconds.",
					},
					id: { type: "string", pattern: "^[a-z]+$", maxLength: 8 },
					tags: { type: "array", items: { type: "string" }, maxItems: 5, uniqueItems: true, deprecated: true },
					name: { type: "string" },
				},
				required: ["id"],
			}),
		).toBe(
			[
				"{",
				"  // @maxLength 8 @pattern ^[a-z]+$",
				"  id: string;",
				"  name?: string;",
				"  // @maxItems 5 @uniqueItems @deprecated",
				"  tags?: Array<string>;",
				"  // Wait in milliseconds.",
				"  // @integer @minimum 0 @maximum 30000 @default 0",
				"  timeoutMs?: number;",
				"}",
			].join("\n"),
		);
	});

	it("reads constraints of optional fields from the non-null branch", () => {
		// Pydantic's `limit: int | None = Field(None, ge=1, le=100)`.
		expect(
			schemaToType({
				type: "object",
				properties: {
					limit: {
						anyOf: [{ type: "integer", minimum: 1, maximum: 100 }, { type: "null" }],
						default: null,
						title: "Limit",
					},
				},
			}),
		).toBe("{\n  // @integer @minimum 1 @maximum 100\n  limit?: number | null;\n}");
		// Constraints of the property and the branch both apply.
		expect(
			schemaToType({
				type: "object",
				properties: {
					n: {
						anyOf: [{ type: "integer", minimum: 10, maximum: 50, format: "int32" }, { type: "null" }],
						minimum: 0,
						maximum: 20,
						format: "port",
					},
				},
			}),
		).toBe("{\n  // @integer @minimum 10 @maximum 20 @format port @format int32\n  n?: number | null;\n}");
	});

	it("reads draft-04 boolean exclusive bounds", () => {
		expect(
			schemaToType({
				type: "object",
				properties: {
					n: { type: "integer", minimum: 0, exclusiveMinimum: true, maximum: 10, exclusiveMaximum: false },
					m: { anyOf: [{ type: "number", maximum: 5, exclusiveMaximum: true }, { type: "null" }], maximum: 8 },
				},
			}),
		).toBe(
			[
				"{",
				"  // @maximum 8 @exclusiveMaximum 5",
				"  m?: number | null;",
				"  // @integer @exclusiveMinimum 0 @maximum 10",
				"  n?: number;",
				"}",
			].join("\n"),
		);
	});

	it("leaves out long tags and escapes line terminators", () => {
		expect(
			schemaToType({
				type: "object",
				properties: { config: { type: "object", default: { text: "x".repeat(100) } } },
			}),
		).toBe("{ config?: { [key: string]: unknown; }; }");
		expect(
			schemaToType({
				type: "object",
				properties: {
					sep: { type: "string", pattern: "^[\r\n\u2028\u2029]$", default: "\u2028", description: "a\u2028b" },
				},
			}),
		).toBe(
			[
				"{",
				"  // a",
				"  // b",
				'  // @pattern ^[\\u000d\\u000a\\u2028\\u2029]$ @default "\\u2028"',
				"  sep?: string;",
				"}",
			].join("\n"),
		);
	});

	it("drops constraint tags before rendering a type over the budget as unknown", () => {
		const schema = { type: "object", properties: { n: { type: "integer", minimum: 1 } } };
		expect(schemaToType(schema)).toBe("{\n  // @integer @minimum 1\n  n?: number;\n}");
		expect(schemaToType(schema, { maxChars: 20 })).toBe("{ n?: number; }");
		expect(schemaToType(schema, { maxChars: 10 })).toBe("unknown");
	});

	it("resolves local references and stops at recursive ones", () => {
		const schema = {
			type: "object",
			properties: {
				item: { $ref: "#/$defs/Item" },
				legacy: { $ref: "#/definitions/Legacy" },
				remote: { $ref: "https://example.com/schema.json" },
			},
			required: ["item"],
			$defs: {
				Item: {
					type: "object",
					properties: { id: { type: "string" }, parent: { $ref: "#/$defs/Item" } },
					required: ["id"],
				},
			},
			definitions: { Legacy: { enum: ["a", "b"] } },
		};
		expect(schemaToType(schema)).toBe(
			'{ item: { id: string; parent?: unknown; }; legacy?: "a" | "b"; remote?: unknown; }',
		);
	});

	it("renders arrays and tuples", () => {
		expect(schemaToType({ type: "array", items: { type: "string" } })).toBe("Array<string>");
		expect(schemaToType({ type: "array", prefixItems: [{ type: "string" }, { type: "number" }] })).toBe(
			"[string, number]",
		);
		expect(schemaToType({ type: "array" })).toBe("unknown[]");
	});

	it("renders types over the budget as unknown", () => {
		const properties = Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`field${i}`, { type: "string" }]));
		const schema = { type: "object", properties };
		expect(schemaToType(schema, { maxChars: 100 })).toBe("unknown");
		expect(schemaToType(schema)).toContain("field49?: string;");
	});
});

describe("tool declarations", () => {
	it("renders signatures with normalized identifiers", () => {
		expect(
			renderToolSignature({
				name: "hidden-dynamic-tool",
				inputSchema: {
					type: "object",
					properties: { city: { type: "string" } },
					required: ["city"],
					additionalProperties: false,
				},
				outputSchema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] },
			}),
		).toBe("hidden_dynamic_tool(args: { city: string; }): Promise<{ ok: boolean; }>;");
		expect(renderToolSignature({ name: "free" })).toBe("free(args: unknown): Promise<unknown>;");
	});

	it("renders output schemas shaped like an MCP CallToolResult as plain types", () => {
		const outputSchema = {
			type: "object",
			properties: {
				content: { type: "array", items: { type: "object" } },
				isError: { type: "boolean" },
				_meta: { type: "object" },
			},
			required: ["content"],
		};
		expect(
			renderToolSignature({ name: "plain", inputSchema: { type: "object", properties: {} }, outputSchema }),
		).toBe(
			"plain(args: { [key: string]: unknown; }): Promise<{ _meta?: { [key: string]: unknown; }; content: Array<{ [key: string]: unknown; }>; isError?: boolean; }>;",
		);
	});

	it("renders the per-tool sample", () => {
		expect(renderToolSample({ name: "foo", description: "bar", inputSchema: { type: "string" } })).toBe(
			"bar\n\ncodemode tool declaration:\n```ts\ndeclare const tools: { foo(args: string): Promise<unknown>; };\n```",
		);
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
			],
			globals: [{ name: "attach", description: "Attach it.", inputSchema: { type: "string" }, execute }],
		});
		expect(text).toBe(
			[
				"declare const tools: {",
				"  /**",
				"   * Read a file.",
				"   * Second line.",
				"   */",
				"  read(args: { path: string; }): Promise<string>;",
				"  remote_api(args: unknown): Promise<unknown>;",
				"};",
				"",
				"/** Attach it. */",
				"declare function attach(args: string): Promise<unknown>;",
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

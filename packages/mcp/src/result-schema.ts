/**
 * The output schema of an MCP tool for programs that call it: the whole `CallToolResult`, with the tool's own output
 * schema as `structuredContent`.
 */

/**
 * MCP content blocks as one compact type with the fields of text and image blocks, which scripts
 * read most. Rendered into every MCP tool's declaration.
 */
const CONTENT_BLOCK_SCHEMA = {
	type: "object",
	properties: {
		type: { enum: ["text", "image", "audio", "resource_link", "resource"] },
		text: { type: "string" },
		data: { type: "string" },
		mimeType: { type: "string" },
	},
	required: ["type"],
	additionalProperties: true,
};

/**
 * Output schema of an MCP tool: the `CallToolResult` programs receive (without `_meta`, which callers drop), with the
 * tool's own output schema as `structuredContent`. Without one, structured content may be any JSON value.
 */
export function createMcpResultSchema(
	structuredContentSchema: Record<string, unknown> | undefined,
): Record<string, unknown> {
	return {
		type: "object",
		properties: {
			content: { type: "array", items: CONTENT_BLOCK_SCHEMA },
			structuredContent: structuredContentSchema
				? relocateSchema(structuredContentSchema, "#/properties/structuredContent")
				: {},
			isError: { type: "boolean" },
		},
		required: ["content"],
		// Fields newer protocol versions add.
		additionalProperties: true,
	};
}

/** Keywords whose values are data, so a `$ref` key in them is not a reference. */
const SCHEMA_DATA_KEYWORDS: ReadonlySet<string> = new Set(["const", "enum", "default", "examples"]);

/** Keywords whose values map names to schemas, so their keys are names, not keywords. */
const SCHEMA_MAP_KEYWORDS: ReadonlySet<string> = new Set([
	"properties",
	"patternProperties",
	"dependentSchemas",
	"dependencies",
	"$defs",
	"definitions",
]);

/**
 * `schema` as a subschema at the JSON pointer `pointer` (`#/properties/structuredContent`) of
 * another schema: its local references (`#`, `#/$defs/Item`) are rewritten to point below
 * `pointer`, so they resolve to the same subschemas as before.
 */
function relocateSchema(schema: unknown, pointer: string): unknown {
	// The server's schema is wire input of any JSON shape.
	if (Array.isArray(schema)) return schema.map((item) => relocateSchema(item, pointer));
	if (typeof schema !== "object" || schema === null) return schema;
	const relocated: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(schema)) {
		if (key === "$ref" && typeof value === "string" && (value === "#" || value.startsWith("#/"))) {
			relocated[key] = `${pointer}${value.slice(1)}`;
		} else if (SCHEMA_DATA_KEYWORDS.has(key)) {
			relocated[key] = value;
		} else if (SCHEMA_MAP_KEYWORDS.has(key) && typeof value === "object" && value !== null && !Array.isArray(value)) {
			relocated[key] = Object.fromEntries(
				Object.entries(value).map(([name, subschema]) => [name, relocateSchema(subschema, pointer)]),
			);
		} else {
			relocated[key] = relocateSchema(value, pointer);
		}
	}
	return relocated;
}

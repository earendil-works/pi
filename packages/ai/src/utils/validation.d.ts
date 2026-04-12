import type { Tool, ToolCall } from "../types.js";
/**
 * Validates tool call arguments against the tool's TypeBox schema
 * @param tool The tool definition with TypeBox schema
 * @param toolCall The tool call from the LLM
 * @returns The validated arguments
 * @throws Error with formatted message if validation fails
 */
export declare function validateToolArguments(tool: Tool, toolCall: ToolCall): any;
/**
 * Coerce string-encoded nested objects in tool call arguments.
 *
 * Some providers (e.g., synthetic HuggingFace TGI endpoints) serialize
 * object-valued parameters as JSON strings rather than JSON objects:
 *
 *   { "startup": "{\"type\":\"context\",\"specPath\":\"...\"}" }
 *
 * instead of the correct:
 *
 *   { "startup": { "type": "context", "specPath": "..." } }
 *
 * This function walks the arguments alongside the schema and, for any
 * property or array item where the schema expects an object (or union of
 * objects) but the value is a string, attempts `JSON.parse`. If parsing
 * succeeds and produces an object, the parsed value replaces the string.
 * If parsing fails or produces a non-object, the original value is kept
 * (so AJV can still produce a meaningful validation error).
 */
export declare function coerceStringEncodedObjects(
	args: Record<string, unknown>,
	schema: Record<string, unknown>,
): Record<string, unknown>;
/**
 * Format schema information for error messages to help models self-correct.
 * Handles simple types, enums, anyOf/union types, and array-of-object types.
 */
export declare function formatSchemaInfo(schema: Record<string, unknown>): string;
//# sourceMappingURL=validation.d.ts.map

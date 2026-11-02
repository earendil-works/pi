import { type CoercingValidator, compile } from "@earendil-works/pi-schema";
import { formats } from "@earendil-works/pi-schema/formats";
import type { Tool, ToolCall } from "../types.ts";

// One compiled validator per schema object: tool schemas are long-lived, so the WeakMap drops entries with their tools.
const validatorCache = new WeakMap<object, CoercingValidator>();

function getValidator(schema: Tool["parameters"]): CoercingValidator {
	const cached = validatorCache.get(schema);
	if (cached) {
		return cached;
	}
	// A $ref that names nothing (a dangling definition in an MCP server's schema) rejects only values at its place,
	// instead of making every call of the tool fail.
	const validator = compile(schema, { formats, coerce: true, unresolvedRefs: "reject" });
	validatorCache.set(schema, validator);
	return validator;
}

/** A pi-schema error path (a JSON Pointer) as the dotted path the model sees: `/edits/0/oldText` -> `edits.0.oldText`. */
function formatValidationPath(pointer: string): string {
	if (pointer === "") return "root";
	return pointer
		.slice(1)
		.split("/")
		.map((segment) => segment.replace(/~1/g, "/").replace(/~0/g, "~"))
		.join(".");
}

/**
 * Finds a tool by name and validates the tool call arguments against its JSON Schema
 * @param tools Array of tool definitions
 * @param toolCall The tool call from the LLM
 * @returns The validated arguments
 * @throws Error if tool is not found or validation fails
 */
export function validateToolCall(tools: Tool[], toolCall: ToolCall): any {
	const tool = tools.find((t) => t.name === toolCall.name);
	if (!tool) {
		throw new Error(`Tool "${toolCall.name}" not found`);
	}
	return validateToolArguments(tool, toolCall);
}

/**
 * Validates tool call arguments against the tool's JSON Schema (any JSON Schema: pi-schema's builders, TypeBox, plain
 * objects). The arguments are coerced first (pi-schema's `parse()`): models often send `"42"` for a number, a single
 * value for an array, or `null` for an omitted optional property.
 * @param tool The tool definition with its JSON Schema
 * @param toolCall The tool call from the LLM
 * @returns The validated (and potentially coerced) arguments
 * @throws Error with formatted message if validation fails
 */
export function validateToolArguments(tool: Tool, toolCall: ToolCall): any {
	if (toolCall.argumentsError) {
		throw new Error(`Invalid arguments for tool "${toolCall.name}": ${toolCall.argumentsError}`);
	}
	// A copy, so tools that modify their arguments never modify the tool call in the transcript.
	const result = getValidator(tool.parameters).parse(structuredClone(toolCall.arguments));
	if (result.ok) {
		return result.value;
	}

	const errors = result.errors.map((error) => `  - ${formatValidationPath(error.path)}: ${error.message}`).join("\n");

	const errorMessage = `Validation failed for tool "${toolCall.name}":\n${errors}\n\nReceived arguments:\n${JSON.stringify(toolCall.arguments, null, 2)}`;

	throw new Error(errorMessage);
}

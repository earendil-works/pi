import AjvModule from "ajv";
import addFormatsModule from "ajv-formats";

// Handle both default and named exports
const Ajv = (AjvModule as any).default || AjvModule;
const addFormats = (addFormatsModule as any).default || addFormatsModule;

import type { Tool, ToolCall } from "../types.js";

// Detect if we're in a browser extension environment with strict CSP
// Chrome extensions with Manifest V3 don't allow eval/Function constructor
const isBrowserExtension = typeof globalThis !== "undefined" && (globalThis as any).chrome?.runtime?.id !== undefined;

function canUseRuntimeCodegen(): boolean {
	if (isBrowserExtension) {
		return false;
	}

	try {
		new Function("return true;");
		return true;
	} catch {
		return false;
	}
}

// Create a singleton AJV instance with formats only when runtime code generation is available.
let ajv: any = null;
if (canUseRuntimeCodegen()) {
	try {
		ajv = new Ajv({
			allErrors: true,
			strict: false,
			coerceTypes: true,
		});
		addFormats(ajv);
	} catch (_e) {
		console.warn("AJV validation disabled due to CSP restrictions");
	}
}

/**
 * Finds a tool by name and validates the tool call arguments against its TypeBox schema
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
 * Validates tool call arguments against the tool's TypeBox schema
 * @param tool The tool definition with TypeBox schema
 * @param toolCall The tool call from the LLM
 * @returns The validated (and potentially coerced) arguments
 * @throws Error with formatted message if validation fails
 */
export function validateToolArguments(tool: Tool, toolCall: ToolCall): any {
	// Skip validation in environments where runtime code generation is unavailable.
	if (!ajv || !canUseRuntimeCodegen()) {
		return toolCall.arguments;
	}

	// Compile the schema.
	const validate = ajv.compile(tool.parameters);

	// Clone arguments so AJV can safely mutate for type coercion
	const args = structuredClone(toolCall.arguments);

	coerceStringifiedJsonFields(args, tool.parameters);

	// Validate the arguments (AJV mutates args in-place for type coercion)
	if (validate(args)) {
		return args;
	}

	// Format validation errors nicely
	const errors =
		validate.errors
			?.map((err: any) => {
				const path = err.instancePath ? err.instancePath.substring(1) : err.params.missingProperty || "root";
				return `  - ${path}: ${err.message}`;
			})
			.join("\n") || "Unknown validation error";

	const errorMessage = `Validation failed for tool "${toolCall.name}":\n${errors}\n\nReceived arguments:\n${JSON.stringify(toolCall.arguments, null, 2)}`;

	throw new Error(errorMessage);
}

/**
 * Some models (Opus 4.6, GLM-5.1) send array/object parameters as JSON strings.
 * Parse them back into real values before AJV validation.
 */
function coerceStringifiedJsonFields(args: Record<string, any>, schema: any): void {
	const properties = schema?.properties;
	if (!properties || typeof args !== "object" || args === null) return;

	for (const [key, propSchema] of Object.entries<any>(properties)) {
		const value = args[key];
		if (typeof value !== "string") continue;

		const expectedType = propSchema?.type;
		if (expectedType !== "array" && expectedType !== "object") continue;

		try {
			const parsed = JSON.parse(value);
			if (expectedType === "array" && Array.isArray(parsed)) {
				args[key] = parsed;
			} else if (
				expectedType === "object" &&
				typeof parsed === "object" &&
				parsed !== null &&
				!Array.isArray(parsed)
			) {
				args[key] = parsed;
			}
		} catch {}
	}
}

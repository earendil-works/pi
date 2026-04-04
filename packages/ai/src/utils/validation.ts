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

	// Clone and normalize arguments so AJV can safely mutate for type coercion.
	// Some models occasionally emit keys like ".pattern" instead of "pattern".
	const args = normalizeArgumentsForSchema(structuredClone(toolCall.arguments), tool.parameters);

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

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOwn(record: Record<string, unknown>, key: string): boolean {
	return Object.hasOwn(record, key);
}

function normalizeArgumentsForSchema(value: unknown, schema: unknown): unknown {
	if (Array.isArray(value)) {
		const itemSchema = isRecord(schema) ? schema.items : undefined;
		return value.map((entry) => normalizeArgumentsForSchema(entry, itemSchema));
	}

	if (!isRecord(value)) {
		return value;
	}

	const schemaProperties =
		isRecord(schema) && isRecord(schema.properties) ? (schema.properties as Record<string, unknown>) : {};
	const additionalProperties =
		isRecord(schema) && isRecord(schema.additionalProperties) ? schema.additionalProperties : undefined;

	const normalized: Record<string, unknown> = {};

	for (const [rawKey, rawEntry] of Object.entries(value)) {
		let nextKey = rawKey;
		if (rawKey.startsWith(".")) {
			const candidateKey = rawKey.slice(1);
			if (candidateKey && hasOwn(schemaProperties, candidateKey)) {
				if (hasOwn(value, candidateKey) || hasOwn(normalized, candidateKey)) {
					continue;
				}
				nextKey = candidateKey;
			}
		}

		const childSchema = hasOwn(schemaProperties, nextKey) ? schemaProperties[nextKey] : additionalProperties;
		normalized[nextKey] = normalizeArgumentsForSchema(rawEntry, childSchema);
	}

	return normalized;
}

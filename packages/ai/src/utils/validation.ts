import AjvModule from "ajv";
import addFormatsModule from "ajv-formats";

// Handle both default and named exports
const Ajv = (AjvModule as any).default || AjvModule;
const addFormats = (addFormatsModule as any).default || addFormatsModule;

import type { Tool, ToolCall } from "../types.js";

// Detect if we're in a browser extension environment with strict CSP
// Chrome extensions with Manifest V3 don't allow eval/Function constructor
const isBrowserExtension = typeof globalThis !== "undefined" && (globalThis as any).chrome?.runtime?.id !== undefined;

// Create a singleton AJV instance with formats (only if not in browser extension)
// AJV requires 'unsafe-eval' CSP which is not allowed in Manifest V3
let ajv: any = null;
if (!isBrowserExtension) {
	try {
		ajv = new Ajv({
			allErrors: true,
			strict: false,
		});
		addFormats(ajv);
	} catch (e) {
		// AJV initialization failed (likely CSP restriction)
		console.warn("AJV validation disabled due to CSP restrictions");
	}
}

/**
 * Validates tool call arguments against the tool's TypeBox schema
 * @param tool The tool definition with TypeBox schema
 * @param toolCall The tool call from the LLM
 * @returns The validated arguments
 * @throws Error with formatted message if validation fails
 */
export function validateToolArguments(tool: Tool, toolCall: ToolCall): any {
	// Skip validation in browser extension environment (CSP restrictions prevent AJV from working)
	if (!ajv || isBrowserExtension) {
		// Trust the LLM's output without validation
		// Browser extensions can't use AJV due to Manifest V3 CSP restrictions
		return toolCall.arguments;
	}

	// Compile the schema
	const validate = ajv.compile(tool.parameters);

	// Validate the arguments
	if (validate(toolCall.arguments)) {
		return toolCall.arguments;
	}

	// Format validation errors nicely
	const errors =
		validate.errors
			?.map((err: any) => {
				const path = err.instancePath ? err.instancePath.substring(1) : err.params.missingProperty || "root";
				return `  - ${path}: ${err.message}`;
			})
			.join("\n") || "Unknown validation error";

	// Extract schema info to help the model self-correct
	const schema = tool.parameters as Record<string, unknown>;
	const schemaInfo = formatSchemaInfo(schema);

	// Truncate arguments if too large (e.g., write_file with big content)
	const argsStr = JSON.stringify(toolCall.arguments, null, 2);
	const maxArgsLength = 2000;
	const truncatedArgs =
		argsStr.length > maxArgsLength
			? `${argsStr.substring(0, maxArgsLength)}...\n[truncated, ${argsStr.length - maxArgsLength} more chars]`
			: argsStr;

	const errorMessage = `Validation failed for tool "${toolCall.name}":\n${errors}\n\n${schemaInfo}\nReceived arguments:\n${truncatedArgs}\n\nPlease correct the arguments and try again.`;

	throw new Error(errorMessage);
}

/**
 * Format schema information for error messages to help models self-correct
 */
function formatSchemaInfo(schema: Record<string, unknown>): string {
	const lines: string[] = ["Expected schema:"];

	// Extract properties
	if (schema.properties && typeof schema.properties === "object") {
		lines.push("  Properties:");
		for (const [key, value] of Object.entries(schema.properties as Record<string, unknown>)) {
			const prop = value as Record<string, unknown>;
			const typeInfo = prop.type || (prop.enum ? `enum(${(prop.enum as unknown[]).join("|")})` : "unknown");
			const description = prop.description ? ` - ${prop.description}` : "";
			lines.push(`    ${key}: ${typeInfo}${description}`);
		}
	}

	// Extract required fields
	if (Array.isArray(schema.required) && schema.required.length > 0) {
		lines.push(`  Required: [${(schema.required as string[]).join(", ")}]`);
	}

	return lines.join("\n");
}

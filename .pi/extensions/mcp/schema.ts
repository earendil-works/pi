import { Type, type TSchema } from "typebox";

/** Wrap a raw MCP JSON Schema object as a TypeBox TSchema for pi tool registration. */
export function wrapSchema(inputSchema: Record<string, unknown>): TSchema {
	const schema = Object.keys(inputSchema).length > 0 ? inputSchema : { type: "object", properties: {} };
	return Type.Unsafe<Record<string, unknown>>(schema);
}

interface JsonSchemaObject {
	type?: string;
	properties?: Record<string, unknown>;
	required?: string[];
}

/** Validate params against the raw MCP JSON Schema. Returns errors for missing required fields and wrong root type. */
export function validateParams(
	inputSchema: Record<string, unknown>,
	params: unknown,
): { valid: boolean; errors: string[] } {
	const errors: string[] = [];
	const schema = inputSchema as JsonSchemaObject;

	if (schema.type === "object" || schema.properties !== undefined || schema.required !== undefined) {
		if (typeof params !== "object" || params === null || Array.isArray(params)) {
			errors.push(`Expected an object, got ${Array.isArray(params) ? "array" : typeof params}`);
			return { valid: false, errors };
		}
		const paramObj = params as Record<string, unknown>;
		for (const field of schema.required ?? []) {
			if (!(field in paramObj)) {
				errors.push(`Missing required field: "${field}"`);
			}
		}
	}

	return { valid: errors.length === 0, errors };
}

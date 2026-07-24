import type { TSchema } from "typebox";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function visitJsonSchema(schema: unknown): void {
	if (!isRecord(schema)) return;

	const properties = schema.properties;
	if (schema.type === "object" || isRecord(properties)) {
		if (!Array.isArray(schema.required)) {
			schema.required = [];
		}
	}

	if (isRecord(properties)) {
		for (const value of Object.values(properties)) {
			visitJsonSchema(value);
		}
	}

	for (const key of ["items", "additionalProperties", "contains", "not", "if", "then", "else"] as const) {
		visitJsonSchema(schema[key]);
	}

	for (const key of ["anyOf", "oneOf", "allOf"] as const) {
		const variants = schema[key];
		if (!Array.isArray(variants)) continue;
		for (const variant of variants) {
			visitJsonSchema(variant);
		}
	}

	for (const key of ["$defs", "definitions"] as const) {
		const definitions = schema[key];
		if (!isRecord(definitions)) continue;
		for (const value of Object.values(definitions)) {
			visitJsonSchema(value);
		}
	}
}

/**
 * Normalize JSON Schema object `required` fields for OpenAI-compatible tool schemas.
 *
 * TypeBox omits `required` when every property is optional. Some OpenAI-compatible
 * gateways serialize or validate that missing field as `null`, while the OpenAI
 * function schema shape expects `required` to be an array. Missing and empty
 * `required` are equivalent in JSON Schema, so emit an explicit empty array for
 * object schemas without required properties.
 */
export function normalizeOpenAIToolParameters(parameters: TSchema): Record<string, unknown> {
	const normalized = structuredClone(parameters) as Record<string, unknown>;
	visitJsonSchema(normalized);
	return normalized;
}

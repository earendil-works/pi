/**
 * Normalizes JSON Schemas before they are forwarded to strict OpenAI-compatible
 * providers.
 *
 * TypeBox omits `required` entirely for object schemas whose top-level
 * properties are all optional. Some strict OpenAI-compatible endpoints reject
 * such function schemas with errors like:
 *
 *   400: Invalid schema for function 'mcp': null is not of type "array"
 *
 * because they expect `required` to be an array. This normalizer guarantees a
 * valid `required` array on every object schema so those providers accept the
 * tool definitions consistently. See earendil-works/pi#7010.
 */

/** Schema container keys whose values are themselves schemas. */
const SCHEMA_VALUE_KEYS = ["items", "additionalProperties", "not", "if", "then", "else"];
/** Schema container keys whose values are arrays of schemas. */
const SCHEMA_ARRAY_KEYS = ["anyOf", "oneOf", "allOf", "prefixItems"];
/** Schema container keys whose values are maps of name -> schema. */
const SCHEMA_MAP_KEYS = ["properties", "$defs", "definitions", "patternProperties"];

type JsonSchema = Record<string, unknown>;

function isSchemaObject(value: unknown): value is JsonSchema {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalize(schema: unknown): unknown {
	if (Array.isArray(schema)) {
		return schema.map(normalize);
	}
	if (!isSchemaObject(schema)) {
		return schema;
	}

	const result: JsonSchema = { ...schema };

	// An object schema must carry a `required` array. TypeBox omits it when all
	// properties are optional; some providers send `null`. Normalize both.
	if (result.type === "object" && (result.required === undefined || result.required === null)) {
		result.required = [];
	}

	for (const key of SCHEMA_VALUE_KEYS) {
		if (key in result && isSchemaObject(result[key])) {
			result[key] = normalize(result[key]);
		}
	}
	for (const key of SCHEMA_ARRAY_KEYS) {
		if (Array.isArray(result[key])) {
			result[key] = (result[key] as unknown[]).map(normalize);
		}
	}
	for (const key of SCHEMA_MAP_KEYS) {
		if (isSchemaObject(result[key])) {
			const source = result[key] as JsonSchema;
			const normalized: JsonSchema = {};
			for (const name of Object.keys(source)) {
				normalized[name] = normalize(source[name]);
			}
			result[key] = normalized;
		}
	}

	return result;
}

/**
 * Returns a deep copy of a tool `parameters` JSON Schema with `required`
 * normalized to an array on every object schema. The input is not mutated.
 */
export function normalizeToolSchemaForOpenAI(schema: unknown): unknown {
	return normalize(schema);
}

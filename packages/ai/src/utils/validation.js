import AjvModule from "ajv";
import addFormatsModule from "ajv-formats";

// Handle both default and named exports
const Ajv = AjvModule.default || AjvModule;
const addFormats = addFormatsModule.default || addFormatsModule;
// Detect if we're in a browser extension environment with strict CSP
// Chrome extensions with Manifest V3 don't allow eval/Function constructor
const isBrowserExtension = typeof globalThis !== "undefined" && globalThis.chrome?.runtime?.id !== undefined;
// Create a singleton AJV instance with formats (only if not in browser extension)
// AJV requires 'unsafe-eval' CSP which is not allowed in Manifest V3
let ajv = null;
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
export function validateToolArguments(tool, toolCall) {
	// Skip validation in browser extension environment (CSP restrictions prevent AJV from working)
	if (!ajv || isBrowserExtension) {
		// Trust the LLM's output without validation
		// Browser extensions can't use AJV due to Manifest V3 CSP restrictions
		return toolCall.arguments;
	}
	// Coerce string-encoded nested objects before validation.
	// Some providers (e.g., synthetic HuggingFace TGI) serialize object-valued
	// parameters as JSON strings instead of JSON objects. This step transparently
	// repairs those before AJV sees them, so the model doesn't get stuck in a
	// "must be object" retry loop.
	const coerced = coerceStringEncodedObjects(toolCall.arguments, tool.parameters);
	// Compile the schema
	const validate = ajv.compile(tool.parameters);
	// Validate the arguments
	if (validate(coerced)) {
		return coerced;
	}
	// Format validation errors nicely
	const errors =
		validate.errors
			?.map((err) => {
				const path = err.instancePath ? err.instancePath.substring(1) : err.params.missingProperty || "root";
				return `  - ${path}: ${err.message}`;
			})
			.join("\n") || "Unknown validation error";
	// Extract schema info to help the model self-correct
	const schema = tool.parameters;
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
 * Check if a JSON Schema node expects values of a given type.
 * Handles both direct `type` declarations and `anyOf` unions.
 */
function schemaExpectsType(schema, targetType) {
	if (schema.type === targetType) return true;
	if (Array.isArray(schema.anyOf)) {
		return schema.anyOf.some(
			(member) => typeof member === "object" && member !== null && schemaExpectsType(member, targetType),
		);
	}
	return false;
}
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
export function coerceStringEncodedObjects(args, schema) {
	if (!args || typeof args !== "object") return args;
	if (!schema || typeof schema !== "object") return args;
	const result = { ...args };
	const properties = schema.properties;
	if (!properties) return result;
	for (const [key, propSchema] of Object.entries(properties)) {
		if (!(key in result)) continue;
		const value = result[key];
		const ps = propSchema;
		// Coerce string → object when schema expects object (or union of objects)
		if (schemaExpectsType(ps, "object") && typeof value === "string") {
			const parsed = tryParseJsonObject(value);
			if (parsed !== undefined) {
				result[key] = parsed;
			}
		}
		// Recurse into nested objects
		if (
			typeof value === "object" &&
			value !== null &&
			!Array.isArray(value) &&
			ps.type === "object" &&
			ps.properties
		) {
			result[key] = coerceStringEncodedObjects(value, ps);
		}
		// Recurse into array items
		if (Array.isArray(value) && ps.type === "array" && ps.items) {
			const itemSchema = ps.items;
			const expectsObjectItem = schemaExpectsType(itemSchema, "object");
			result[key] = value.map((item) => {
				// Coerce string → object for array items when items schema expects object
				if (expectsObjectItem && typeof item === "string") {
					const parsed = tryParseJsonObject(item);
					if (parsed !== undefined) return parsed;
				}
				// Recurse into object array items
				if (typeof item === "object" && item !== null && !Array.isArray(item) && itemSchema.properties) {
					return coerceStringEncodedObjects(item, itemSchema);
				}
				return item;
			});
		}
	}
	return result;
}
/**
 * Try to JSON-parse a string into an object. Returns `undefined` if the
 * string is not valid JSON or does not parse to a non-null object.
 */
function tryParseJsonObject(value) {
	try {
		const parsed = JSON.parse(value);
		if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
			return parsed;
		}
		return undefined;
	} catch {
		return undefined;
	}
}
/**
 * Format schema information for error messages to help models self-correct.
 * Handles simple types, enums, anyOf/union types, and array-of-object types.
 */
export function formatSchemaInfo(schema) {
	const lines = ["Expected schema:"];
	// Extract properties
	if (schema.properties && typeof schema.properties === "object") {
		lines.push("  Properties:");
		for (const [key, value] of Object.entries(schema.properties)) {
			const prop = value;
			const typeInfo = describeSchemaType(prop);
			const description = prop.description ? ` - ${prop.description}` : "";
			lines.push(`    ${key}: ${typeInfo}${description}`);
		}
	}
	// Extract required fields
	if (Array.isArray(schema.required) && schema.required.length > 0) {
		lines.push(`  Required: [${schema.required.join(", ")}]`);
	}
	return lines.join("\n");
}
/**
 * Describe a schema node's type in a human-readable way for error messages.
 * Handles anyOf (union), enum, array-with-items, and simple types.
 */
function describeSchemaType(prop) {
	// Handle anyOf (union types) — include discriminator hints for object variants
	if (Array.isArray(prop.anyOf)) {
		const variants = prop.anyOf.map((v) => describeUnionVariant(v));
		return `oneOf(${variants.join(" | ")})`;
	}
	// Handle enum-typed strings
	if (prop.enum && Array.isArray(prop.enum)) {
		return `enum(${prop.enum.join("|")})`;
	}
	// Handle arrays with described items
	if (prop.type === "array" && prop.items && typeof prop.items === "object") {
		const itemType = describeSchemaType(prop.items);
		const constraints = [];
		if (typeof prop.minItems === "number") constraints.push(`minItems: ${prop.minItems}`);
		if (typeof prop.maxItems === "number") constraints.push(`maxItems: ${prop.maxItems}`);
		const constraintStr = constraints.length > 0 ? ` {${constraints.join(", ")}}` : "";
		return `array<${itemType}>${constraintStr}`;
	}
	// Simple type
	if (prop.type) {
		return String(prop.type);
	}
	return "unknown";
}
/**
 * Describe a single variant within an anyOf union, including discriminator
 * hints when the variant is an object with an enum-typed "type" field.
 * e.g. `object{type: "mission"}` instead of just `object`.
 */
function describeUnionVariant(variant) {
	if (variant.type === "object" && typeof variant.properties === "object") {
		const props = variant.properties;
		const typeProp = props.type;
		// If there's a "type" field with enum values, use those as discriminators
		if (typeProp && Array.isArray(typeProp.enum) && typeProp.enum.length > 0) {
			const disc = typeProp.enum.join("|");
			return `object{type: ${disc}}`;
		}
		// If there's a "type" field with a const value
		if (typeProp && typeof typeProp.const === "string") {
			return `object{type: "${typeProp.const}"}`;
		}
		return "object";
	}
	return describeSchemaType(variant);
}
//# sourceMappingURL=validation.js.map

import type { TSchema, TUnsafe } from "@sinclair/typebox";
import { Type } from "@sinclair/typebox";

/**
 * Creates a string enum schema compatible with Google's API and other providers
 * that don't support anyOf/const patterns.
 *
 * @example
 * const OperationSchema = StringEnum(["add", "subtract", "multiply", "divide"], {
 *   description: "The operation to perform"
 * });
 *
 * type Operation = Static<typeof OperationSchema>; // "add" | "subtract" | "multiply" | "divide"
 */
export function StringEnum<T extends readonly string[]>(
	values: T,
	options?: { description?: string; default?: T[number] },
): TUnsafe<T[number]> {
	return Type.Unsafe<T[number]>({
		type: "string",
		enum: values as any,
		...(options?.description && { description: options.description }),
		...(options?.default && { default: options.default }),
	});
}

/**
 * Validation error for tool schemas that are incompatible with Google's API.
 */
export interface SchemaValidationError {
	path: string;
	message: string;
}

/**
 * Validates a tool schema for Google API compatibility.
 *
 * Google's Generative AI API doesn't support certain JSON Schema features:
 * - `const` keyword (used by TypeBox for Type.Literal)
 * - `anyOf` with `const` values (used by TypeBox for Type.Union([Type.Literal(...)]))
 *
 * Use `StringEnum` instead of `Type.Union([Type.Literal(...)])` for string enums.
 *
 * @example
 * // In a test file:
 * import { validateToolSchema } from '@kennyfrc/mu-ai';
 * import { myTool } from './tools/my-tool.js';
 *
 * test('tool schema is Google-compatible', () => {
 *   const errors = validateToolSchema(myTool.parameters);
 *   expect(errors).toEqual([]);
 * });
 *
 * @returns Array of validation errors. Empty array if schema is valid.
 */
export function validateToolSchema(schema: TSchema, path = ""): SchemaValidationError[] {
	const errors: SchemaValidationError[] = [];

	if (typeof schema !== "object" || schema === null) {
		return errors;
	}

	const record = schema as Record<string, unknown>;

	// Check for 'const' keyword (Google doesn't support it)
	if ("const" in record) {
		errors.push({
			path: path || "(root)",
			message: `Found 'const' keyword which Google API doesn't support. Use StringEnum instead of Type.Literal.`,
		});
	}

	// Check for anyOf with const values (Type.Union([Type.Literal(...)]) pattern)
	if (Array.isArray(record.anyOf)) {
		const hasConst = record.anyOf.some((item) => typeof item === "object" && item !== null && "const" in item);
		if (hasConst) {
			errors.push({
				path: path || "(root)",
				message: `Found 'anyOf' with 'const' values which Google API doesn't support. Use StringEnum instead of Type.Union([Type.Literal(...)]).`,
			});
		}
		// Recurse into anyOf items
		for (let i = 0; i < record.anyOf.length; i++) {
			errors.push(...validateToolSchema(record.anyOf[i] as TSchema, `${path}.anyOf[${i}]`));
		}
	}

	// Recurse into properties
	if (typeof record.properties === "object" && record.properties !== null) {
		for (const [key, value] of Object.entries(record.properties)) {
			errors.push(...validateToolSchema(value as TSchema, `${path}.properties.${key}`));
		}
	}

	// Recurse into items (for arrays)
	if (typeof record.items === "object" && record.items !== null) {
		errors.push(...validateToolSchema(record.items as TSchema, `${path}.items`));
	}

	// Recurse into additionalProperties
	if (typeof record.additionalProperties === "object" && record.additionalProperties !== null) {
		errors.push(...validateToolSchema(record.additionalProperties as TSchema, `${path}.additionalProperties`));
	}

	return errors;
}

/**
 * Validates all tools in an array for Google API compatibility.
 *
 * @example
 * import { validateToolSchemas } from '@kennyfrc/mu-ai';
 * import { codingTools } from './tools/index.js';
 *
 * test('all tools are Google-compatible', () => {
 *   const errors = validateToolSchemas(codingTools);
 *   if (errors.length > 0) {
 *     console.error('Schema validation errors:', errors);
 *   }
 *   expect(errors).toEqual([]);
 * });
 *
 * @returns Array of validation errors with tool names. Empty array if all schemas are valid.
 */
export function validateToolSchemas(
	tools: Array<{ name: string; parameters: TSchema }>,
): Array<SchemaValidationError & { toolName: string }> {
	const allErrors: Array<SchemaValidationError & { toolName: string }> = [];

	for (const tool of tools) {
		const errors = validateToolSchema(tool.parameters);
		for (const error of errors) {
			allErrors.push({ ...error, toolName: tool.name });
		}
	}

	return allErrors;
}

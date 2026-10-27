import { toCodemodeIdentifier } from "./identifier.ts";

export { toCodemodeIdentifier };

import type { CodemodeJsonSchema, CodemodeTool } from "./types.ts";

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const INDENT = "  ";
/** Largest rendered input type, in characters, before it becomes `unknown`. */
export const DEFAULT_INPUT_SCHEMA_MAX_CHARS = 16_000;
/** Local `$ref` expansions per rendered schema, so shared definitions cannot blow up the output. */
const MAX_REF_EXPANSIONS = 32;
/** JSON Schema keywords with a number or string value shown as `@keyword value` property tags. */
const TAG_KEYWORDS = [
	"minimum",
	"exclusiveMinimum",
	"maximum",
	"exclusiveMaximum",
	"multipleOf",
	"minLength",
	"maxLength",
	"pattern",
	"format",
	"minItems",
	"maxItems",
];
/** Tag keywords whose values all hold at once, so only the largest (lower) or smallest (upper) matters. */
const LOWER_BOUNDS = new Set(["minimum", "exclusiveMinimum", "minLength", "minItems"]);
const UPPER_BOUNDS = new Set(["maximum", "exclusiveMaximum", "maxLength", "maxItems"]);
/** Longest property tag; longer ones (large defaults, long patterns) are left out. */
const MAX_TAG_CHARS = 80;
/** Characters that end a `//` comment. */
const LINE_TERMINATORS = /[\r\n\u2028\u2029]/g;

export interface RenderDeclarationsOptions {
	tools?: readonly CodemodeTool[];
	globals?: readonly CodemodeTool[];
}

/**
 * Render TypeScript declarations for the script-visible API. Tools become members of
 * `declare const tools`, globals become `declare function` statements, and `ns.member` globals
 * members of `declare const ns`. Descriptions become doc comments; schemas become types.
 */
export function renderDeclarations(options: RenderDeclarationsOptions): string {
	const sections: string[] = [];
	const tools = options.tools ?? [];
	if (tools.length > 0) {
		const members = tools.map(
			(tool) => `${docComment(tool.description, INDENT)}${INDENT}${renderToolSignature(tool)}`,
		);
		sections.push(`declare const tools: {\n${members.join("\n")}\n};`);
	}
	const namespaces = new Map<string, string[]>();
	for (const global of options.globals ?? []) {
		const dot = global.name.indexOf(".");
		if (dot === -1) {
			sections.push(renderGlobal(`declare function ${global.name}`, global, ""));
			continue;
		}
		const namespace = global.name.slice(0, dot);
		const members = namespaces.get(namespace) ?? [];
		if (members.length === 0) namespaces.set(namespace, members);
		members.push(renderGlobal(global.name.slice(dot + 1), global, INDENT));
	}
	for (const [namespace, members] of namespaces) {
		sections.push(`declare const ${namespace}: {\n${members.join("\n")}\n};`);
	}
	return sections.join("\n\n");
}

/**
 * One tool as a member of the `tools` object: `name(args: T): Promise<R>;` with the
 * name as the identifier scripts use. Input types longer than `inputMaxChars` render as `unknown`.
 */
export function renderToolSignature(
	tool: Pick<CodemodeTool, "name" | "inputSchema" | "outputSchema">,
	options: { inputMaxChars?: number } = {},
): string {
	const input =
		tool.inputSchema === undefined
			? "unknown"
			: schemaToType(tool.inputSchema, { maxChars: options.inputMaxChars ?? DEFAULT_INPUT_SCHEMA_MAX_CHARS });
	return `${toCodemodeIdentifier(tool.name)}(args: ${input}): Promise<${renderToolOutputType(tool.outputSchema)}>;`;
}

/**
 * A tool's sample: the description followed by the tool's declaration. Used for tool
 * listings and `ALL_TOOLS` entries.
 */
export function renderToolSample(
	tool: Pick<CodemodeTool, "name" | "description" | "inputSchema" | "outputSchema">,
	options: { inputMaxChars?: number } = {},
): string {
	const declaration = `declare const tools: { ${renderToolSignature(tool, options)} };`;
	return `${tool.description?.trim() ?? ""}\n\ncodemode tool declaration:\n\`\`\`ts\n${declaration}\n\`\`\``;
}

/** The type a tool call resolves to: the output schema's type, and `unknown` without a schema. */
export function renderToolOutputType(schema: CodemodeJsonSchema | undefined): string {
	return schema === undefined ? "unknown" : schemaToType(schema);
}

function renderGlobal(head: string, global: CodemodeTool, indent: string): string {
	if (global.signature !== undefined) {
		return `${docComment(global.description, indent)}${indent}${head}${global.signature};`;
	}
	const input = global.inputSchema === undefined ? "unknown" : schemaToType(global.inputSchema);
	const output = global.outputSchema === undefined ? "unknown" : schemaToType(global.outputSchema);
	return `${docComment(global.description, indent)}${indent}${head}(args: ${input}): Promise<${output}>;`;
}

function docComment(description: string | undefined, indent: string): string {
	const text = description?.trim();
	if (!text) return "";
	const lines = text.replaceAll("*/", "*\\/").split(/\r?\n/);
	if (lines.length === 1) return `${indent}/** ${lines[0]} */\n`;
	return `${indent}/**\n${lines.map((line) => `${indent} *${line ? ` ${line}` : ""}`).join("\n")}\n${indent} */\n`;
}

function propertyKey(name: string): string {
	return IDENTIFIER.test(name) ? name : JSON.stringify(name);
}

function union(types: string[]): string {
	const unique = [...new Set(types)];
	if (unique.includes("unknown")) return "unknown";
	return unique.length === 0 ? "never" : unique.join(" | ");
}

/**
 * Convert a JSON Schema to a TypeScript type expression: objects on one line (`{ a: string; b?: number; }`) with properties sorted by name,
 * or one property per line with `//` comments when a property has a description or constraints the
 * type cannot express (`// @integer @minimum 1 @default 20`); `Array<T>` for arrays. Local references
 * (`#/$defs/...`, `#/definitions/...`) resolve against `schema`; recursive and remote references
 * render as `unknown`. A result longer than `maxChars` is rendered again without the constraint tags,
 * and renders as `unknown` if it is still too long.
 */
export function schemaToType(schema: CodemodeJsonSchema, options: { maxChars?: number } = {}): string {
	const render = (tags: boolean) => toType(schema, { root: schema, resolving: new Set(), expansions: 0, tags });
	const type = render(true);
	if (options.maxChars === undefined || type.length <= options.maxChars) return type;
	const untagged = render(false);
	return untagged.length <= options.maxChars ? untagged : "unknown";
}

interface SchemaContext {
	root: CodemodeJsonSchema;
	/** References being expanded on the current path, to stop at recursive types. */
	resolving: Set<string>;
	expansions: number;
	/** Whether property comments include constraint tags. */
	tags: boolean;
}

function resolveRef(ref: string, root: CodemodeJsonSchema): CodemodeJsonSchema | undefined {
	if (ref !== "#" && !ref.startsWith("#/")) return undefined;
	let current: unknown = root;
	for (const segment of ref.slice(2).split("/").filter(Boolean)) {
		const key = decodeURIComponent(segment).replaceAll("~1", "/").replaceAll("~0", "~");
		if (typeof current !== "object" || current === null || Array.isArray(current) || !(key in current)) {
			return undefined;
		}
		current = (current as Record<string, unknown>)[key];
	}
	if (typeof current === "boolean") return current;
	return typeof current === "object" && current !== null && !Array.isArray(current)
		? (current as Record<string, unknown>)
		: undefined;
}

function toType(schema: CodemodeJsonSchema, context: SchemaContext): string {
	if (schema === true) return "unknown";
	if (schema === false) return "never";
	if (typeof schema !== "object" || schema === null || Array.isArray(schema)) return "unknown";
	if (typeof schema.$ref === "string") {
		const ref = schema.$ref;
		if (context.resolving.has(ref) || context.expansions >= MAX_REF_EXPANSIONS) return "unknown";
		const target = resolveRef(ref, context.root);
		if (target === undefined) return "unknown";
		context.expansions++;
		context.resolving.add(ref);
		try {
			return toType(target, context);
		} finally {
			context.resolving.delete(ref);
		}
	}

	if ("const" in schema) return JSON.stringify(schema.const) ?? "unknown";
	if (Array.isArray(schema.enum)) return union(schema.enum.map((value) => JSON.stringify(value) ?? "unknown"));

	const variants = Array.isArray(schema.anyOf) ? schema.anyOf : Array.isArray(schema.oneOf) ? schema.oneOf : undefined;
	if (variants) return union(variants.map((variant) => toType(variant as CodemodeJsonSchema, context)));
	if (Array.isArray(schema.allOf)) {
		const parts = schema.allOf
			.map((part) => toType(part as CodemodeJsonSchema, context))
			.filter((part) => part !== "unknown");
		return parts.length === 0
			? "unknown"
			: parts.map((part) => (part.includes(" | ") ? `(${part})` : part)).join(" & ");
	}

	const type = schema.type;
	if (Array.isArray(type)) return union(type.map((entry) => toType({ ...schema, type: entry }, context)));
	switch (type) {
		case "string":
			return "string";
		case "number":
		case "integer":
			return "number";
		case "boolean":
			return "boolean";
		case "null":
			return "null";
		case "array":
			return arrayType(schema, context);
		case "object":
			return objectType(schema, context);
		case undefined:
			if ("properties" in schema || "additionalProperties" in schema || "required" in schema) {
				return objectType(schema, context);
			}
			if ("items" in schema || "prefixItems" in schema) return arrayType(schema, context);
			return "unknown";
		default:
			return "unknown";
	}
}

function arrayType(schema: Record<string, unknown>, context: SchemaContext): string {
	if (schema.items !== undefined && !Array.isArray(schema.items)) {
		return `Array<${toType(schema.items as CodemodeJsonSchema, context)}>`;
	}
	const tuple = Array.isArray(schema.prefixItems)
		? schema.prefixItems
		: Array.isArray(schema.items)
			? schema.items
			: [];
	if (tuple.length > 0) return `[${tuple.map((item) => toType(item as CodemodeJsonSchema, context)).join(", ")}]`;
	return "unknown[]";
}

function descriptionOf(property: unknown): string {
	const description = (property as { description?: unknown } | null | undefined)?.description;
	return typeof description === "string" ? description.trim() : "";
}

/**
 * Constraints of a property that its TypeScript type cannot express, as JSDoc-style tags:
 * `@integer @minimum 1 @maximum 100 @default 20`. Empty when there are none.
 */
function constraintTags(schema: unknown): string {
	if (typeof schema !== "object" || schema === null || Array.isArray(schema)) return "";
	const property = schema as Record<string, unknown>;
	// Optional fields such as Pydantic's `int | None` keep their constraints in the non-null branch.
	// The branch's constraints apply together with the property's, so both are read.
	const variants = Array.isArray(property.anyOf) ? property.anyOf : property.oneOf;
	const nonNull: unknown[] = Array.isArray(variants)
		? variants.filter((variant) => (variant as { type?: unknown } | null)?.type !== "null")
		: [];
	const branch = nonNull.length === 1 ? nonNull[0] : undefined;
	const branches =
		typeof branch === "object" && branch !== null && !Array.isArray(branch)
			? [property, branch as Record<string, unknown>]
			: [property];
	// Draft-04 and OpenAPI 3.0 make `minimum`/`maximum` exclusive with a boolean `exclusiveMinimum`/`exclusiveMaximum`.
	const schemas = branches.map(
		(schema): Record<string, unknown> => ({
			...schema,
			...(schema.exclusiveMinimum === true ? { minimum: undefined, exclusiveMinimum: schema.minimum } : {}),
			...(schema.exclusiveMaximum === true ? { maximum: undefined, exclusiveMaximum: schema.maximum } : {}),
		}),
	);

	const tags: string[] = [];
	const isInteger = (type: unknown) => type === "integer" || (Array.isArray(type) && type.includes("integer"));
	if (schemas.some((schema) => isInteger(schema.type))) tags.push("@integer");
	for (const keyword of TAG_KEYWORDS) {
		const values = schemas.map((schema) => schema[keyword]);
		if (LOWER_BOUNDS.has(keyword) || UPPER_BOUNDS.has(keyword)) {
			const numbers = values.filter((value) => typeof value === "number");
			if (numbers.length === 0) continue;
			tags.push(`@${keyword} ${LOWER_BOUNDS.has(keyword) ? Math.max(...numbers) : Math.min(...numbers)}`);
			continue;
		}
		for (const value of new Set(values)) {
			if (typeof value === "number" || typeof value === "string") tags.push(`@${keyword} ${value}`);
		}
	}
	if (schemas.some((schema) => schema.uniqueItems === true)) tags.push("@uniqueItems");
	// Annotations, unlike constraints, come from the property itself.
	if (property.default !== undefined && property.default !== null) {
		tags.push(`@default ${JSON.stringify(property.default)}`);
	}
	if (property.deprecated === true) tags.push("@deprecated");
	return tags
		.filter((tag) => tag.length <= MAX_TAG_CHARS)
		.map((tag) => tag.replace(LINE_TERMINATORS, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`))
		.join(" ");
}

function objectType(schema: Record<string, unknown>, context: SchemaContext): string {
	const properties =
		typeof schema.properties === "object" && schema.properties !== null && !Array.isArray(schema.properties)
			? (schema.properties as Record<string, unknown>)
			: {};
	const required = new Set(Array.isArray(schema.required) ? schema.required : []);
	const names = Object.keys(properties).sort();
	const members = names.map((name) => {
		const optional = required.has(name) ? "" : "?";
		return `${propertyKey(name)}${optional}: ${toType(properties[name] as CodemodeJsonSchema, context)};`;
	});
	const additional = schema.additionalProperties;
	if (additional !== undefined && additional !== false) {
		const type = additional === true ? "unknown" : toType(additional as CodemodeJsonSchema, context);
		members.push(`[key: string]: ${type};`);
	} else if (additional === undefined && names.length === 0) {
		members.push("[key: string]: unknown;");
	}
	if (members.length === 0) return "{}";
	const comments = names.map((name) => {
		const lines = descriptionOf(properties[name])
			.split(LINE_TERMINATORS)
			.map((line) => line.trim())
			.filter(Boolean);
		const tags = context.tags ? constraintTags(properties[name]) : "";
		return tags ? [...lines, tags] : lines;
	});
	if (!comments.some((comment) => comment.length > 0)) return `{ ${members.join(" ")} }`;

	const lines = ["{"];
	comments.forEach((comment, index) => {
		for (const line of comment) lines.push(`${INDENT}// ${line}`);
		lines.push(`${INDENT}${members[index].replaceAll("\n", `\n${INDENT}`)}`);
	});
	for (const member of members.slice(names.length)) lines.push(`${INDENT}${member}`);
	lines.push("}");
	return lines.join("\n");
}

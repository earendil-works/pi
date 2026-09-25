import type { CodemodeJsonSchema, CodemodeTool } from "./types.ts";

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const INDENT = "  ";

export interface RenderDeclarationsOptions {
	tools?: readonly CodemodeTool[];
	globals?: readonly CodemodeTool[];
}

/**
 * Render TypeScript declarations for the script-visible API, for use in a model-facing
 * description. Tools become members of `declare const tools`, globals become
 * `declare function` statements, and `ns.member` globals members of `declare const ns`. Descriptions become doc comments; schemas become types
 * (`unknown` where a schema is missing or uses features TypeScript cannot express, such as
 * `$ref`).
 *
 * ```ts
 * declare const tools: {
 *   /** Read a file. *\/
 *   read(args: {
 *     /** Path to the file *\/
 *     path: string;
 *     offset?: number;
 *   }): Promise<string>;
 * };
 * ```
 */
export function renderDeclarations(options: RenderDeclarationsOptions): string {
	const sections: string[] = [];
	const tools = options.tools ?? [];
	if (tools.length > 0) {
		const members = tools.map((tool) => renderFunction(propertyKey(tool.name), tool, INDENT));
		sections.push(`declare const tools: {\n${members.join("\n")}\n};`);
	}
	const namespaces = new Map<string, string[]>();
	for (const global of options.globals ?? []) {
		const dot = global.name.indexOf(".");
		if (dot === -1) {
			sections.push(renderFunction(`declare function ${global.name}`, global, ""));
			continue;
		}
		const namespace = global.name.slice(0, dot);
		const members = namespaces.get(namespace) ?? [];
		if (members.length === 0) namespaces.set(namespace, members);
		members.push(renderFunction(global.name.slice(dot + 1), global, INDENT));
	}
	for (const [namespace, members] of namespaces) {
		sections.push(`declare const ${namespace}: {\n${members.join("\n")}\n};`);
	}
	return sections.join("\n\n");
}

function renderFunction(head: string, tool: CodemodeTool, indent: string): string {
	if (tool.signature !== undefined) return `${docComment(tool.description, indent)}${indent}${head}${tool.signature};`;
	const input = tool.inputSchema === undefined ? "unknown" : schemaToType(tool.inputSchema, indent);
	const output = tool.outputSchema === undefined ? "unknown" : schemaToType(tool.outputSchema, indent);
	const optional = input === "unknown" || isEmptyObjectSchema(tool.inputSchema) ? "?" : "";
	return `${docComment(tool.description, indent)}${indent}${head}(args${optional}: ${input}): Promise<${output}>;`;
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

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isEmptyObjectSchema(schema: CodemodeJsonSchema | undefined): boolean {
	if (!isObject(schema) || schema.type !== "object") return false;
	const properties = schema.properties;
	return (!isObject(properties) || Object.keys(properties).length === 0) && !isObject(schema.additionalProperties);
}

/** Wrap unions and intersections so they can be used as array element types. */
function asElement(type: string): string {
	return /^[\w$.<>[\]"']+$/.test(type) || type.startsWith("{") ? type : `(${type})`;
}

function union(types: string[]): string {
	const unique = [...new Set(types)];
	if (unique.includes("unknown")) return "unknown";
	return unique.length === 0 ? "never" : unique.join(" | ");
}

/**
 * Convert a JSON Schema to a TypeScript type expression. `indent` is the indentation of the line
 * the type starts on; nested object members are indented one level deeper.
 */
export function schemaToType(schema: CodemodeJsonSchema, indent = ""): string {
	if (schema === true) return "unknown";
	if (schema === false) return "never";
	if (!isObject(schema)) return "unknown";
	if (typeof schema.$ref === "string") return "unknown";

	if ("const" in schema) return JSON.stringify(schema.const) ?? "unknown";
	if (Array.isArray(schema.enum)) return union(schema.enum.map((value) => JSON.stringify(value) ?? "unknown"));

	const variants = Array.isArray(schema.anyOf) ? schema.anyOf : Array.isArray(schema.oneOf) ? schema.oneOf : undefined;
	if (variants) return union(variants.map((variant) => schemaToType(variant as CodemodeJsonSchema, indent)));
	if (Array.isArray(schema.allOf)) {
		const parts = schema.allOf.map((part) => schemaToType(part as CodemodeJsonSchema, indent));
		const meaningful = parts.filter((part) => part !== "unknown");
		return meaningful.length === 0 ? "unknown" : meaningful.map(asElement).join(" & ");
	}

	const type = schema.type;
	if (Array.isArray(type)) {
		return union(type.map((entry) => schemaToType({ ...schema, type: entry }, indent)));
	}
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
			return arrayType(schema, indent);
		case "object":
			return objectType(schema, indent);
		case undefined:
			if (isObject(schema.properties) || isObject(schema.additionalProperties)) return objectType(schema, indent);
			if (schema.items !== undefined || schema.prefixItems !== undefined) return arrayType(schema, indent);
			return "unknown";
		default:
			return "unknown";
	}
}

function arrayType(schema: Record<string, unknown>, indent: string): string {
	const tuple = Array.isArray(schema.prefixItems)
		? schema.prefixItems
		: Array.isArray(schema.items)
			? schema.items
			: [];
	if (tuple.length > 0) {
		return `[${tuple.map((item) => schemaToType(item as CodemodeJsonSchema, indent)).join(", ")}]`;
	}
	const items = schema.items;
	if (items === undefined || Array.isArray(items)) return "unknown[]";
	return `${asElement(schemaToType(items as CodemodeJsonSchema, indent))}[]`;
}

function objectType(schema: Record<string, unknown>, indent: string): string {
	const properties = isObject(schema.properties) ? schema.properties : {};
	const required = new Set(Array.isArray(schema.required) ? schema.required : []);
	const additional = schema.additionalProperties;
	const inner = indent + INDENT;
	const members: string[] = [];
	for (const [name, property] of Object.entries(properties)) {
		const description = isObject(property) && typeof property.description === "string" ? property.description : "";
		const optional = required.has(name) ? "" : "?";
		const type = schemaToType(property as CodemodeJsonSchema, inner);
		members.push(`${docComment(description, inner)}${inner}${propertyKey(name)}${optional}: ${type};`);
	}
	if (additional !== undefined && additional !== false) {
		const type = additional === true ? "unknown" : schemaToType(additional as CodemodeJsonSchema, inner);
		members.push(`${inner}[key: string]: ${type};`);
	} else if (members.length === 0 && additional === undefined) {
		return "Record<string, unknown>";
	}
	if (members.length === 0) return "{}";
	return `{\n${members.join("\n")}\n${indent}}`;
}

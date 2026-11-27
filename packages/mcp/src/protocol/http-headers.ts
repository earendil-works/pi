// HTTP headers that MCP mirrors from the request body: `MCP-Protocol-Version`, and since 2026-07-28
// `Mcp-Method`, `Mcp-Name`, and `Mcp-Param-*` for tool arguments a tool's input schema marks with
// `x-mcp-header`.
import { isObject } from "./jsonrpc.ts";

/** The header naming the protocol version of a request. */
export const PROTOCOL_VERSION_HEADER = "MCP-Protocol-Version";

/** One tool argument mirrored into a header: the `properties` path to it and the header name part. */
export interface ToolHeaderBinding {
	path: string[];
	header: string;
}

/** A tool's header bindings, or why its `x-mcp-header` annotations are invalid. */
export type ToolHeaderBindings = { kind: "valid"; bindings: ToolHeaderBinding[] } | { kind: "invalid"; reason: string };

const HEADER_ANNOTATION = "x-mcp-header";
const BASE64_SENTINEL = /^=\?base64\?.*\?=$/s;
// RFC 9110 token characters.
const HEADER_TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const PRIMITIVE_TYPES = new Set(["string", "integer", "boolean"]);
// Input schemas come from the server; deeper nesting is not worth walking.
const MAX_SCHEMA_DEPTH = 64;
// Keywords whose values are instance data, not schemas, so an `x-mcp-header` key in them is no annotation.
const DATA_KEYWORDS = new Set(["const", "default", "enum", "examples"]);

/**
 * A header value for `value`: as is when it is plain ASCII without leading or trailing whitespace,
 * otherwise Base64 of its UTF-8 in the `=?base64?…?=` form. Values that look like that form are
 * encoded too, so they are not mistaken for it.
 */
export function encodeHeaderValue(value: string): string {
	let plain = value === value.trim() && !BASE64_SENTINEL.test(value);
	for (let i = 0; plain && i < value.length; i++) {
		const code = value.charCodeAt(i);
		plain = code >= 0x20 && code <= 0x7e;
	}
	return plain ? value : `=?base64?${Buffer.from(value, "utf8").toString("base64")}?=`;
}

/** `Mcp-Method`, and `Mcp-Name` for the methods that name a tool, prompt, or resource. */
export function standardRequestHeaders(method: string, params: unknown): Record<string, string> {
	const headers: Record<string, string> = { "Mcp-Method": method };
	const name =
		method === "resources/read"
			? isObject(params) && params.uri
			: (method === "tools/call" || method === "prompts/get") && isObject(params) && params.name;
	if (typeof name === "string") headers["Mcp-Name"] = encodeHeaderValue(name);
	return headers;
}

/**
 * The arguments a tool mirrors into headers (wire input). Annotations are valid only on `string`,
 * `integer`, and `boolean` properties reached from the schema root through `properties` alone, with
 * non-empty token names that are unique ignoring case. Clients on HTTP exclude tools with an invalid
 * annotation.
 */
export function toolHeaderBindings(inputSchema: Record<string, unknown>): ToolHeaderBindings {
	const bindings: ToolHeaderBinding[] = [];
	const seen = new Set<string>();
	let problem: string | undefined;
	const visit = (schema: unknown, path: string[] | undefined, depth: number): void => {
		if (problem || depth > MAX_SCHEMA_DEPTH) return;
		if (Array.isArray(schema)) {
			for (const item of schema) visit(item, undefined, depth + 1);
			return;
		}
		if (!isObject(schema)) return;
		if (HEADER_ANNOTATION in schema) {
			if (!path) {
				problem = `${HEADER_ANNOTATION} outside of nested properties`;
				return;
			}
			const annotation = readAnnotation(schema, seen);
			if (annotation.kind === "invalid") {
				problem = annotation.reason;
				return;
			}
			seen.add(annotation.header.toLowerCase());
			bindings.push({ path, header: annotation.header });
		}
		for (const [key, value] of Object.entries(schema)) {
			if (key === "properties" && path && isObject(value)) {
				for (const [name, property] of Object.entries(value)) visit(property, [...path, name], depth + 1);
			} else if (key !== HEADER_ANNOTATION && !DATA_KEYWORDS.has(key)) {
				visit(value, undefined, depth + 1);
			}
		}
	};
	if (isObject(inputSchema.properties)) {
		for (const [name, property] of Object.entries(inputSchema.properties)) visit(property, [name], 1);
	}
	for (const [key, value] of Object.entries(inputSchema)) {
		if (key === HEADER_ANNOTATION) problem ??= `${HEADER_ANNOTATION} on the schema root`;
		else if (key !== "properties" && !DATA_KEYWORDS.has(key)) visit(value, undefined, 1);
	}
	return problem ? { kind: "invalid", reason: problem } : { kind: "valid", bindings };
}

/** The header name of a property's annotation, or why the annotation is invalid. */
function readAnnotation(
	schema: Record<string, unknown>,
	seen: Set<string>,
): { kind: "valid"; header: string } | { kind: "invalid"; reason: string } {
	const header = schema[HEADER_ANNOTATION];
	const invalid = (reason: string) => ({ kind: "invalid" as const, reason: `${HEADER_ANNOTATION} ${reason}` });
	if (typeof header !== "string" || header === "") return invalid("must be a non-empty string");
	if (!HEADER_TOKEN.test(header)) return invalid(`"${header}" is not a valid header name`);
	if (seen.has(header.toLowerCase())) return invalid(`"${header}" is not unique`);
	const types = Array.isArray(schema.type) ? schema.type.filter((type) => type !== "null") : [schema.type];
	if (types.length !== 1 || typeof types[0] !== "string" || !PRIMITIVE_TYPES.has(types[0])) {
		return invalid(`"${header}" must be on a string, integer, or boolean property`);
	}
	return { kind: "valid", header };
}

/** `Mcp-Param-*` headers for a tool call. Arguments that are absent, null, or not primitive get no header. */
export function toolParamHeaders(
	bindings: readonly ToolHeaderBinding[],
	args: Record<string, unknown> | undefined,
): Record<string, string> {
	const headers: Record<string, string> = {};
	for (const { path, header } of bindings) {
		let value: unknown = args;
		for (const key of path) value = isObject(value) ? value[key] : undefined;
		const encoded = paramHeaderValue(value);
		if (encoded !== undefined) headers[`Mcp-Param-${header}`] = encoded;
	}
	return headers;
}

function paramHeaderValue(value: unknown): string | undefined {
	if (typeof value === "string") return encodeHeaderValue(value);
	if (typeof value === "boolean") return String(value);
	if (typeof value === "number" && Number.isSafeInteger(value)) return String(value);
	return undefined;
}

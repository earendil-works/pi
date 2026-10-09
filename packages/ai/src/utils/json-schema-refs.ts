import type { Tool } from "../types.ts";

type JsonObject = Record<string, unknown>;

/**
 * How many nodes inlining may add to a schema. Definitions that reference each other more than once
 * expand exponentially: a 2.4 KB schema with 25 such definitions inlines to 167 million nodes.
 */
const MAX_ADDED_NODES = 1000;

/** Keywords that may sit next to `$ref` without changing which values it accepts. */
const REF_ANNOTATIONS = new Set([
	"title",
	"description",
	"default",
	"examples",
	"deprecated",
	"readOnly",
	"writeOnly",
	"$comment",
]);

/** Keywords whose values are data, never schemas. */
const DATA_KEYWORDS = new Set(["const", "enum", "default", "examples"]);

/** Keywords whose values map names to schemas. */
const SCHEMA_MAP_KEYWORDS = new Set([
	"properties",
	"patternProperties",
	"dependentSchemas",
	"dependencies",
	"$defs",
	"definitions",
]);

/** Root definition containers: copied as-is, and dropped once nothing references them. */
const DEFINITION_KEYWORDS = ["$defs", "definitions"];

/** Keywords that name a location. Copying a subschema that declares one changes what references resolve to. */
const IDENTIFIER_KEYWORDS = ["$id", "id", "$anchor", "$dynamicAnchor"];

const inlinedSchemas = new WeakMap<object, Tool["parameters"]>();

class InliningAborted extends Error {}

function isJsonObject(value: unknown): value is JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function countNodes(value: unknown): number {
	if (typeof value !== "object" || value === null) return 1;
	let count = 1;
	for (const item of Object.values(value)) count += countNodes(item);
	return count;
}

/** Resolve `#` or a `#/...` JSON pointer against the schema root. */
function resolveLocalRef(root: JsonObject, ref: string): unknown {
	let target: unknown = root;
	for (const segment of ref === "#" ? [] : ref.slice(2).split("/")) {
		let key: string;
		try {
			key = decodeURIComponent(segment).replaceAll("~1", "/").replaceAll("~0", "~");
		} catch {
			return undefined;
		}
		if (typeof target !== "object" || target === null || !Object.hasOwn(target, key)) return undefined;
		target = (target as JsonObject)[key];
	}
	return target;
}

function inline(root: JsonObject): JsonObject {
	const limit = countNodes(root) + MAX_ADDED_NODES;
	let nodes = 0;
	let inlinedRef = false;
	let keptLocalRef = false;

	const count = () => {
		if (++nodes > limit) throw new InliningAborted();
	};

	const visitMap = (map: unknown, expanding: readonly string[]): unknown => {
		if (!isJsonObject(map)) return visitSchema(map, expanding);
		count();
		const copy: JsonObject = {};
		for (const [name, schema] of Object.entries(map)) copy[name] = visitSchema(schema, expanding);
		return copy;
	};

	const visitSchema = (node: unknown, expanding: readonly string[]): unknown => {
		count();
		if (Array.isArray(node)) return node.map((item) => visitSchema(item, expanding));
		if (!isJsonObject(node)) return node;
		if (
			node !== root &&
			(IDENTIFIER_KEYWORDS.some((key) => typeof node[key] === "string") || node.$recursiveAnchor === true)
		) {
			throw new InliningAborted();
		}

		const ref = node.$ref;
		if (typeof ref === "string" && (ref === "#" || ref.startsWith("#/"))) {
			const target = resolveLocalRef(root, ref);
			const siblings = Object.keys(node).filter((key) => key !== "$ref");
			if (isJsonObject(target) && !expanding.includes(ref) && siblings.every((key) => REF_ANNOTATIONS.has(key))) {
				inlinedRef = true;
				const expanded = visitSchema(target, [...expanding, ref]) as JsonObject;
				for (const key of siblings) expanded[key] = node[key];
				return expanded;
			}
		}
		// Kept references into this document, including anchors, still need the root definitions.
		if ((typeof ref === "string" && ref.startsWith("#")) || "$dynamicRef" in node || "$recursiveRef" in node) {
			keptLocalRef = true;
		}

		const copy: JsonObject = {};
		for (const [key, value] of Object.entries(node)) {
			if (DATA_KEYWORDS.has(key) || (node === root && DEFINITION_KEYWORDS.includes(key))) copy[key] = value;
			else if (SCHEMA_MAP_KEYWORDS.has(key)) copy[key] = visitMap(value, expanding);
			else copy[key] = visitSchema(value, expanding);
		}
		return copy;
	};

	let output: JsonObject;
	try {
		output = visitSchema(root, ["#"]) as JsonObject;
	} catch (error) {
		if (error instanceof InliningAborted) return root;
		throw error;
	}
	if (!inlinedRef) return root;
	if (!keptLocalRef) {
		for (const key of DEFINITION_KEYWORDS) delete output[key];
	}
	return output;
}

/**
 * Replace local `$ref`s (`#` and `#/...` JSON pointers) in a tool schema with the schemas they point
 * to. Argument coercion uses the result because it does not follow references, and the
 * `openai-completions` `inlineSchemaRefs` compat setting sends it to models that return a referenced
 * object as a JSON string.
 *
 * A reference stays in place when it is recursive, external, unresolvable, or has sibling keywords
 * other than annotations; the root definitions are then kept so it still resolves. Returns the input
 * unchanged when nothing can be inlined, when a nested `$id` or anchor could change how references
 * resolve, or when inlining would add more than {@link MAX_ADDED_NODES} nodes. Never mutates the
 * input, builds a separate copy for every expansion, and caches the result per schema object.
 */
export function inlineLocalSchemaRefs(schema: Tool["parameters"]): Tool["parameters"] {
	if (!isJsonObject(schema)) return schema;
	let inlined = inlinedSchemas.get(schema);
	if (!inlined) {
		inlined = inline(schema) as Tool["parameters"];
		inlinedSchemas.set(schema, inlined);
	}
	return inlined;
}

// Schema snapshots: one schema-aware walk checks an app schema against Chord's vocabulary and produces a
// Chord-owned copy and its normal form (the fingerprint input).

import { isJsonValue, type JsonValue } from "../../json.ts";
import { type BytesMarker, type TSchema, withBytesCheck } from "./schema.ts";

/**
 * A Chord-owned copy of an app schema, its normal form, and whether it has a `bytes()` leaf (values crossing a link
 * then carry raw byte segments); immutable by convention.
 */
export type Snapshot = { readonly schema: TSchema; readonly normal: JsonValue; readonly bytes: boolean };

/** Snapshot of a state, result or params schema. Throws an Error naming `path` for anything outside the vocabulary. */
export function snapshotSchema(source: unknown, path: string): Snapshot {
	return walk(source, path, "open", new Set());
}

/** Snapshot of a method's arguments: every object schema inside must also be closed (records allowed). */
export function snapshotArguments(source: unknown, path: string): Snapshot {
	return walk(source, path, "closed", new Set());
}

/** Whether object schemas must set `additionalProperties: false`. */
type Objects = "open" | "closed";

/** A copied keyword value, its normal form, and whether a schema inside it is a bytes leaf. */
type Copy = { readonly schema: unknown; readonly normal: JsonValue; readonly bytes: boolean };

/** Every supported keyword, grouped by how its value is walked. */
const KEYWORD_GROUPS = {
	schema: "additionalProperties additionalItems",
	schemas: "anyOf allOf prefixItems",
	items: "items",
	schemaMap: "properties patternProperties $defs",
	type: "type",
	required: "required",
	enum: "enum",
	data:
		"const default $ref $id pattern format minLength maxLength minimum maximum exclusiveMinimum exclusiveMaximum " +
		"multipleOf minItems maxItems uniqueItems minProperties maxProperties readOnly writeOnly",
	annotation: "title description examples $comment deprecated",
};

type Keyword = keyof typeof KEYWORD_GROUPS;

const KEYWORDS = new Map(
	Object.entries(KEYWORD_GROUPS).flatMap(([keyword, names]) =>
		names.split(" ").map((name) => [name, keyword as Keyword]),
	),
);

const TYPES = new Set(["null", "boolean", "number", "integer", "string", "array", "object", "bytes"]);

/** TypeBox's executable features, attached non-enumerably. */
const EXECUTABLE = ["~refine", "~codec", "~unsafe"];

const BYTES_EXECUTABLE = ["~refine", "~unsafe"];

const BYTES_KEYWORDS = new Set(["type", "minLength", "maxLength"]);

function walk(source: unknown, path: string, objects: Objects, ancestors: Set<object>): Snapshot {
	if (typeof source === "boolean") return { schema: source, normal: source, bytes: false };
	if (!isPlainObject(source)) throw new Error(`${path}: expected a schema`);
	if (ancestors.has(source)) throw new Error(`${path}: cyclic schema; use $defs and $ref for recursion`);
	const isBytes = source.type === "bytes";
	// A bytes schema may carry its own check (rebuilt below); no other schema may carry an executable feature.
	const allowed = isBytes ? BYTES_EXECUTABLE : [];
	for (const key of EXECUTABLE) {
		if (Object.hasOwn(source, key) && !allowed.includes(key)) {
			throw new Error(`${path}: TypeBox refinements, codecs and unsafe types are not supported`);
		}
	}
	ancestors.add(source);
	const schema: [string, unknown][] = [];
	const normal: [string, JsonValue][] = [];
	let bytes = isBytes;
	for (const [key, value] of ownEntries(source, path)) {
		const keyword = KEYWORDS.get(key);
		if (keyword === undefined || (isBytes && keyword !== "annotation" && !BYTES_KEYWORDS.has(key))) {
			throw new Error(`${path}: unsupported keyword "${key}"`);
		}
		const copy = walkKeyword(keyword, value, `${path}.${key}`, objects, ancestors);
		bytes ||= copy.bytes;
		schema.push([key, copy.schema]);
		// Annotations are dropped on schema nodes only; inside data they are ordinary keys.
		if (keyword !== "annotation") normal.push([key, copy.normal]);
	}
	ancestors.delete(source);
	const node = Object.fromEntries(schema);
	if (objects === "closed" && isOpenObject(node)) {
		throw new Error(`${path}: argument objects must be closed (additionalProperties: false)`);
	}
	if (isBytes) checkBytesBounds(node, path);
	return {
		schema: isBytes ? withBytesCheck(node as BytesMarker) : node,
		normal: Object.fromEntries(normal),
		bytes,
	};
}

function walkKeyword(keyword: Keyword, value: unknown, path: string, objects: Objects, ancestors: Set<object>): Copy {
	switch (keyword) {
		case "schema":
			return walk(value, path, objects, ancestors);
		case "schemas":
			return walkList(value, path, objects, ancestors);
		case "items":
			return Array.isArray(value)
				? walkList(value, path, objects, ancestors)
				: walk(value, path, objects, ancestors);
		case "schemaMap": {
			if (!isPlainObject(value)) throw new Error(`${path}: expected an object of schemas`);
			const entries = ownEntries(value, path).map(
				([key, item]) => [key, walk(item, `${path}.${key}`, objects, ancestors)] as const,
			);
			return {
				schema: Object.fromEntries(entries.map(([key, item]) => [key, item.schema])),
				normal: Object.fromEntries(entries.map(([key, item]) => [key, item.normal])),
				bytes: entries.some(([, item]) => item.bytes),
			};
		}
		case "type":
			if (typeof value !== "string" || !TYPES.has(value)) {
				throw new Error(`${path}: unsupported type ${JSON.stringify(value)}`);
			}
			return { schema: value, normal: value, bytes: false };
		case "required": {
			if (!Array.isArray(value) || !value.every((name) => typeof name === "string")) {
				throw new Error(`${path}: expected an array of strings`);
			}
			const names = [...value].sort();
			return { schema: names, normal: names, bytes: false };
		}
		case "enum": {
			const values = data(value, path).normal;
			if (!Array.isArray(values)) throw new Error(`${path}: expected an array`);
			const sorted = [...values].sort((a, b) => compare(JSON.stringify(a), JSON.stringify(b)));
			return { schema: sorted, normal: sorted, bytes: false };
		}
		case "data":
		case "annotation":
			return data(value, path);
	}
}

function walkList(value: unknown, path: string, objects: Objects, ancestors: Set<object>): Copy {
	if (!Array.isArray(value)) throw new Error(`${path}: expected an array of schemas`);
	const items = Array.from(value, (item, index) => walk(item, `${path}[${index}]`, objects, ancestors));
	return {
		schema: items.map((item) => item.schema),
		normal: items.map((item) => item.normal),
		bytes: items.some((item) => item.bytes),
	};
}

/** A JSON value as a copy with sorted keys; the same copy serves as snapshot and normal form. */
function data(value: unknown, path: string): Copy {
	if (!isJsonValue(value)) throw new Error(`${path}: expected JSON data (finite numbers, plain objects and arrays)`);
	const copy = sortedCopy(value);
	return { schema: copy, normal: copy, bytes: false };
}

function sortedCopy(value: JsonValue): JsonValue {
	if (value === null || typeof value !== "object") return value;
	if (Array.isArray(value)) return value.map(sortedCopy);
	const keys = Object.keys(value).sort();
	return Object.fromEntries(keys.map((key) => [key, sortedCopy(value[key]!)]));
}

/** Enumerable data entries sorted by key; symbol keys and accessors are refused. */
function ownEntries(source: object, path: string): [string, unknown][] {
	const entries: [string, unknown][] = [];
	for (const key of Reflect.ownKeys(source)) {
		if (typeof key === "symbol") throw new Error(`${path}: symbol keys are not supported`);
		const descriptor = Object.getOwnPropertyDescriptor(source, key)!;
		if (!("value" in descriptor)) throw new Error(`${path}.${key}: accessors are not supported`);
		// Non-enumerable keys are TypeBox metadata (`~kind`, `~optional`), never schema data.
		if (descriptor.enumerable) entries.push([key, descriptor.value]);
	}
	return entries.sort(([a], [b]) => compare(a, b));
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

/** An object schema that admits unknown fields. A record (pattern properties only) is allowed. */
function isOpenObject(node: Record<string, unknown>): boolean {
	const isRecord = "patternProperties" in node && !("properties" in node);
	const isObject = node.type === "object" || "properties" in node;
	return isObject && !isRecord && node.additionalProperties !== false;
}

function checkBytesBounds(node: Record<string, unknown>, path: string): void {
	for (const bound of [node.minLength, node.maxLength]) {
		if (bound !== undefined && !(Number.isSafeInteger(bound) && (bound as number) >= 0)) {
			throw new Error(`${path}: bytes bounds must be non-negative integers`);
		}
	}
}

function compare(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0;
}

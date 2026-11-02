// Coercion: turns a loosely typed value (a model's tool call arguments, form input, query strings) into the value a
// schema most likely meant, before it is checked. Only validators compiled with `{ coerce: true }` have it, and they
// build it on their first coerce() or parse(); the check path never runs it.
//
// Three passes, in this order:
// 1. Optional nulls: a `null` in an optional property whose schema rejects null is dropped, as if omitted.
// 2. Conversion rules ported from TypeBox 1.3.27's Value.Convert (MIT), keyed on JSON Schema structure (`$ref`, `const`,
//    `enum`, `anyOf`/`oneOf`, `allOf`, `type`, `items`/`prefixItems`, `properties`/`patternProperties`) instead of
//    TypeBox's kind marks: `null` becomes "null" for a string, `"3.5"` becomes 3 for an integer, a single value becomes
//    a one-item array, and a union takes the first branch whose conversion passes.
// 3. Primitive coercion by `type` (also type arrays), as in Ajv's `coerceTypes`: what pass 2 left, for example a type
//    array `["integer", "null"]`, or `""` for `null`.
// A value that cannot be coerced is left as it is; the check then reports it.
//
// Every pass is copy-on-write: an object or array is copied only when one of its members changes, so an unchanged
// value comes back as the same reference and the input is never modified. All passes walk the same keywords for
// members: `properties`, then `patternProperties`, then `additionalProperties` for keys neither names; tuple items by
// `prefixItems` (or a draft-7 `items` array), the rest by `items`. Draft 7's `additionalItems` is not coerced.

import type { Compiler } from "./compiler.ts";
import { isSchemaObject } from "./resolver.ts";
import { sharedRegex } from "./shared.ts";
import type { SchemaObject } from "./types.ts";

/** Coerces values for one compiled schema. */
export class Coercer {
	private readonly c: Compiler;
	private readonly schema: unknown;
	/**
	 * The (schema node, value) pairs pass 2 is converting through a re-entry point, as a stack. Conversion can enter
	 * a node again with the same value only through a `$ref` or by wrapping a single value into an array (also for
	 * schemas that cycle through shared JS objects): a recursive schema that meets a value no branch accepts would
	 * convert it without end. A pair already on the stack (primitives by value, objects by reference) leaves the value
	 * unchanged. Only those two points push, so schemas without references or wraps pay nothing.
	 */
	private readonly entered: unknown[] = [];
	/** How often a re-entry was cut short in this coerce() call; results computed across one are not memoized. */
	private cuts = 0;
	/**
	 * Results of `$ref` targets by (node, value) within one coerce() call: a recursive union whose branches all
	 * convert the same children (and all fail) would convert them once per branch, exponentially in the depth.
	 */
	private memo: Map<object, Map<unknown, unknown>> | undefined = undefined;

	constructor(compiler: Compiler, schema: unknown) {
		this.c = compiler;
		this.schema = schema;
	}

	/** `value` coerced: a copy along the changed paths only, or `value` itself when nothing changes. */
	coerce(value: unknown): unknown {
		const base = this.c.r.rootBase;
		const withoutNulls = this.dropOptionalNulls(value, this.schema, base);
		return this.coerceTypes(this.convertOnly(withoutNulls), this.schema, base);
	}

	/** Pass 2 alone, as TypeBox's `Value.Convert` (the TypeBox conformance tests run it). */
	convertOnly(value: unknown): unknown {
		try {
			return this.convert(this.schema, this.c.r.rootBase, value);
		} finally {
			this.memo = undefined;
			this.cuts = 0;
		}
	}

	/** `node` converted for `value` at a re-entry point: unchanged when that pair is already being converted. */
	private reenter(node: object, base: string, value: unknown, memoize: boolean): unknown {
		const entered = this.entered;
		for (let i = 0; i < entered.length; i += 2) {
			if (entered[i] === node && Object.is(entered[i + 1], value)) {
				this.cuts++;
				return value;
			}
		}
		const memo = memoize ? this.memo?.get(node) : undefined;
		if (memo?.has(value)) return memo.get(value);
		const cuts = this.cuts;
		entered.push(node, value);
		let result: unknown;
		try {
			result = this.convert(node, base, value);
		} finally {
			entered.length -= 2;
		}
		if (memoize && this.cuts === cuts) {
			this.memo ??= new Map();
			let values = this.memo.get(node);
			if (values === undefined) {
				values = new Map();
				this.memo.set(node, values);
			}
			values.set(value, result);
		}
		return result;
	}

	/** Whether `value` passes the schema `node`; undefined when `node` cannot be compiled. */
	private passes(node: unknown, base: string, value: unknown): boolean | undefined {
		try {
			return this.c.check(node, this.baseOf(node, base))(value);
		} catch {
			return undefined;
		}
	}

	private baseOf(node: unknown, base: string): string {
		return isSchemaObject(node) ? (this.c.r.baseOf.get(node) ?? base) : base;
	}

	// ---------------------------------------------------------------------------------------------------------------
	// Pass 1: optional nulls
	// ---------------------------------------------------------------------------------------------------------------

	private dropOptionalNulls(value: unknown, schema: unknown, base: string): unknown {
		if (!isSchemaObject(schema)) return value;
		const b = this.baseOf(schema, base);
		if (Array.isArray(value)) {
			return mapItems(value, (item, i) => {
				const itemSchema = itemSchemaAt(schema, i);
				return itemSchema === undefined ? item : this.dropOptionalNulls(item, itemSchema, b);
			});
		}
		if (!isPlainObject(value)) return value;
		const properties = isSchemaObject(schema.properties) ? schema.properties : {};
		const patterns = isSchemaObject(schema.patternProperties)
			? Object.entries(schema.patternProperties).map(([pattern, item]) => [sharedRegex(pattern), item] as const)
			: [];
		const additional = isSchemaObject(schema.additionalProperties) ? schema.additionalProperties : undefined;
		if (patterns.length === 0 && additional === undefined && !isSchemaObject(schema.properties)) return value;
		const required = new Set(Array.isArray(schema.required) ? schema.required : []);
		let out: Record<string, unknown> | undefined;
		const set = (key: string, next: unknown) => {
			if (next === (out ?? value)[key]) return;
			out ??= { ...value };
			out[key] = next;
		};
		for (const [key, property] of Object.entries(properties)) {
			if (!Object.hasOwn(value, key)) continue;
			const isRef = isSchemaObject(property) && typeof property.$ref === "string";
			if (value[key] === null && !required.has(key) && !isRef && this.passes(property, b, null) === false) {
				out ??= { ...value };
				delete out[key];
				continue;
			}
			set(key, this.dropOptionalNulls(value[key], property, b));
		}
		// Values of pattern and additional properties are walked for their own optional nulls; the keys themselves
		// are not optional properties, so they stay.
		if (patterns.length > 0 || additional !== undefined) {
			for (const key of Object.keys(value)) {
				let matched = Object.hasOwn(properties, key);
				for (const [pattern, item] of patterns) {
					if (!pattern.test(key)) continue;
					matched = true;
					set(key, this.dropOptionalNulls((out ?? value)[key], item, b));
				}
				if (!matched && additional !== undefined) set(key, this.dropOptionalNulls(value[key], additional, b));
			}
		}
		return out ?? value;
	}

	// ---------------------------------------------------------------------------------------------------------------
	// Pass 2: TypeBox's conversion rules
	// ---------------------------------------------------------------------------------------------------------------

	private convert(node: unknown, base: string, value: unknown): unknown {
		if (!isSchemaObject(node)) return value;
		const b = this.baseOf(node, base);
		if (typeof node.$ref === "string") {
			let target: { node: unknown; base: string };
			try {
				target = this.c.r.resolve(node.$ref, b);
			} catch {
				return value;
			}
			return isSchemaObject(target.node) ? this.reenter(target.node, target.base, value, true) : value;
		}
		return this.convertNode(node, b, value);
	}

	/** One schema node's conversion: its first keyword among `const`, `enum`, the unions, `allOf` and `type`. */
	private convertNode(node: SchemaObject, b: string, value: unknown): unknown {
		if (Object.hasOwn(node, "const")) return convertLiteral(node.const, value);
		if (Array.isArray(node.enum)) return this.convertEnum(node, node.enum, b, value);
		// A union or intersection node may also declare members (plain JSON Schema; TypeBox's never do): they convert
		// after the branches.
		if (Array.isArray(node.anyOf)) return this.convertUnion(node, node.anyOf, b, value);
		if (Array.isArray(node.oneOf)) return this.convertUnion(node, node.oneOf, b, value);
		if (Array.isArray(node.allOf)) {
			let next = value;
			for (const member of node.allOf) next = this.convert(member, b, next);
			return this.convertMembers(node, b, next);
		}
		switch (node.type) {
			case "string":
				return orValue(tryString(value), value);
			case "number":
				return orValue(tryNumber(value), value);
			case "integer": {
				const result = tryNumber(value);
				return result === undefined ? value : Math.trunc(result.value);
			}
			case "boolean":
				return orValue(tryBoolean(value), value);
			case "null":
				return orValue(tryNull(value), value);
			case "array":
				return this.convertArray(node, b, value);
			case "object":
				return this.convertObject(node, b, value);
			case undefined:
				if (node.properties !== undefined || node.patternProperties !== undefined) {
					return this.convertObject(node, b, value);
				}
				if (node.items !== undefined || node.prefixItems !== undefined) return this.convertArray(node, b, value);
				return value;
			default:
				return value;
		}
	}

	/** An enum is a union of its values: a member stays, else the first value the input converts to. */
	private convertEnum(node: SchemaObject, values: readonly unknown[], base: string, value: unknown): unknown {
		if (values.some((member) => member === value)) return value;
		for (const member of values) {
			const candidate = convertLiteral(member, value);
			if (candidate !== value && this.passes(node, base, candidate) === true) return candidate;
		}
		return value;
	}

	/**
	 * A value one branch accepts stays; else the first branch's conversion that the whole union accepts. Branches are
	 * converted in order and only until one is accepted, so a later recursive branch is not entered needlessly. A node
	 * that also declares members (plain JSON Schema; TypeBox's never do) converts them into each candidate before it is
	 * checked, so a branch is not discarded for a sibling property that is converted after it.
	 */
	private convertUnion(node: SchemaObject, branches: readonly unknown[], base: string, value: unknown): unknown {
		if (branches.some((branch) => this.passes(branch, base, value) === true))
			return this.convertMembers(node, base, value);
		for (const branch of branches) {
			const candidate = this.convertMembers(node, base, this.convert(branch, base, value));
			if (this.passes(node, base, candidate) === true) return candidate;
		}
		return this.convertMembers(node, base, value);
	}

	/** The object members of a union or intersection node, when it declares any. */
	private convertMembers(node: SchemaObject, base: string, value: unknown): unknown {
		const declares =
			node.properties !== undefined ||
			node.patternProperties !== undefined ||
			node.additionalProperties !== undefined;
		return declares ? this.convertObject(node, base, value) : value;
	}

	private convertArray(node: SchemaObject, base: string, value: unknown): unknown {
		const prefix = Array.isArray(node.items)
			? node.items
			: Array.isArray(node.prefixItems)
				? node.prefixItems
				: undefined;
		if (prefix !== undefined) {
			// A tuple converts its items and never wraps a single value.
			if (!Array.isArray(value)) return value;
			const rest = Array.isArray(node.items) ? undefined : node.items;
			return mapItems(value, (item, i) => {
				const schema = i < prefix.length ? prefix[i] : rest;
				return schema === undefined ? item : this.convert(schema, base, item);
			});
		}
		if (Array.isArray(value)) {
			return node.items === undefined ? value : mapItems(value, (item) => this.convert(node.items, base, item));
		}
		// The wrapped single value is converted by the item schema with the same value: a re-entry point.
		const item = node.items;
		return [isSchemaObject(item) ? this.reenter(item, base, value, false) : value];
	}

	private convertObject(node: SchemaObject, base: string, value: unknown): unknown {
		if (!isPlainObject(value)) return value;
		const properties = isSchemaObject(node.properties) ? node.properties : {};
		const patterns = isSchemaObject(node.patternProperties)
			? Object.entries(node.patternProperties).map(([pattern, schema]) => [sharedRegex(pattern), schema] as const)
			: [];
		const additional = isSchemaObject(node.additionalProperties) ? node.additionalProperties : undefined;
		let out: Record<string, unknown> | undefined;
		for (const key of Object.keys(value)) {
			// An undefined property counts as absent.
			if (value[key] === undefined) continue;
			let next: unknown = value[key];
			let matched = Object.hasOwn(properties, key);
			if (matched) next = this.convert(properties[key], base, next);
			for (const [pattern, schema] of patterns) {
				if (!pattern.test(key)) continue;
				matched = true;
				next = this.convert(schema, base, next);
			}
			if (!matched && additional !== undefined) next = this.convert(additional, base, next);
			if (next !== value[key]) {
				out ??= { ...value };
				out[key] = next;
			}
		}
		return out ?? value;
	}

	// ---------------------------------------------------------------------------------------------------------------
	// Pass 3: primitive coercion by type
	// ---------------------------------------------------------------------------------------------------------------

	private coerceTypes(value: unknown, schema: unknown, base: string): unknown {
		if (!isSchemaObject(schema)) return value;
		const b = this.baseOf(schema, base);
		let next = value;
		if (Array.isArray(schema.allOf)) for (const member of schema.allOf) next = this.coerceTypes(next, member, b);
		if (Array.isArray(schema.anyOf)) next = this.coerceUnion(next, schema.anyOf, b);
		if (Array.isArray(schema.oneOf)) next = this.coerceUnion(next, schema.oneOf, b);
		const types = typesOf(schema);
		const matchesUnionMember = types.length > 1 && types.some((type) => matchesType(next, type));
		if (types.length > 0 && !matchesUnionMember) {
			for (const type of types) {
				const candidate = coercePrimitive(next, type);
				if (candidate !== next) {
					next = candidate;
					break;
				}
			}
		}
		if (types.includes("object") && isPlainObject(next)) next = this.coerceProperties(next, schema, b);
		if (types.includes("array") && Array.isArray(next)) next = this.coerceItems(next, schema, b);
		return next;
	}

	private coerceUnion(value: unknown, branches: readonly unknown[], base: string): unknown {
		for (const branch of branches) if (this.passes(branch, base, value) === true) return value;
		for (const branch of branches) {
			const coerced = this.coerceTypes(value, branch, base);
			if (this.passes(branch, base, coerced) === true) return coerced;
		}
		return value;
	}

	private coerceProperties(
		value: Record<string, unknown>,
		schema: SchemaObject,
		base: string,
	): Record<string, unknown> {
		const properties = isSchemaObject(schema.properties) ? schema.properties : {};
		const patterns = isSchemaObject(schema.patternProperties)
			? Object.entries(schema.patternProperties).map(([pattern, item]) => [sharedRegex(pattern), item] as const)
			: [];
		const additional = isSchemaObject(schema.additionalProperties) ? schema.additionalProperties : undefined;
		let out: Record<string, unknown> | undefined;
		const set = (key: string, next: unknown) => {
			if (next === (out ?? value)[key]) return;
			out ??= { ...value };
			out[key] = next;
		};
		for (const [key, property] of Object.entries(properties)) {
			if (key in value) set(key, this.coerceTypes(value[key], property, base));
		}
		for (const key of Object.keys(value)) {
			let matched = Object.hasOwn(properties, key);
			for (const [pattern, item] of patterns) {
				if (!pattern.test(key)) continue;
				matched = true;
				set(key, this.coerceTypes((out ?? value)[key], item, base));
			}
			if (!matched && additional !== undefined) set(key, this.coerceTypes(value[key], additional, base));
		}
		return out ?? value;
	}

	private coerceItems(value: unknown[], schema: SchemaObject, base: string): unknown[] {
		return mapItems(value, (item, i) => {
			const itemSchema = itemSchemaAt(schema, i);
			return isSchemaObject(itemSchema) ? this.coerceTypes(item, itemSchema, base) : item;
		});
	}
}

/**
 * The schema of an array's item at `index`: a tuple's (`prefixItems`, or a draft-7 `items` array) for its prefix,
 * `items` after `prefixItems`, or `items` for every item. Undefined when nothing applies.
 */
function itemSchemaAt(schema: SchemaObject, index: number): unknown {
	if (Array.isArray(schema.items)) return schema.items[index];
	if (Array.isArray(schema.prefixItems) && index < schema.prefixItems.length) return schema.prefixItems[index];
	return schema.items;
}

/** `items` mapped by `map`; the same array when every item maps to itself. */
function mapItems(items: unknown[], map: (item: unknown, index: number) => unknown): unknown[] {
	let out: unknown[] | undefined;
	for (let i = 0; i < items.length; i++) {
		const next = map(items[i], i);
		if (next === items[i]) continue;
		out ??= items.slice();
		out[i] = next;
	}
	return out ?? items;
}

// -------------------------------------------------------------------------------------------------------------------
// TypeBox's conversions of one value (value/convert/try in TypeBox 1.3.27): a result, or undefined when there is none
// -------------------------------------------------------------------------------------------------------------------

type Converted<T> = { readonly value: T } | undefined;

function orValue(result: Converted<unknown>, value: unknown): unknown {
	return result === undefined ? value : result.value;
}

/** A literal (`const`, an enum value) taken from a value of another type that converts to exactly it. */
function convertLiteral(literal: unknown, value: unknown): unknown {
	if (literal === value) return value;
	const result =
		typeof literal === "string"
			? tryString(value)
			: typeof literal === "number"
				? tryNumber(value)
				: typeof literal === "boolean"
					? tryBoolean(value)
					: undefined;
	return result !== undefined && result.value === literal ? result.value : value;
}

function tryString(value: unknown): Converted<string> {
	if (typeof value === "bigint" || typeof value === "boolean" || isFiniteNumber(value))
		return { value: String(value) };
	if (value === null) return { value: "null" };
	if (typeof value === "string") return { value };
	if (value === undefined) return { value: "" };
	return undefined;
}

const MAX_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);
const MIN_BIGINT = BigInt(Number.MIN_SAFE_INTEGER);

function tryNumber(value: unknown): Converted<number> {
	if (typeof value === "bigint")
		return value <= MAX_BIGINT && value >= MIN_BIGINT ? { value: Number(value) } : undefined;
	if (typeof value === "boolean") return { value: value ? 1 : 0 };
	if (isFiniteNumber(value)) return { value };
	if (value === null || value === undefined) return { value: 0 };
	if (typeof value !== "string") return undefined;
	const coerced = +value;
	if (Number.isFinite(coerced)) return { value: coerced };
	const lowercase = value.toLowerCase();
	if (lowercase === "false") return { value: 0 };
	if (lowercase === "true") return { value: 1 };
	const big = bigIntOfString(value);
	return big !== undefined && big <= MAX_BIGINT && big >= MIN_BIGINT ? { value: Number(big) } : undefined;
}

/** TypeBox's TryBigInt of a string: `12n`, `12.5` (truncated) or `12`; true and false are not reached from tryNumber. */
function bigIntOfString(value: string): bigint | undefined {
	if (/^-?(0|[1-9]\d*)n$/.test(value)) return BigInt(value.slice(0, -1));
	if (/^-?(0|[1-9]\d*)\.\d+$/.test(value)) return BigInt(value.split(".")[0]);
	if (/^-?(0|[1-9]\d*)$/.test(value)) return BigInt(value);
	return undefined;
}

function tryBoolean(value: unknown): Converted<boolean> {
	if (typeof value === "bigint") return value === 0n ? { value: false } : value === 1n ? { value: true } : undefined;
	if (typeof value === "boolean") return { value };
	if (isFiniteNumber(value)) return value === 0 ? { value: false } : value === 1 ? { value: true } : undefined;
	if (value === null || value === undefined) return { value: false };
	if (typeof value !== "string") return undefined;
	const lowercase = value.toLowerCase();
	if (lowercase === "false" || value === "0") return { value: false };
	if (lowercase === "true" || value === "1") return { value: true };
	return undefined;
}

function tryNull(value: unknown): Converted<null> {
	if (typeof value === "bigint") return value === 0n ? { value: null } : undefined;
	if (typeof value === "boolean") return value === false ? { value: null } : undefined;
	if (isFiniteNumber(value)) return value === 0 ? { value: null } : undefined;
	if (value === null || value === undefined) return { value: null };
	if (typeof value !== "string") return undefined;
	const lowercase = value.toLowerCase();
	return lowercase === "undefined" || lowercase === "null" || value === "" || value === "0"
		? { value: null }
		: undefined;
}

function isFiniteNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value);
}

// -------------------------------------------------------------------------------------------------------------------
// Primitive coercion by type (pass 3)
// -------------------------------------------------------------------------------------------------------------------

function typesOf(schema: SchemaObject): string[] {
	if (typeof schema.type === "string") return [schema.type];
	if (Array.isArray(schema.type)) return schema.type.filter((type): type is string => typeof type === "string");
	return [];
}

function matchesType(value: unknown, type: string): boolean {
	switch (type) {
		case "number":
			return typeof value === "number";
		case "integer":
			return typeof value === "number" && Number.isInteger(value);
		case "boolean":
			return typeof value === "boolean";
		case "string":
			return typeof value === "string";
		case "null":
			return value === null;
		case "array":
			return Array.isArray(value);
		case "object":
			return isPlainObject(value);
		default:
			return false;
	}
}

function coercePrimitive(value: unknown, type: string): unknown {
	switch (type) {
		case "number":
		case "integer": {
			if (value === null) return 0;
			if (typeof value === "string" && value.trim() !== "") {
				const parsed = Number(value);
				if (type === "number" ? Number.isFinite(parsed) : Number.isInteger(parsed)) return parsed;
			}
			if (typeof value === "boolean") return value ? 1 : 0;
			return value;
		}
		case "boolean":
			if (value === null) return false;
			if (value === "true" || value === 1) return true;
			if (value === "false" || value === 0) return false;
			return value;
		case "string":
			if (value === null) return "";
			if (typeof value === "number" || typeof value === "boolean") return String(value);
			return value;
		case "null":
			return value === "" || value === 0 || value === false ? null : value;
		default:
			return value;
	}
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

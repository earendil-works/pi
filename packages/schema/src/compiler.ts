// The compiler: a schema to one check closure, built once. Keywords group by the type they constrain, so a value
// is classified once per schema, and the common shapes (closed objects, arrays of one item schema, tagged unions,
// leaf schemas) get one specialized closure each.

import {
	ANNOTATING_FALSE,
	ANNOTATING_TRUE,
	type AnnotatingCheck,
	annotateAll,
	annotateAny,
	annotateArray,
	annotateDependent,
	annotateIf,
	annotateObject,
	ignoreAnnotations,
	indirectAnnotating,
	isolateAnnotations,
	scopedAnnotating,
	unevaluatedItems,
	unevaluatedProperties,
	withFreshAnnotations,
} from "./annotations.ts";
import {
	ALWAYS,
	and,
	anyCheck,
	bytesCheck,
	constCheck,
	containsCheck,
	declaredObject,
	dependentRequiredCheck,
	dependentSchemasCheck,
	enumCheck,
	GUARD_LOOSE,
	GUARD_NONE,
	GUARD_STRICT,
	type Guard,
	guardArray,
	guardObject,
	INHERITED,
	IS_ARRAY,
	IS_OBJECT,
	ifCheck,
	indirect,
	itemsCheck,
	LEAF_CODES,
	lengthCheck,
	listCheck,
	NEVER,
	notCheck,
	numberCheck,
	oneCheck,
	openObject,
	propertyCountCheck,
	propertyNamesCheck,
	REQUIRED,
	scopedCheck,
	stringCheck,
	TYPE_CHECKS,
	taggedCheck,
	typeCheck,
	uniqueCheck,
} from "./checks.ts";
import { documentOf, isSchemaObject, Resolver, resolveUri } from "./resolver.ts";
import { sharedRegex } from "./shared.ts";
import type { Check, CompileOptions, FormatCheck, JsonSchema, SchemaObject } from "./types.ts";

/** Thrown when a compile without dynamic scope tracking meets a bookended `$dynamicRef`: compile again with it. */
export const RESTART = Symbol("restart");

/** One compile of a schema. Its caches and indexes are garbage once the root check is built. */
export class Compiler {
	readonly r: Resolver;
	readonly draft: "2020-12" | "7";
	readonly formats: Readonly<Record<string, FormatCheck>> | undefined;
	/** Whether checks track the dynamic scope (the schema has a bookended `$dynamicRef`). */
	readonly dynamic: boolean;
	private readonly schema: JsonSchema;
	private readonly scope: string[];
	private readonly cache = new Map<object, Check>();
	private readonly annotatingCache = new Map<object, AnnotatingCheck>();

	constructor(schema: JsonSchema, options: CompileOptions, dynamic: boolean) {
		this.schema = schema;
		this.r = new Resolver(schema, options);
		this.draft = this.r.draft;
		this.formats = options.formats;
		this.dynamic = dynamic;
		this.scope = [];
	}

	/** The check of the root schema. */
	root(): Check {
		return this.check(this.schema, this.r.rootBase);
	}

	/** The check of a schema (cached by schema object; a recursive reference goes through an indirection). */
	check(node: unknown, base: string): Check {
		if (node === true) return ALWAYS;
		if (node === false) return NEVER;
		if (!isSchemaObject(node))
			throw new Error(`A schema must be an object or a boolean, got ${JSON.stringify(node)}`);
		const cached = this.cache.get(node);
		if (cached !== undefined) return cached;
		const bare = this.bareType(node);
		if (bare !== undefined) return bare;
		const slot: { check: Check | undefined } = { check: undefined };
		this.cache.set(node, indirect(slot));
		const check = this.build(node, this.r.baseFor(node, base));
		slot.check = check;
		this.cache.set(node, check);
		return check;
	}

	private build(node: SchemaObject, base: string): Check {
		if (this.draft === "7" && typeof node.$ref === "string") return this.ref(node.$ref, base);
		if (this.draft !== "7" && (node.unevaluatedProperties !== undefined || node.unevaluatedItems !== undefined)) {
			return withFreshAnnotations(this.annotating(node, base));
		}
		const check = this.plain(node, base);
		return this.dynamic && this.r.isResource(node, base) ? scopedCheck(this.scope, base, check) : check;
	}

	/**
	 * The module-level check of a schema that is only a `type` (with annotations), `ALWAYS` for one with no assertion
	 * at all; undefined for every other schema. These are the most common subschemas and cost nothing to share.
	 */
	private bareType(node: SchemaObject): Check | undefined {
		let type: unknown;
		for (const k in node) {
			if (k === "type") type = node.type;
			else if (!NEUTRAL_KEYWORDS.has(k)) return undefined;
		}
		if (type === undefined) return ALWAYS;
		return typeof type === "string" ? TYPE_CHECKS.get(type) : undefined;
	}

	/** Every keyword of `node`, not tracking annotations. */
	private plain(node: SchemaObject, base: string): Check {
		const parts: Check[] = [];
		const types = node.type === undefined ? undefined : Array.isArray(node.type) ? node.type : [node.type];
		const single = types?.length === 1 ? types[0] : undefined;
		let typeInGroup = false;
		if (single === "bytes") {
			parts.push(bytesCheck(number(node.minLength) ?? 0, number(node.maxLength) ?? Number.POSITIVE_INFINITY));
			typeInGroup = true;
		} else {
			const string = this.stringGroup(node, single === "string");
			if (string !== undefined) parts.push(string);
			const numeric = single === "number" || single === "integer";
			const number = this.numberGroup(node, single === "number" ? 1 : single === "integer" ? 2 : 0);
			if (number !== undefined) parts.push(number);
			const object = this.objectGroup(node, base, single === "object");
			if (object !== undefined) parts.push(object);
			const array = this.arrayGroup(node, base, single === "array");
			if (array !== undefined) parts.push(array);
			typeInGroup =
				(single === "string" && string !== undefined) ||
				(numeric && number !== undefined) ||
				(single === "object" && object !== undefined) ||
				(single === "array" && array !== undefined);
		}
		if (types !== undefined && !typeInGroup) parts.unshift(typeCheck(types));
		this.inPlace(node, base, parts);
		return and(parts);
	}

	// The keywords that apply to the value itself, whatever its type.
	private inPlace(node: SchemaObject, base: string, parts: Check[]): void {
		if (Array.isArray(node.enum)) parts.push(enumCheck(node.enum));
		if (Object.hasOwn(node, "const")) parts.push(constCheck(node.const));
		if (Array.isArray(node.allOf)) parts.push(and(node.allOf.map((s) => this.check(s, base))));
		if (Array.isArray(node.anyOf)) parts.push(this.union(node.anyOf, base, false));
		if (Array.isArray(node.oneOf)) parts.push(this.union(node.oneOf, base, true));
		if (node.not !== undefined) parts.push(notCheck(this.check(node.not, base)));
		if (node.if !== undefined && (node.then !== undefined || node.else !== undefined)) {
			const then = node.then === undefined ? ALWAYS : this.check(node.then, base);
			const otherwise = node.else === undefined ? ALWAYS : this.check(node.else, base);
			parts.push(ifCheck(this.check(node.if, base), then, otherwise));
		}
		if (typeof node.$ref === "string") parts.push(this.ref(node.$ref, base));
		if (this.draft !== "7" && typeof node.$dynamicRef === "string") {
			parts.push(this.dynamicRef(node.$dynamicRef, base));
		}
	}

	private union(branches: readonly unknown[], base: string, exactlyOne: boolean): Check {
		const checks = () => branches.map((s) => this.check(s, base));
		return (
			constUnion(branches, exactlyOne) ??
			this.tagged(branches, base) ??
			(exactlyOne ? oneCheck(checks()) : anyCheck(checks()))
		);
	}

	private ref(ref: string, base: string): Check {
		const target = this.r.resolve(ref, base);
		const check = this.check(target.node, target.base);
		return this.dynamic && target.base !== base ? scopedCheck(this.scope, target.base, check) : check;
	}

	private dynamicRef(ref: string, base: string): Check {
		const resolved = this.bookended(ref, base);
		if (resolved === undefined) return this.ref(ref, base);
		const { initial, name } = resolved;
		const fallback = this.check(initial.node, initial.base);
		const lookup = this.dynamicLookup(name, (node, b) => this.check(node, b));
		const scope = this.scope;
		return (v) => {
			for (let i = 0; i < scope.length; i++) {
				const check = lookup(scope[i]);
				if (check !== null) return check(v);
			}
			return fallback(v);
		};
	}

	/** The initial target and anchor name of a `$dynamicRef` that resolves dynamically, or undefined for a plain ref. */
	private bookended(
		ref: string,
		base: string,
	): { initial: { node: unknown; base: string }; name: string } | undefined {
		const initial = this.r.resolve(ref, base);
		const uri = resolveUri(ref, base);
		const name = uri.slice(documentOf(uri).length + 1);
		const anchored = isSchemaObject(initial.node) && initial.node.$dynamicAnchor === name;
		if (name === "" || name.startsWith("/") || !anchored) return undefined;
		if (!this.dynamic) throw RESTART;
		return { initial, name };
	}

	// Resolved at run time against the dynamic scope, so a schema with a bookended $dynamicRef keeps its compiler.
	private dynamicLookup<T>(name: string, compile: (node: SchemaObject, base: string) => T): (uri: string) => T | null {
		const found = new Map<string, T | null>();
		return (uri) => {
			const key = `${uri}#${name}`;
			let check = found.get(key);
			if (check === undefined) {
				const target = this.r.dynamicAnchors.get(key);
				check = target === undefined ? null : compile(target, this.r.baseOf.get(target) ?? uri);
				found.set(key, check);
			}
			return check;
		};
	}

	/** anyOf/oneOf whose branches are all objects with a distinct required const on one key: the tag picks the branch. */
	private tagged(branches: readonly unknown[], base: string): Check | undefined {
		if (branches.length < 2) return undefined;
		const resolved: SchemaObject[] = [];
		for (const branch of branches) {
			if (!isSchemaObject(branch)) return undefined;
			const ref = typeof branch.$ref === "string" && Object.keys(branch).length === 1 ? branch.$ref : undefined;
			const node = ref === undefined ? branch : this.r.resolve(ref, this.r.baseFor(branch, base)).node;
			if (!isSchemaObject(node)) return undefined;
			resolved.push(node);
		}
		const first = resolved[0].properties;
		if (!isSchemaObject(first)) return undefined;
		for (const key of Object.keys(first)) {
			const tags = resolved.map((s) => tagOf(s, key));
			if (tags.some((t) => t === undefined) || new Set(tags).size !== tags.length) continue;
			return taggedCheck(
				key,
				tags,
				branches.map((s) => this.check(s, base)),
			);
		}
		return undefined;
	}

	private stringGroup(node: SchemaObject, strict: boolean): Check | undefined {
		const min = number(node.minLength) ?? 0;
		const max = number(node.maxLength) ?? Number.POSITIVE_INFINITY;
		const re = typeof node.pattern === "string" ? sharedRegex(node.pattern) : undefined;
		const format =
			this.formats !== undefined && typeof node.format === "string" && Object.hasOwn(this.formats, node.format)
				? this.formats[node.format]
				: undefined;
		if (min === 0 && max === Number.POSITIVE_INFINITY && re === undefined && format === undefined) return undefined;
		return stringCheck(strict, min, max, re, format);
	}

	private numberGroup(node: SchemaObject, mode: 0 | 1 | 2): Check | undefined {
		const min = number(node.minimum);
		const max = number(node.maximum);
		const xmin = number(node.exclusiveMinimum);
		const xmax = number(node.exclusiveMaximum);
		const multipleOf = number(node.multipleOf);
		if ([min, max, xmin, xmax, multipleOf].every((x) => x === undefined)) return undefined;
		const inf = Number.POSITIVE_INFINITY;
		return numberCheck(mode, min ?? -inf, max ?? inf, xmin ?? -inf, xmax ?? inf, multipleOf);
	}

	private objectGroup(node: SchemaObject, base: string, strict: boolean): Check | undefined {
		const onlyCore = OBJECT_EXTRAS.every((k) => node[k] === undefined);
		// A schema with only the core object keywords gets one closure that also does the type guard.
		const core = this.objectCore(node, base, onlyCore ? (strict ? GUARD_STRICT : GUARD_LOOSE) : GUARD_NONE);
		if (core !== undefined && onlyCore) return core;
		const parts: Check[] = core === undefined ? [] : [core];
		if (node.propertyNames !== undefined) parts.push(propertyNamesCheck(this.check(node.propertyNames, base)));
		const minProperties = number(node.minProperties);
		const maxProperties = number(node.maxProperties);
		if (minProperties !== undefined || maxProperties !== undefined) {
			parts.push(propertyCountCheck(minProperties ?? 0, maxProperties ?? Number.POSITIVE_INFINITY));
		}
		const dependentRequired: [string, string[]][] = [];
		const dependentSchemas: [string, Check][] = [];
		if (this.draft !== "7") {
			for (const [k, list] of entries(node.dependentRequired))
				if (Array.isArray(list)) dependentRequired.push([k, list]);
			for (const [k, s] of entries(node.dependentSchemas)) dependentSchemas.push([k, this.check(s, base)]);
		}
		for (const [k, d] of entries(node.dependencies)) {
			if (Array.isArray(d)) dependentRequired.push([k, d]);
			else dependentSchemas.push([k, this.check(d, base)]);
		}
		if (dependentRequired.length > 0) parts.push(dependentRequiredCheck(dependentRequired));
		if (dependentSchemas.length > 0) parts.push(dependentSchemasCheck(dependentSchemas));
		if (parts.length === 0) return strict ? IS_OBJECT : undefined;
		return guardObject(and(parts), strict);
	}

	private objectCore(node: SchemaObject, base: string, guard: Guard): Check | undefined {
		const properties = isSchemaObject(node.properties) ? node.properties : {};
		const required = Array.isArray(node.required) ? node.required.filter((k) => typeof k === "string") : [];
		const patterns = isSchemaObject(node.patternProperties) ? node.patternProperties : {};
		const additional = node.additionalProperties;
		const keys = Object.keys(properties);
		const patternKeys = Object.keys(patterns);
		if (
			keys.length + required.length + patternKeys.length === 0 &&
			(additional === undefined || additional === true)
		) {
			return undefined;
		}
		// One array per object: key, check, flags (leaf code, required, key also names an Object.prototype member).
		const entries: unknown[] = [];
		for (const k of keys) {
			const check = this.check(properties[k], base);
			const flags =
				(LEAF_CODES.get(check) ?? 0) |
				(required.includes(k) ? REQUIRED : 0) |
				(k in Object.prototype ? INHERITED : 0);
			entries.push(k, check, flags);
		}
		const extraRequired = required.filter((k) => !Object.hasOwn(properties, k));
		const pats = patternKeys.map((p) => [sharedRegex(p), this.check(patterns[p], base)] as const);
		const extra = additional === undefined || additional === true ? undefined : this.check(additional, base);
		if (pats.length === 0 && extraRequired.length === 0 && (extra === undefined || additional === false)) {
			const requiredCount = keys.filter((k) => required.includes(k)).length;
			return declaredObject(entries, requiredCount, additional === false, guard);
		}
		return openObject(entries, keys, extraRequired, pats, extra, guard);
	}

	private arrayGroup(node: SchemaObject, base: string, strict: boolean): Check | undefined {
		let prefix: readonly unknown[] = [];
		let rest: unknown;
		if (Array.isArray(node.items)) {
			prefix = node.items;
			rest = node.additionalItems;
		} else {
			if (this.draft !== "7" && Array.isArray(node.prefixItems)) prefix = node.prefixItems;
			rest = node.items;
		}
		const prefixChecks = prefix.map((s) => this.check(s, base));
		const restCheck = rest === undefined || rest === true ? undefined : this.check(rest, base);
		const minItems = number(node.minItems);
		const maxItems = number(node.maxItems);
		if (
			node.contains === undefined &&
			node.uniqueItems !== true &&
			(prefixChecks.length > 0 || restCheck !== undefined)
		) {
			// The common array: one closure for the guard, the length bounds and the items.
			const guard = strict ? GUARD_STRICT : GUARD_LOOSE;
			return listCheck(guard, minItems ?? 0, maxItems ?? Number.POSITIVE_INFINITY, prefixChecks, restCheck);
		}
		const parts: Check[] = [];
		if (prefixChecks.length > 0 || restCheck !== undefined) parts.push(itemsCheck(prefixChecks, restCheck));
		if (minItems !== undefined || maxItems !== undefined) {
			parts.push(lengthCheck(minItems ?? 0, maxItems ?? Number.POSITIVE_INFINITY));
		}
		if (node.contains !== undefined) {
			const min = this.draft === "7" ? 1 : (number(node.minContains) ?? 1);
			const max =
				this.draft === "7" ? Number.POSITIVE_INFINITY : (number(node.maxContains) ?? Number.POSITIVE_INFINITY);
			parts.push(containsCheck(this.check(node.contains, base), min, max));
		}
		if (node.uniqueItems === true) parts.push(uniqueCheck);
		if (parts.length === 0) return strict ? IS_ARRAY : undefined;
		return guardArray(and(parts), strict);
	}

	/** The annotating check of a schema evaluated in place (only below `unevaluatedProperties`/`unevaluatedItems`). */
	annotating(node: unknown, base: string): AnnotatingCheck {
		if (node === true) return ANNOTATING_TRUE;
		if (node === false) return ANNOTATING_FALSE;
		if (!isSchemaObject(node))
			throw new Error(`A schema must be an object or a boolean, got ${JSON.stringify(node)}`);
		const cached = this.annotatingCache.get(node);
		if (cached !== undefined) return cached;
		const slot: { check: AnnotatingCheck | undefined } = { check: undefined };
		this.annotatingCache.set(node, indirectAnnotating(slot));
		const check = this.buildAnnotating(node, this.r.baseFor(node, base));
		slot.check = check;
		this.annotatingCache.set(node, check);
		return check;
	}

	private buildAnnotating(node: SchemaObject, base: string): AnnotatingCheck {
		const rest: Record<string, unknown> = {};
		let annotates = false;
		for (const k of Object.keys(node)) {
			if (ANNOTATING.has(k)) annotates = true;
			else rest[k] = node[k];
		}
		const plain = this.plain(rest, base);
		const parts: AnnotatingCheck[] = [];
		if (annotates) this.annotatingParts(node, base, parts);
		const all = parts.length === 0 ? ignoreAnnotations(plain) : annotateAll(plain, parts);
		const own =
			node.unevaluatedProperties !== undefined || node.unevaluatedItems !== undefined
				? isolateAnnotations(all)
				: all;
		return this.dynamic && this.r.isResource(node, base) ? scopedAnnotating(this.scope, base, own) : own;
	}

	private annotatingParts(node: SchemaObject, base: string, parts: AnnotatingCheck[]): void {
		if (
			node.properties !== undefined ||
			node.patternProperties !== undefined ||
			node.additionalProperties !== undefined
		) {
			const props = entries(node.properties).map(([k, s]) => [k, this.check(s, base)] as const);
			const pats = entries(node.patternProperties).map(([p, s]) => [sharedRegex(p), this.check(s, base)] as const);
			const extra =
				node.additionalProperties === undefined ? undefined : this.check(node.additionalProperties, base);
			parts.push(annotateObject(props, pats, extra));
		}
		if (node.prefixItems !== undefined || node.items !== undefined || node.contains !== undefined) {
			const prefix = Array.isArray(node.prefixItems)
				? node.prefixItems
				: Array.isArray(node.items)
					? node.items
					: [];
			const rest = Array.isArray(node.items) ? node.additionalItems : node.items;
			parts.push(
				annotateArray(
					prefix.map((s) => this.check(s, base)),
					rest === undefined ? undefined : this.check(rest, base),
					node.contains === undefined ? undefined : this.check(node.contains, base),
					number(node.minContains) ?? 1,
					number(node.maxContains) ?? Number.POSITIVE_INFINITY,
				),
			);
		}
		if (Array.isArray(node.allOf)) for (const s of node.allOf) parts.push(this.annotating(s, base));
		if (Array.isArray(node.anyOf))
			parts.push(
				annotateAny(
					node.anyOf.map((s) => this.annotating(s, base)),
					false,
				),
			);
		if (Array.isArray(node.oneOf))
			parts.push(
				annotateAny(
					node.oneOf.map((s) => this.annotating(s, base)),
					true,
				),
			);
		if (node.if !== undefined) {
			const then = node.then === undefined ? undefined : this.annotating(node.then, base);
			const otherwise = node.else === undefined ? undefined : this.annotating(node.else, base);
			parts.push(annotateIf(this.annotating(node.if, base), then, otherwise));
		}
		if (typeof node.$ref === "string") parts.push(this.annotatingRef(node.$ref, base));
		if (typeof node.$dynamicRef === "string") parts.push(this.annotatingDynamicRef(node.$dynamicRef, base));
		for (const [k, s] of entries(node.dependentSchemas)) parts.push(annotateDependent(k, this.annotating(s, base)));
		if (node.unevaluatedProperties !== undefined) {
			parts.push(unevaluatedProperties(this.check(node.unevaluatedProperties, base)));
		}
		if (node.unevaluatedItems !== undefined) parts.push(unevaluatedItems(this.check(node.unevaluatedItems, base)));
	}

	private annotatingRef(ref: string, base: string): AnnotatingCheck {
		const target = this.r.resolve(ref, base);
		const check = this.annotating(target.node, target.base);
		return this.dynamic && target.base !== base ? scopedAnnotating(this.scope, target.base, check) : check;
	}

	private annotatingDynamicRef(ref: string, base: string): AnnotatingCheck {
		const resolved = this.bookended(ref, base);
		if (resolved === undefined) return this.annotatingRef(ref, base);
		const { initial, name } = resolved;
		const fallback = this.annotating(initial.node, initial.base);
		const lookup = this.dynamicLookup(name, (node, b) => this.annotating(node, b));
		const scope = this.scope;
		return (v, a) => {
			for (let i = 0; i < scope.length; i++) {
				const check = lookup(scope[i]);
				if (check !== null) return check(v, a);
			}
			return fallback(v, a);
		};
	}
}

/** Keywords that never affect a check. */
export const NEUTRAL_KEYWORDS = new Set([
	"$schema",
	"$comment",
	"title",
	"description",
	"default",
	"examples",
	"deprecated",
	"readOnly",
	"writeOnly",
	"$defs",
	"definitions",
	"contentEncoding",
	"contentMediaType",
	"minContains",
	"maxContains",
	"$vocabulary",
]);

// The object keywords besides the core (properties, required, patternProperties, additionalProperties).
const OBJECT_EXTRAS = [
	"propertyNames",
	"minProperties",
	"maxProperties",
	"dependentRequired",
	"dependentSchemas",
	"dependencies",
];

// The keywords an annotating check handles itself; every other keyword compiles into its plain part.
const ANNOTATING = new Set([
	"properties",
	"patternProperties",
	"additionalProperties",
	"prefixItems",
	"items",
	"additionalItems",
	"contains",
	"minContains",
	"maxContains",
	"allOf",
	"anyOf",
	"oneOf",
	"if",
	"then",
	"else",
	"$ref",
	"$dynamicRef",
	"dependentSchemas",
	"unevaluatedProperties",
	"unevaluatedItems",
]);

/** anyOf/oneOf whose branches are all `{ const: primitive }`: an enum (distinct values make oneOf the same). */
function constUnion(branches: readonly unknown[], exactlyOne: boolean): Check | undefined {
	const values: unknown[] = [];
	for (const branch of branches) {
		if (!isSchemaObject(branch) || !Object.hasOwn(branch, "const")) return undefined;
		for (const k of Object.keys(branch)) if (k !== "const" && !NEUTRAL_KEYWORDS.has(k)) return undefined;
		if (typeof branch.const === "object" && branch.const !== null) return undefined;
		if (exactlyOne && values.includes(branch.const)) return undefined;
		values.push(branch.const);
	}
	return enumCheck(values);
}

// The tag of a tagged-union branch: a primitive const on a required property of an object schema.
function tagOf(branch: SchemaObject, key: string): unknown {
	const properties = branch.properties;
	if (branch.type !== "object" || !Array.isArray(branch.required) || !branch.required.includes(key)) return undefined;
	const tag = isSchemaObject(properties) ? properties[key] : undefined;
	if (!isSchemaObject(tag) || !Object.hasOwn(tag, "const")) return undefined;
	return typeof tag.const === "object" && tag.const !== null ? undefined : tag.const;
}

function number(value: unknown): number | undefined {
	return typeof value === "number" ? value : undefined;
}

function entries(value: unknown): [string, unknown][] {
	return isSchemaObject(value) ? Object.entries(value) : [];
}

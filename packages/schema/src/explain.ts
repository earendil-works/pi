// Errors of a failed value: a walk over the schema that reports each failing keyword at the value it failed on.
// It runs only for values that failed the check, using the compiler's checks for subschemas.

import { newAnnotations } from "./annotations.ts";
import {
	codePoints,
	constCheck,
	containsCheck,
	enumCheck,
	isMultiple,
	isObject,
	NEVER,
	TYPE_CHECKS,
	uniqueCheck,
} from "./checks.ts";
import type { Compiler } from "./compiler.ts";
import { isSchemaObject } from "./resolver.ts";
import { sharedRegex } from "./shared.ts";
import type { SchemaObject, ValidationError } from "./types.ts";

/** Explains failures of one compiled schema. */
export class Explainer {
	private readonly c: Compiler;
	private readonly schema: unknown;
	/**
	 * The errors of `$ref` targets for object values, within one errors() call: a recursive union explains each branch
	 * to pick the one to blame, and every branch would explain the same children again, exponentially in the depth.
	 */
	private memo: Map<object, Map<object, { path: string; errors: ValidationError[] }>> | undefined = undefined;

	constructor(compiler: Compiler, schema: unknown) {
		this.c = compiler;
		this.schema = schema;
		compiler.root();
	}

	/** The errors of `value`, at least one (`value` failed the check). */
	errors(value: unknown): ValidationError[] {
		const out: ValidationError[] = [];
		try {
			this.walk(this.schema, this.c.r.rootBase, value, "", out);
		} finally {
			this.memo = undefined;
		}
		if (out.length === 0) out.push({ path: "", keyword: "schema", message: "invalid" });
		return out;
	}

	private ok(node: unknown, base: string, v: unknown): boolean {
		return this.c.check(node, base)(v);
	}

	// For $dynamicRef schemas this check runs outside the original dynamic scope, so their errors are approximate.
	private walk(node: unknown, base: string, v: unknown, path: string, out: ValidationError[]): void {
		if (node === true) return;
		if (node === false) {
			out.push({ path, keyword: "false", message: "no value is allowed here" });
			return;
		}
		if (!isSchemaObject(node)) return;
		const b = this.c.r.baseFor(node, base);
		if (this.ok(node, b, v)) return;
		const start = out.length;
		const push = (keyword: string, message: string, at = path) => {
			out.push({ path: at, keyword, message });
		};
		if (this.c.draft === "7" && typeof node.$ref === "string") {
			this.walkRef(node.$ref, b, v, path, out);
			return;
		}
		if (node.type !== undefined) {
			const types = Array.isArray(node.type) ? node.type : [node.type];
			const checks = types.map((t) => (typeof t === "string" ? TYPE_CHECKS.get(t) : undefined) ?? NEVER);
			if (!checks.some((check) => check(v))) {
				push("type", `expected ${types.join(" or ")}, got ${typeName(v)}`);
				return;
			}
		}
		if (Array.isArray(node.enum) && !enumCheck(node.enum)(v))
			push("enum", `expected one of ${listValues(node.enum)}`);
		if (Object.hasOwn(node, "const") && !constCheck(node.const)(v))
			push("const", `expected ${JSON.stringify(node.const)}`);
		if (typeof v === "string" && node.type !== "bytes") this.walkString(node, v, push);
		if (v instanceof Uint8Array && node.type === "bytes") this.walkBytes(node, v, push);
		if (typeof v === "number") this.walkNumber(node, v, push);
		if (isObject(v)) this.walkObject(node, b, v, path, out, push);
		if (Array.isArray(v)) this.walkArray(node, b, v, path, out, push);
		if (Array.isArray(node.allOf)) for (const s of node.allOf) this.walk(s, b, v, path, out);
		if (Array.isArray(node.anyOf)) this.walkUnion(node.anyOf, b, v, path, out, false);
		if (Array.isArray(node.oneOf)) this.walkUnion(node.oneOf, b, v, path, out, true);
		if (node.not !== undefined && this.ok(node.not, b, v)) push("not", "must not match the schema in not");
		if (node.if !== undefined) {
			const branch = this.ok(node.if, b, v) ? node.then : node.else;
			if (branch !== undefined) this.walk(branch, b, v, path, out);
		}
		if (typeof node.$ref === "string") this.walkRef(node.$ref, b, v, path, out);
		if (out.length === start && (node.unevaluatedProperties !== undefined || node.unevaluatedItems !== undefined)) {
			this.walkUnevaluated(node, b, v, path, out);
		}
		if (out.length === start && typeof node.$dynamicRef === "string") {
			push("$dynamicRef", "does not match the dynamically referenced schema");
		}
	}

	private walkRef(ref: string, base: string, v: unknown, path: string, out: ValidationError[]): void {
		const target = this.c.r.resolve(ref, base);
		if (target.node === false && this.c.r.isUnresolved(ref, base)) {
			out.push({ path, keyword: "$ref", message: `unresolved reference ${ref}` });
			return;
		}
		if (!isSchemaObject(target.node) || typeof v !== "object" || v === null) {
			this.walk(target.node, target.base, v, path, out);
			return;
		}
		this.memo ??= new Map();
		let values = this.memo.get(target.node);
		const known = values?.get(v);
		if (known !== undefined && known.path === path) {
			out.push(...known.errors);
			return;
		}
		const errors: ValidationError[] = [];
		this.walk(target.node, target.base, v, path, errors);
		if (values === undefined) {
			values = new Map();
			this.memo.set(target.node, values);
		}
		values.set(v, { path, errors });
		out.push(...errors);
	}

	private walkString(node: SchemaObject, v: string, push: Push): void {
		const n = codePoints(v);
		if (typeof node.minLength === "number" && n < node.minLength) {
			push("minLength", `expected at least ${node.minLength} characters`);
		}
		if (typeof node.maxLength === "number" && n > node.maxLength) {
			push("maxLength", `expected at most ${node.maxLength} characters`);
		}
		if (typeof node.pattern === "string" && !sharedRegex(node.pattern).test(v)) {
			push("pattern", `expected to match ${node.pattern}`);
		}
		const formats = this.c.formats;
		const format =
			formats !== undefined && typeof node.format === "string" && Object.hasOwn(formats, node.format)
				? formats[node.format]
				: undefined;
		if (format !== undefined && !format(v)) push("format", `expected format ${node.format}`);
	}

	private walkBytes(node: SchemaObject, v: Uint8Array, push: Push): void {
		if (typeof node.minLength === "number" && v.length < node.minLength) {
			push("minLength", `expected at least ${node.minLength} bytes`);
		}
		if (typeof node.maxLength === "number" && v.length > node.maxLength) {
			push("maxLength", `expected at most ${node.maxLength} bytes`);
		}
	}

	private walkNumber(node: SchemaObject, v: number, push: Push): void {
		if (typeof node.minimum === "number" && v < node.minimum) push("minimum", `expected >= ${node.minimum}`);
		if (typeof node.maximum === "number" && v > node.maximum) push("maximum", `expected <= ${node.maximum}`);
		if (typeof node.exclusiveMinimum === "number" && v <= node.exclusiveMinimum) {
			push("exclusiveMinimum", `expected > ${node.exclusiveMinimum}`);
		}
		if (typeof node.exclusiveMaximum === "number" && v >= node.exclusiveMaximum) {
			push("exclusiveMaximum", `expected < ${node.exclusiveMaximum}`);
		}
		if (typeof node.multipleOf === "number" && !isMultiple(v, node.multipleOf)) {
			push("multipleOf", `expected a multiple of ${node.multipleOf}`);
		}
	}

	private walkObject(
		node: SchemaObject,
		b: string,
		v: Record<string, unknown>,
		path: string,
		out: ValidationError[],
		push: Push,
	): void {
		const properties = isSchemaObject(node.properties) ? node.properties : {};
		const required = Array.isArray(node.required) ? node.required : [];
		for (const k of required) {
			if (typeof k === "string" && (!Object.hasOwn(v, k) || v[k] === undefined))
				push("required", "missing", pointer(path, k));
		}
		for (const k of Object.keys(properties)) {
			if (Object.hasOwn(v, k) && v[k] !== undefined) this.walk(properties[k], b, v[k], pointer(path, k), out);
		}
		const patterns = isSchemaObject(node.patternProperties) ? Object.entries(node.patternProperties) : [];
		for (const k of Object.keys(v)) {
			let matched = Object.hasOwn(properties, k);
			for (const [p, s] of patterns) {
				if (sharedRegex(p).test(k)) {
					matched = true;
					this.walk(s, b, v[k], pointer(path, k), out);
				}
			}
			if (!matched && node.additionalProperties !== undefined) {
				if (node.additionalProperties === false) push("additionalProperties", "unknown field", pointer(path, k));
				else this.walk(node.additionalProperties, b, v[k], pointer(path, k), out);
			}
			if (node.propertyNames !== undefined && !this.ok(node.propertyNames, b, k)) {
				push("propertyNames", "invalid property name", pointer(path, k));
			}
		}
		const count = Object.keys(v).length;
		if (typeof node.minProperties === "number" && count < node.minProperties) {
			push("minProperties", `expected at least ${node.minProperties} properties`);
		}
		if (typeof node.maxProperties === "number" && count > node.maxProperties) {
			push("maxProperties", `expected at most ${node.maxProperties} properties`);
		}
		const dependencies = {
			...(this.c.draft === "7" || !isSchemaObject(node.dependentRequired) ? {} : node.dependentRequired),
			...(isSchemaObject(node.dependencies) ? node.dependencies : {}),
		};
		for (const [k, d] of Object.entries(dependencies)) {
			if (!Object.hasOwn(v, k)) continue;
			if (!Array.isArray(d)) this.walk(d, b, v, path, out);
			else
				for (const r of d)
					if (!Object.hasOwn(v, r)) push("dependentRequired", `required when ${k} is present`, pointer(path, r));
		}
		if (this.c.draft !== "7" && isSchemaObject(node.dependentSchemas)) {
			for (const [k, s] of Object.entries(node.dependentSchemas))
				if (Object.hasOwn(v, k)) this.walk(s, b, v, path, out);
		}
	}

	private walkArray(
		node: SchemaObject,
		b: string,
		v: unknown[],
		path: string,
		out: ValidationError[],
		push: Push,
	): void {
		let prefix: readonly unknown[] = [];
		let rest: unknown;
		if (Array.isArray(node.items)) {
			prefix = node.items;
			rest = node.additionalItems;
		} else {
			if (this.c.draft !== "7" && Array.isArray(node.prefixItems)) prefix = node.prefixItems;
			rest = node.items;
		}
		for (let i = 0; i < v.length; i++) {
			const s = i < prefix.length ? prefix[i] : rest;
			if (s !== undefined) this.walk(s, b, v[i], `${path}/${i}`, out);
		}
		if (typeof node.minItems === "number" && v.length < node.minItems) {
			push("minItems", `expected at least ${node.minItems} items`);
		}
		if (typeof node.maxItems === "number" && v.length > node.maxItems) {
			push("maxItems", `expected at most ${node.maxItems} items`);
		}
		if (node.uniqueItems === true && !uniqueCheck(v)) push("uniqueItems", "expected unique items");
		if (node.contains !== undefined) {
			const draft7 = this.c.draft === "7";
			const min = draft7 || typeof node.minContains !== "number" ? 1 : node.minContains;
			const max = draft7 || typeof node.maxContains !== "number" ? Number.POSITIVE_INFINITY : node.maxContains;
			if (!containsCheck(this.c.check(node.contains, b), min, max)(v)) {
				push("contains", containsMessage(min, max));
			}
		}
	}

	private walkUnion(
		branches: readonly unknown[],
		b: string,
		v: unknown,
		path: string,
		out: ValidationError[],
		exactlyOne: boolean,
	): void {
		const matches = branches.filter((s) => this.ok(s, b, v)).length;
		if (matches === 1 || (!exactlyOne && matches > 0)) return;
		const keyword = exactlyOne ? "oneOf" : "anyOf";
		if (matches > 1) {
			out.push({ path, keyword, message: "matches more than one alternative" });
			return;
		}
		// A tagged union reports the branch its tag selects; otherwise the branch whose first error is deepest.
		const tag = this.tagOf(branches, b);
		if (tag !== undefined && isObject(v)) {
			const i = tag.values.indexOf(v[tag.key]);
			if (i < 0)
				out.push({
					path: pointer(path, tag.key),
					keyword,
					message: `expected one of ${listValues(tag.values)}`,
				});
			else this.walk(branches[i], b, v, path, out);
			return;
		}
		// An object is blamed on the branch that declares most of its properties (the one it was most likely meant for),
		// then on the branch whose first error is deepest.
		let best: { errors: ValidationError[]; declared: number } | undefined;
		for (const s of branches) {
			const errors: ValidationError[] = [];
			this.walk(s, b, v, path, errors);
			if (errors.length === 0) continue;
			const declared = isObject(v) ? this.declaredKeys(s, b, v) : 0;
			const better =
				best === undefined ||
				declared > best.declared ||
				(declared === best.declared && errors[0].path.length > best.errors[0].path.length);
			if (better) best = { errors, declared };
		}
		out.push(...(best?.errors ?? [{ path, keyword, message: "matches no alternative" }]));
	}

	/** How many of the keys of `v` the branch `s` (through a `$ref`) declares in `properties`. */
	private declaredKeys(s: unknown, b: string, v: Record<string, unknown>): number {
		const node = isSchemaObject(s) && typeof s.$ref === "string" ? this.c.r.resolve(s.$ref, b).node : s;
		const properties = isSchemaObject(node) && isSchemaObject(node.properties) ? node.properties : {};
		return Object.keys(v).filter((k) => Object.hasOwn(properties, k)).length;
	}

	private tagOf(branches: readonly unknown[], b: string): { key: string; values: unknown[] } | undefined {
		const resolved = branches.map((s) =>
			isSchemaObject(s) && typeof s.$ref === "string" ? this.c.r.resolve(s.$ref, b).node : s,
		);
		const first = resolved[0];
		if (!isSchemaObject(first) || !isSchemaObject(first.properties)) return undefined;
		for (const key of Object.keys(first.properties)) {
			const values = resolved.map((s) => {
				const tag = isSchemaObject(s) && isSchemaObject(s.properties) ? s.properties[key] : undefined;
				return isSchemaObject(tag) ? tag.const : undefined;
			});
			const primitive = values.every((x) => x !== undefined && (typeof x !== "object" || x === null));
			if (primitive && new Set(values).size === values.length) return { key, values };
		}
		return undefined;
	}

	private walkUnevaluated(node: SchemaObject, b: string, v: unknown, path: string, out: ValidationError[]): void {
		const { unevaluatedProperties, unevaluatedItems, ...rest } = node;
		const a = newAnnotations();
		this.c.annotating(rest, b)(v, a);
		if (isObject(v) && unevaluatedProperties !== undefined && !a.allProps) {
			for (const k of Object.keys(v)) {
				if (a.props?.has(k)) continue;
				if (unevaluatedProperties === false) {
					out.push({ path: pointer(path, k), keyword: "unevaluatedProperties", message: "unknown field" });
				} else this.walk(unevaluatedProperties, b, v[k], pointer(path, k), out);
			}
		}
		if (Array.isArray(v) && unevaluatedItems !== undefined && !a.allItems) {
			for (let i = a.items; i < v.length; i++) {
				if (a.indexes?.has(i)) continue;
				if (unevaluatedItems === false) {
					out.push({ path: `${path}/${i}`, keyword: "unevaluatedItems", message: "unexpected item" });
				} else this.walk(unevaluatedItems, b, v[i], `${path}/${i}`, out);
			}
		}
	}
}

type Push = (keyword: string, message: string, at?: string) => void;

// Enum errors name the allowed values; a long list (an enum of thousands) is cut, so the message stays readable.
const LISTED_VALUES = 20;

/** `values` as JSON, at most LISTED_VALUES of them, then how many more there are. */
function listValues(values: readonly unknown[]): string {
	if (values.length <= LISTED_VALUES) return JSON.stringify(values);
	const listed = JSON.stringify(values.slice(0, LISTED_VALUES));
	return `${listed.slice(0, -1)}, ... and ${values.length - LISTED_VALUES} more]`;
}

function containsMessage(min: number, max: number): string {
	if (max === Number.POSITIVE_INFINITY) return `expected at least ${min} matching ${min === 1 ? "item" : "items"}`;
	if (min === 0) return `expected at most ${max} matching ${max === 1 ? "item" : "items"}`;
	return `expected between ${min} and ${max} matching items`;
}

function pointer(path: string, key: string | number): string {
	return `${path}/${String(key).replace(/~/g, "~0").replace(/\//g, "~1")}`;
}

function typeName(v: unknown): string {
	if (v === null) return "null";
	if (Array.isArray(v)) return "array";
	if (v instanceof Uint8Array) return "bytes";
	if (typeof v === "number" && Number.isInteger(v)) return "integer";
	return typeof v;
}

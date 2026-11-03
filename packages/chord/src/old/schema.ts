import { compile, type JsonSchema, type ValidationError, type Validator } from "@earendil-works/pi-schema";
import { type ChordErrorReason, invalid } from "./errors.ts";

/** JSON Schema as data: pi-schema builders, or any JSON Schema object (TypeBox's included). */
type Schema = { readonly [key: string]: unknown };

const asSchema = (schema: unknown): Schema =>
	schema !== null && typeof schema === "object" ? (schema as Schema) : schema === false ? { not: {} } : {};

/** Canonical JSON: sorted object keys, `undefined` members dropped. */
export function canonicalJson(value: unknown): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
	if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
	const keys = Object.keys(value)
		.filter((key) => (value as Record<string, unknown>)[key] !== undefined)
		.sort();
	return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`).join(",")}}`;
}

/** Non-cryptographic 64-bit hash (two FNV-1a lanes). Contracts are trusted, so collisions are not an attack surface. */
export function hash64(text: string): string {
	let a = 0x811c9dc5;
	let b = 0x01000193 ^ 0x5bd1e995;
	for (let index = 0; index < text.length; index++) {
		const code = text.charCodeAt(index);
		a = Math.imul(a ^ code, 0x01000193);
		b = Math.imul(b ^ code, 0x5bd1e995) ^ (b >>> 13);
	}
	return (a >>> 0).toString(16).padStart(8, "0") + (b >>> 0).toString(16).padStart(8, "0");
}

export function deepEqual(a: unknown, b: unknown): boolean {
	return a === b || canonicalJson(a) === canonicalJson(b);
}

const validators = new WeakMap<object, Validator>();

/** The compiled validator of `schema`, compiled once per schema object; `format` is an annotation. */
function validatorOf(schema: JsonSchema): Validator {
	if (typeof schema === "boolean") return compile(schema);
	let validator = validators.get(schema);
	if (validator === undefined) {
		validator = compile(schema);
		validators.set(schema, validator);
	}
	return validator;
}

/** Whether `value` matches `schema`. */
export function isValid(schema: JsonSchema, value: unknown): boolean {
	return validatorOf(schema).check(value);
}

/** Throws `invalid` (with `reason`) and the first schema errors when `value` does not match. */
export function assertValid(reason: ChordErrorReason, what: string, schema: JsonSchema, value: unknown): void {
	const validator = validatorOf(schema);
	if (validator.check(value)) return;
	const errors: ValidationError[] = validator.errors(value).slice(0, 3);
	const summary = errors.map((error) => `${error.path || "/"} ${error.message}`).join("; ");
	throw invalid(reason, `${what}: ${summary}`, errors);
}

/** Applies defaults, strips unknown fields, validates. Returns a fresh value. */
export function normalize(schema: JsonSchema, value: unknown, what: string): unknown {
	const normalized = cleanFrom(asSchema(schema), withDefaults(asSchema(schema), cloneData(value ?? {})));
	assertValid("input", what, schema, normalized);
	return normalized;
}

/** A copy of `value` with only what `schema` knows: unknown object fields dropped, recursively (TypeBox's `Clean`). */
export function cleaned(schema: JsonSchema, value: unknown): unknown {
	return cleanFrom(asSchema(schema), cloneData(value));
}

/** A deep copy of plain data: arrays, plain objects and bytes are copied, any other value is kept. */
function cloneData(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(cloneData);
	if (value instanceof Uint8Array) return value.slice();
	if (value === null || typeof value !== "object") return value;
	const prototype = Object.getPrototypeOf(value);
	if (prototype !== Object.prototype && prototype !== null) return value;
	const copy: Record<string, unknown> = {};
	for (const [key, item] of Object.entries(value)) copy[key] = cloneData(item);
	return copy;
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
	value !== null && typeof value === "object" && !Array.isArray(value) && !(value instanceof Uint8Array);

const isSchemaObject = (value: unknown): value is Schema =>
	value !== null && typeof value === "object" && !Array.isArray(value);

/** The object an `allOf` of object schemas evaluates to (TypeBox's `Evaluate`), or undefined for any other `allOf`. */
function mergedAllOf(schema: Schema): Schema | undefined {
	if (!Array.isArray(schema.allOf) || !schema.allOf.every((branch) => isSchemaObject(branch.properties)))
		return undefined;
	const properties: Record<string, unknown> = {};
	const required = new Set<string>();
	for (const branch of schema.allOf as Schema[]) {
		Object.assign(properties, branch.properties);
		for (const key of (branch.required as string[] | undefined) ?? []) required.add(key);
	}
	return {
		type: "object",
		properties,
		required: [...required],
		...(schema.unevaluatedProperties === undefined ? {} : { additionalProperties: schema.unevaluatedProperties }),
	};
}

/** The pattern and value schema of a record (`patternProperties` with one pattern). */
function recordOf(schema: Schema): [RegExp, unknown] | undefined {
	if (!isSchemaObject(schema.patternProperties) || isSchemaObject(schema.properties)) return undefined;
	const [entry] = Object.entries(schema.patternProperties);
	return entry === undefined ? undefined : [new RegExp(entry[0], "u"), entry[1]];
}

/** Whether `additional` (an object's `additionalProperties`) keeps an unknown field holding `value`. */
const keepsUnknown = (additional: unknown, value: unknown): boolean =>
	additional === true || (isSchemaObject(additional) && isValid(additional, value));

// Mutates `value` (a fresh copy), as TypeBox's `Clean` does.
function cleanFrom(schema: Schema, value: unknown): unknown {
	const merged = mergedAllOf(schema);
	if (merged !== undefined) return cleanFrom(merged, value);
	if (Array.isArray(schema.anyOf)) {
		for (const branch of schema.anyOf) {
			const candidate = cleanFrom(asSchema(branch), cloneData(value));
			if (isValid(asSchema(branch), candidate)) return candidate;
		}
		return value;
	}
	if (Array.isArray(value)) {
		const prefix = Array.isArray(schema.items)
			? schema.items
			: Array.isArray(schema.prefixItems)
				? schema.prefixItems
				: undefined;
		if (prefix !== undefined) {
			const length = Math.min(value.length, prefix.length);
			for (let index = 0; index < length; index++) value[index] = cleanFrom(asSchema(prefix[index]), value[index]);
			return value.length > length ? value.slice(0, length) : value;
		}
		if (isSchemaObject(schema.items)) return value.map((item) => cleanFrom(schema.items as Schema, item));
		return value;
	}
	if (!isPlainObject(value)) return value;
	const record = recordOf(schema);
	const properties = isSchemaObject(schema.properties) ? schema.properties : undefined;
	// An object schema names its fields, a record its key pattern, a map (pi-schema's) its value schema.
	if (properties === undefined && record === undefined && !isSchemaObject(schema.additionalProperties)) return value;
	for (const key of Object.keys(value)) {
		const known = properties !== undefined && Object.hasOwn(properties, key) ? properties[key] : undefined;
		const matched = known ?? (record?.[0].test(key) ? record[1] : undefined);
		if (matched !== undefined) value[key] = cleanFrom(asSchema(matched), value[key]);
		else if (keepsUnknown(schema.additionalProperties, value[key]))
			value[key] = cleanFrom(asSchema(schema.additionalProperties), value[key]);
		else delete value[key];
	}
	return value;
}

// Mutates `value` (a fresh copy), as TypeBox's `Default` does: a missing value takes its schema's default, a
// missing optional field never does.
function withDefaults(schema: Schema, value: unknown): unknown {
	const defaulted = value === undefined && "default" in schema ? cloneData(schema.default) : value;
	const merged = mergedAllOf(schema);
	if (merged !== undefined) return withDefaults(merged, defaulted);
	if (Array.isArray(schema.anyOf)) {
		for (const branch of schema.anyOf) {
			const candidate = withDefaults(asSchema(branch), cloneData(defaulted));
			if (isValid(asSchema(branch), candidate)) return candidate;
		}
		return defaulted;
	}
	if (Array.isArray(defaulted)) {
		const prefix = Array.isArray(schema.items)
			? schema.items
			: Array.isArray(schema.prefixItems)
				? schema.prefixItems
				: undefined;
		if (prefix !== undefined) {
			for (let index = 0; index < prefix.length; index++) {
				const item = withDefaults(asSchema(prefix[index]), defaulted[index]);
				if (index < defaulted.length || item !== undefined) defaulted[index] = item;
			}
			return defaulted;
		}
		if (isSchemaObject(schema.items)) return defaulted.map((item) => withDefaults(schema.items as Schema, item));
		return defaulted;
	}
	if (!isPlainObject(defaulted)) return defaulted;
	const properties = isSchemaObject(schema.properties) ? schema.properties : undefined;
	const record = recordOf(schema);
	if (properties !== undefined) {
		const required = (schema.required as string[] | undefined) ?? [];
		for (const [key, property] of Object.entries(properties)) {
			const item = withDefaults(asSchema(property), defaulted[key]);
			if (item === undefined && (!required.includes(key) || !("default" in asSchema(property)))) continue;
			defaulted[key] = item;
		}
	} else if (record !== undefined && isSchemaObject(record[1]) && "default" in record[1]) {
		for (const key of Object.keys(defaulted)) {
			if (record[0].test(key)) defaulted[key] = withDefaults(record[1], defaulted[key]);
		}
	}
	if (!isSchemaObject(schema.additionalProperties)) return defaulted;
	for (const key of Object.keys(defaulted)) {
		const known = properties !== undefined && Object.hasOwn(properties, key);
		if (!known && !record?.[0].test(key)) defaulted[key] = withDefaults(schema.additionalProperties, defaulted[key]);
	}
	return defaulted;
}

/** Canonical identity of a normalized value: fields equal to their schema default are omitted. */
export function canonicalIdentity(schema: JsonSchema, value: unknown): string {
	return canonicalJson(stripDefaults(asSchema(schema), value));
}

function stripDefaults(schema: Schema, value: unknown): unknown {
	if (Array.isArray(value)) {
		const items = schema.items;
		if (Array.isArray(items)) return value.map((item, index) => stripDefaults(asSchema(items[index]), item));
		return value.map((item) => stripDefaults(asSchema(items), item));
	}
	if (value === null || typeof value !== "object") return value;
	const properties = asSchema(schema.properties);
	const result: Record<string, unknown> = {};
	for (const [key, item] of Object.entries(value)) {
		const property = asSchema(properties[key]);
		if ("default" in property && deepEqual(property.default, item)) continue;
		result[key] = stripDefaults(property, item);
	}
	return result;
}

const CONSTRAINTS = [
	"minLength",
	"maxLength",
	"pattern",
	"format",
	"minimum",
	"maximum",
	"exclusiveMinimum",
	"exclusiveMaximum",
	"multipleOf",
	"minItems",
	"maxItems",
	"uniqueItems",
	"minProperties",
	"maxProperties",
] as const;

const typesOf = (schema: Schema): string[] | undefined =>
	typeof schema.type === "string" ? [schema.type] : Array.isArray(schema.type) ? (schema.type as string[]) : undefined;

/** Keywords `fits` reasons about. Any other validation keyword in the provider's schema forces exact equality. */
const KNOWN: ReadonlySet<string> = new Set([
	...CONSTRAINTS,
	"type",
	"properties",
	"required",
	"additionalProperties",
	"patternProperties",
	"items",
	"additionalItems",
	"const",
	"enum",
	"anyOf",
	"parameters",
	"returnType",
]);

/** Annotations: no effect on validity. */
const ANNOTATIONS: ReadonlySet<string> = new Set([
	"title",
	"description",
	"default",
	"examples",
	"$id",
	"$schema",
	"$comment",
	"readOnly",
	"writeOnly",
	"deprecated",
]);

const withoutAnnotations = (schema: Schema): Schema =>
	Object.fromEntries(Object.entries(schema).filter(([key]) => !ANNOTATIONS.has(key)));

/**
 * Conservative structural subtyping: true only if every value valid under `sub` is valid under `sup`, where object
 * fields missing from `sub` but optional in `sup` count as fine (unknown fields are stripped at the provider, see
 * `RecordImpl.call`). A provider schema using a keyword this function does not model (`not`, `allOf`, `contains`,
 * `$ref`, ...) or an `additionalProperties` schema only fits an identical consumer schema.
 */
export function fits(subSchema: unknown, supSchema: unknown): boolean {
	const sub = withoutAnnotations(asSchema(subSchema));
	const sup = withoutAnnotations(asSchema(supSchema));
	if (Object.keys(sup).length === 0) return true;
	if (deepEqual(sub, sup)) return true;
	if (Object.keys(sup).some((key) => !KNOWN.has(key))) return false;
	if (sup.additionalProperties !== undefined && typeof sup.additionalProperties !== "boolean") return false;
	if (Array.isArray(sub.anyOf)) return sub.anyOf.every((branch) => fits(branch, sup));
	if (Array.isArray(sup.anyOf)) return sup.anyOf.some((branch) => fits(sub, branch));
	if ("const" in sup) return "const" in sub && deepEqual(sub.const, sup.const);
	if (Array.isArray(sup.enum)) {
		const values = "const" in sub ? [sub.const] : Array.isArray(sub.enum) ? sub.enum : undefined;
		return values?.every((item) => (sup.enum as unknown[]).some((allowed) => deepEqual(allowed, item))) ?? false;
	}
	for (const key of CONSTRAINTS) if (key in sup && !deepEqual(sub[key], sup[key])) return false;
	const supTypes = typesOf(sup);
	const subTypes = typesOf(sub);
	if (supTypes === undefined || subTypes === undefined) return false;
	if (!subTypes.every((type) => supTypes.includes(type) || (type === "integer" && supTypes.includes("number")))) {
		return false;
	}
	if ("const" in sub || Array.isArray(sub.enum)) return true;
	if (subTypes.includes("object") && !objectFits(sub, sup)) return false;
	if (subTypes.includes("array") && !arrayFits(sub, sup)) return false;
	if (subTypes.includes("function")) return functionFits(sub, sup);
	return true;
}

function objectFits(sub: Schema, sup: Schema): boolean {
	const subProperties = asSchema(sub.properties);
	const supProperties = asSchema(sup.properties);
	const subRequired = new Set((sub.required as string[] | undefined) ?? []);
	for (const key of (sup.required as string[] | undefined) ?? []) if (!subRequired.has(key)) return false;
	for (const [key, property] of Object.entries(supProperties)) {
		if (key in subProperties) {
			if (!fits(subProperties[key], property)) return false;
		} else if (typeof sub.additionalProperties === "object" && !fits(sub.additionalProperties, property)) {
			// The consumer may send this name with any value its `additionalProperties` allows. Open consumer objects
			// are fine: unknown names are stripped with the consumer's own schema before the call (`RecordImpl.call`).
			return false;
		}
	}
	if (sup.additionalProperties === false) {
		if (sub.additionalProperties !== false) return false;
		if (Object.keys(subProperties).some((key) => !(key in supProperties))) return false;
	}
	const supPatterns = asSchema(sup.patternProperties);
	if (Object.keys(supPatterns).length > 0) {
		// Every value the consumer may put under a matching name must fit, and the consumer must not allow arbitrary
		// extra names (it would then allow any value under a matching one).
		const subPatterns = asSchema(sub.patternProperties);
		if (sub.additionalProperties !== false && Object.keys(subPatterns).length === 0) return false;
		for (const [pattern, property] of Object.entries(supPatterns)) {
			const matcher = new RegExp(pattern, "u");
			for (const [key, subProperty] of Object.entries(subProperties)) {
				if (!(key in supProperties) && matcher.test(key) && !fits(subProperty, property)) return false;
			}
			if (
				Object.keys(subPatterns).length > 0 &&
				(!(pattern in subPatterns) || !fits(subPatterns[pattern], property))
			) {
				return false;
			}
		}
		for (const pattern of Object.keys(subPatterns)) if (!(pattern in supPatterns)) return false;
	}
	return true;
}

function arrayFits(sub: Schema, sup: Schema): boolean {
	if (Array.isArray(sup.items)) {
		if (!Array.isArray(sub.items) || sub.items.length !== sup.items.length) return false;
		return sub.items.every((item, index) => fits(item, (sup.items as unknown[])[index]));
	}
	if (Array.isArray(sub.items)) return sub.items.every((item) => fits(item, sup.items));
	return fits(sub.items, sup.items);
}

function functionFits(sub: Schema, sup: Schema): boolean {
	const subParameters = (sub.parameters as unknown[] | undefined) ?? [];
	const supParameters = (sup.parameters as unknown[] | undefined) ?? [];
	// A function accepting fewer parameters is fine; each shared parameter is contravariant.
	if (subParameters.length > supParameters.length) return false;
	if (!subParameters.every((parameter, index) => fits(supParameters[index], parameter))) return false;
	return fits(sub.returnType, sup.returnType);
}

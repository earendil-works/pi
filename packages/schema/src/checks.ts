// Check factories: each returns a closure that captures only its arguments, never the compiler, so a compiled
// schema keeps no compile-time state alive. Leaf checks are module constants that object and array loops inline.

import type { Check } from "./types.ts";

export const ALWAYS: Check = () => true;
export const NEVER: Check = () => false;
const IS_STRING: Check = (v) => typeof v === "string";
const IS_NUMBER: Check = (v) => typeof v === "number";
const IS_INTEGER: Check = (v) => Number.isInteger(v);
const IS_BOOLEAN: Check = (v) => typeof v === "boolean";
const IS_NULL: Check = (v) => v === null;
export const IS_ARRAY: Check = (v) => Array.isArray(v);
const IS_BYTES: Check = (v) => v instanceof Uint8Array;
export const IS_OBJECT: Check = (v) => isObject(v);

/** Whether `v` is a JSON object: not null, an array or bytes. */
export function isObject(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v) && !(v instanceof Uint8Array);
}

/** The check of a `type` name; `bytes` (a Uint8Array) extends JSON Schema for values that never pass through JSON. */
export const TYPE_CHECKS: ReadonlyMap<string, Check> = new Map([
	["string", IS_STRING],
	["number", IS_NUMBER],
	["integer", IS_INTEGER],
	["boolean", IS_BOOLEAN],
	["null", IS_NULL],
	["array", IS_ARRAY],
	["object", IS_OBJECT],
	["bytes", IS_BYTES],
]);

/** Leaf checks that object and array loops run inline by code instead of calling them. */
export const LEAF_CODES: ReadonlyMap<Check, number> = new Map([
	[IS_STRING, 1],
	[IS_NUMBER, 2],
	[IS_INTEGER, 3],
	[IS_BOOLEAN, 4],
	[IS_NULL, 5],
	[ALWAYS, 6],
]);

function leafOk(code: number, x: unknown): boolean {
	switch (code) {
		case 1:
			return typeof x === "string";
		case 2:
			return typeof x === "number";
		case 3:
			return Number.isInteger(x);
		case 4:
			return typeof x === "boolean";
		case 5:
			return x === null;
		default:
			return true;
	}
}

/** Whether a combined object or array check also checks the type: not at all, strictly, or passing other types. */
export const GUARD_NONE = 0;
export const GUARD_STRICT = 1;
export const GUARD_LOOSE = 2;
export type Guard = typeof GUARD_NONE | typeof GUARD_STRICT | typeof GUARD_LOOSE;

/** Flags of a declared property in an object check's entries: its leaf code and two bits. */
export const CODE = 7;
export const REQUIRED = 8;
export const INHERITED = 16;

/** All of `parts`; two and three parts get closures without a loop. */
export function and(parts: readonly Check[]): Check {
	switch (parts.length) {
		case 0:
			return ALWAYS;
		case 1:
			return parts[0];
		case 2: {
			const [a, b] = parts;
			return (v) => a(v) && b(v);
		}
		case 3: {
			const [a, b, c] = parts;
			return (v) => a(v) && b(v) && c(v);
		}
		default:
			return (v) => {
				for (let i = 0; i < parts.length; i++) if (!parts[i](v)) return false;
				return true;
			};
	}
}

/** A check whose implementation is set later: the indirection a recursive reference goes through. */
export function indirect(slot: { check: Check | undefined }): Check {
	return (v) => (slot.check as Check)(v);
}

/** `check` with `uri` pushed onto the dynamic scope while it runs (only for schemas with `$dynamicRef`). */
export function scopedCheck(scope: string[], uri: string, check: Check): Check {
	return (v) => {
		scope.push(uri);
		const ok = check(v);
		scope.pop();
		return ok;
	};
}

/** Any of the named types. */
export function typeCheck(types: readonly unknown[]): Check {
	const checks = types.map((t) => (typeof t === "string" ? TYPE_CHECKS.get(t) : undefined) ?? NEVER);
	if (checks.length === 1) return checks[0];
	return (v) => {
		for (let i = 0; i < checks.length; i++) if (checks[i](v)) return true;
		return false;
	};
}

/** A Uint8Array within the length bounds. */
export function bytesCheck(min: number, max: number): Check {
	return (v) => v instanceof Uint8Array && v.length >= min && v.length <= max;
}

/** The number of Unicode code points of `s`: JSON Schema string lengths count code points, not UTF-16 units. */
export function codePoints(s: string): number {
	let n = 0;
	for (let i = 0; i < s.length; i++, n++) {
		const c = s.charCodeAt(i);
		// A high surrogate starts a pair only when a low surrogate follows; an unpaired one is a code point of its own.
		if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
			const next = s.charCodeAt(i + 1);
			if (next >= 0xdc00 && next <= 0xdfff) i++;
		}
	}
	return n;
}

// UTF-16 units bound code points from both sides (units / 2 <= points <= units), so most strings need no count.
function lengthOk(s: string, min: number, max: number): boolean {
	const units = s.length;
	if (units < min) return false;
	if (units < 2 * min && codePoints(s) < min) return false;
	return units <= max || codePoints(s) <= max;
}

/** The string keywords: length bounds, pattern and format. */
export function stringCheck(
	strict: boolean,
	min: number,
	max: number,
	re: RegExp | undefined,
	format: ((value: string) => boolean) | undefined,
): Check {
	if (re !== undefined && min === 0 && max === Number.POSITIVE_INFINITY && format === undefined) {
		return strict ? (v) => typeof v === "string" && re.test(v) : (v) => typeof v !== "string" || re.test(v);
	}
	if (re === undefined && format === undefined) {
		return strict
			? (v) => typeof v === "string" && lengthOk(v, min, max)
			: (v) => typeof v !== "string" || lengthOk(v, min, max);
	}
	return (v) => {
		if (typeof v !== "string") return !strict;
		return lengthOk(v, min, max) && (re === undefined || re.test(v)) && (format === undefined || format(v));
	};
}

/** The number keywords. `mode`: 0 passes other types, 1 requires a number, 2 an integer. */
export function numberCheck(
	mode: 0 | 1 | 2,
	min: number,
	max: number,
	xmin: number,
	xmax: number,
	multipleOf: number | undefined,
): Check {
	return (v) => {
		if (typeof v !== "number") return mode === 0;
		if (mode === 2 && !Number.isInteger(v)) return false;
		return v >= min && v <= max && v > xmin && v < xmax && (multipleOf === undefined || isMultiple(v, multipleOf));
	};
}

/** Whether `v` is a multiple of `d`, exactly for decimals: 0.0075 / 0.0001 is 74.99999999999999 in floating point. */
export function isMultiple(v: number, d: number): boolean {
	const q = v / d;
	if (Number.isInteger(q)) return true;
	if (!Number.isFinite(q)) return v % d === 0;
	const [vc, ve] = decimal(v);
	const [dc, de] = decimal(d);
	return ve >= de ? (vc * 10n ** BigInt(ve - de)) % dc === 0n : vc % (dc * 10n ** BigInt(de - ve)) === 0n;
}

function decimal(x: number): [bigint, number] {
	const [mantissa, exponent = "0"] = Math.abs(x).toString().split("e");
	const point = mantissa.indexOf(".");
	const fraction = point < 0 ? 0 : mantissa.length - point - 1;
	return [BigInt(mantissa.replace(".", "")), Number(exponent) - fraction];
}

/** `inner` for objects; other values pass unless `strict`. */
export function guardObject(inner: Check, strict: boolean): Check {
	return strict ? (v) => isObject(v) && inner(v) : (v) => !isObject(v) || inner(v);
}

/** `inner` for arrays; other values pass unless `strict`. */
export function guardArray(inner: Check, strict: boolean): Check {
	return strict ? (v) => Array.isArray(v) && inner(v) : (v) => !Array.isArray(v) || inner(v);
}

/**
 * An object with declared properties: `entries` is `[key, check, flags]` per property. The value's own keys are
 * walked with for...in (whose `o[k]` V8 reads from the enum cache, unlike a load by a name from a list), each found
 * among the declared names; `closed` rejects any other key. A property whose value is `undefined` counts as absent.
 */
export function declaredObject(
	entries: readonly unknown[],
	requiredCount: number,
	closed: boolean,
	guard: Guard,
): Check {
	const n = entries.length;
	return (v) => {
		if (guard !== GUARD_NONE && !isObject(v)) return guard === GUARD_LOOSE;
		// Guarded: by the check above, or by the caller for GUARD_NONE.
		const o = v as Record<string, unknown>;
		let required = 0;
		for (const k in o) {
			let i = 0;
			while (i < n && entries[i] !== k) i += 3;
			if (i === n) {
				if (closed) return false;
				continue;
			}
			const x = o[k];
			if (x === undefined) continue;
			const f = entries[i + 2] as number;
			const c = f & CODE;
			if (c !== 0 ? !leafOk(c, x) : !(entries[i + 1] as Check)(x)) return false;
			if (f & REQUIRED) required++;
		}
		return required === requiredCount;
	};
}

/** An object with declared properties, required keys not declared, pattern properties and additional properties. */
export function openObject(
	entries: readonly unknown[],
	keys: readonly string[],
	extraRequired: readonly string[],
	patterns: readonly (readonly [RegExp, Check])[],
	additional: Check | undefined,
	guard: Guard,
): Check {
	const known = patterns.length > 0 || additional !== undefined ? new Set(keys) : undefined;
	return (v) => {
		if (guard !== GUARD_NONE && !isObject(v)) return guard === GUARD_LOOSE;
		const o = v as Record<string, unknown>;
		for (let i = 0; i < entries.length; i += 3) {
			const k = entries[i] as string;
			const x = o[k];
			const f = entries[i + 2] as number;
			if (x === undefined || (f & INHERITED && !Object.hasOwn(o, k))) {
				if (f & REQUIRED) return false;
				continue;
			}
			const c = f & CODE;
			if (c !== 0 ? !leafOk(c, x) : !(entries[i + 1] as Check)(x)) return false;
		}
		for (let i = 0; i < extraRequired.length; i++) if (!Object.hasOwn(o, extraRequired[i])) return false;
		if (known === undefined) return true;
		for (const k of Object.keys(o)) {
			let matched = known.has(k);
			for (let i = 0; i < patterns.length; i++) {
				if (patterns[i][0].test(k)) {
					matched = true;
					if (!patterns[i][1](o[k])) return false;
				}
			}
			if (!matched && additional !== undefined && !additional(o[k])) return false;
		}
		return true;
	};
}

/** Every property name passes `check` (`v` is an object). */
export function propertyNamesCheck(check: Check): Check {
	return (v) => {
		for (const k in v as object) if (!check(k)) return false;
		return true;
	};
}

/** `minProperties` and `maxProperties` (`v` is an object). */
export function propertyCountCheck(min: number, max: number): Check {
	return (v) => {
		let n = 0;
		for (const _ in v as object) n++;
		return n >= min && n <= max;
	};
}

/** `dependentRequired` (`v` is an object). */
export function dependentRequiredCheck(entries: readonly (readonly [string, readonly string[]])[]): Check {
	return (v) => {
		const o = v as object;
		for (const [k, list] of entries)
			if (Object.hasOwn(o, k)) for (const r of list) if (!Object.hasOwn(o, r)) return false;
		return true;
	};
}

/** `dependentSchemas` (`v` is an object). */
export function dependentSchemasCheck(entries: readonly (readonly [string, Check])[]): Check {
	return (v) => {
		for (const [k, check] of entries) if (Object.hasOwn(v as object, k) && !check(v)) return false;
		return true;
	};
}

/** The common array: guard, length bounds, prefix items and the items after them, in one closure. */
export function listCheck(
	guard: Guard,
	min: number,
	max: number,
	prefix: readonly Check[],
	rest: Check | undefined,
): Check {
	const n = prefix.length;
	const code = rest === undefined ? 0 : (LEAF_CODES.get(rest) ?? 0);
	return (v) => {
		if (!Array.isArray(v)) return guard === GUARD_LOOSE;
		const length = v.length;
		if (length < min || length > max) return false;
		const m = length < n ? length : n;
		for (let i = 0; i < m; i++) if (!prefix[i](v[i])) return false;
		if (rest === undefined) return true;
		if (code !== 0) {
			for (let i = n; i < length; i++) if (!leafOk(code, v[i])) return false;
			return true;
		}
		for (let i = n; i < length; i++) if (!rest(v[i])) return false;
		return true;
	};
}

/** Prefix items and the items after them (`v` is an array). */
export function itemsCheck(prefix: readonly Check[], rest: Check | undefined): Check {
	return listCheck(GUARD_NONE, 0, Number.POSITIVE_INFINITY, prefix, rest);
}

/** `minItems` and `maxItems` (`v` is an array). */
export function lengthCheck(min: number, max: number): Check {
	return (v) => (v as unknown[]).length >= min && (v as unknown[]).length <= max;
}

/** `contains` with its bounds (`v` is an array). */
export function containsCheck(check: Check, min: number, max: number): Check {
	return (v) => {
		const list = v as unknown[];
		let n = 0;
		for (let i = 0; i < list.length; i++) if (check(list[i]) && ++n > max) return false;
		return n >= min;
	};
}

/** `uniqueItems` (`v` is an array). */
export function uniqueCheck(v: unknown): boolean {
	const list = v as unknown[];
	for (let i = 1; i < list.length; i++) for (let j = 0; j < i; j++) if (deepEqual(list[i], list[j])) return false;
	return true;
}

/** `enum`: up to 8 primitives by a scan, more by a Set, objects and arrays by deep equality. */
export function enumCheck(values: readonly unknown[]): Check {
	const primitives = values.filter((x) => typeof x !== "object" || x === null);
	if (primitives.length === values.length && primitives.length <= 8) {
		return (v) => {
			for (let i = 0; i < primitives.length; i++) if (primitives[i] === v) return true;
			return false;
		};
	}
	const set = new Set(primitives);
	const objects = values.filter((x) => typeof x === "object" && x !== null);
	return (v) => set.has(v) || (typeof v === "object" && objects.some((o) => deepEqual(v, o)));
}

/** `const`. */
export function constCheck(value: unknown): Check {
	if (typeof value !== "object" || value === null) return (v) => v === value;
	return (v) => deepEqual(v, value);
}

/** `anyOf`. */
export function anyCheck(checks: readonly Check[]): Check {
	return (v) => {
		for (let i = 0; i < checks.length; i++) if (checks[i](v)) return true;
		return false;
	};
}

/** `oneOf`. */
export function oneCheck(checks: readonly Check[]): Check {
	return (v) => {
		let n = 0;
		for (let i = 0; i < checks.length; i++) if (checks[i](v) && ++n > 1) return false;
		return n === 1;
	};
}

/** `not`. */
export function notCheck(check: Check): Check {
	return (v) => !check(v);
}

/** `if`, `then` and `else`. */
export function ifCheck(cond: Check, then: Check, otherwise: Check): Check {
	return (v) => (cond(v) ? then(v) : otherwise(v));
}

/** A union of objects tagged by a const on `key`: the tag selects the one branch that can match. */
export function taggedCheck(key: string, tags: readonly unknown[], checks: readonly Check[]): Check {
	return (v) => {
		if (!isObject(v)) return false;
		const tag = v[key];
		for (let i = 0; i < tags.length; i++) if (tags[i] === tag) return checks[i](v);
		return false;
	};
}

/** JSON equality: same primitives, arrays with equal items in order, objects with the same keys and equal values. */
export function deepEqual(a: unknown, b: unknown): boolean {
	if (a === b) return true;
	if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
	const array = Array.isArray(a);
	if (array !== Array.isArray(b)) return false;
	if (array) {
		const x = a as unknown[];
		const y = b as unknown[];
		if (x.length !== y.length) return false;
		for (let i = 0; i < x.length; i++) if (!deepEqual(x[i], y[i])) return false;
		return true;
	}
	const x = a as Record<string, unknown>;
	const y = b as Record<string, unknown>;
	const keys = Object.keys(x);
	if (keys.length !== Object.keys(y).length) return false;
	for (const k of keys) if (!Object.hasOwn(y, k) || !deepEqual(x[k], y[k])) return false;
	return true;
}

// Principals: the app's caller identities, and the keys Chord derives from them.

import type { Context } from "../context/index.ts";
import type { JsonValue } from "../json.ts";
import { chordMetrics } from "../telemetry.ts";

/** An app's principal: plain JSON with a `kind`. Chord never persists it. */
export type Principal = { readonly kind: string; readonly [field: string]: JsonValue };

/** An app's own principal key; it must be the same function on every host. */
export type PrincipalKeyFunction<P extends Principal = Principal> = (principal: P) => string;

/**
 * The key of a principal: its canonical JSON, or `customKey(principal)`. Cached per principal object; a custom key's
 * cache is keyed by the function too, so a live principal never retains a dropped function.
 */
export function principalKey<P extends Principal>(
	principal: P,
	context: Context,
	customKey?: PrincipalKeyFunction<P>,
): string {
	const cache = customKey === undefined ? defaultKeys : customKeyCache(customKey);
	let key = cache.get(principal);
	if (key === undefined) {
		key = customKey === undefined ? canonicalJson(principal, context) : customKey(principal);
		cache.set(principal, key);
	}
	return key;
}

const defaultKeys = new WeakMap<Principal, string>();

/**
 * A principal's own JSON, as the wire carries it (its fields in insertion order): two principals give the same text
 * only when they serialize equally. Cached per principal object, one walk counted per object (decision "References
 * share one wire hold": the caller part of the sharing key).
 */
export function principalJson(principal: Principal, context: Context): string {
	let json = wireJson.get(principal);
	if (json === undefined) {
		chordMetrics(context.telemetry.metrics).counter("chord.data.walks").add(1);
		json = JSON.stringify(principal);
		wireJson.set(principal, json);
	}
	return json;
}

const wireJson = new WeakMap<Principal, string>();

const customKeys = new WeakMap<PrincipalKeyFunction<never>, WeakMap<Principal, string>>();

function customKeyCache(customKey: PrincipalKeyFunction<never>): WeakMap<Principal, string> {
	let cache = customKeys.get(customKey);
	if (cache === undefined) {
		cache = new WeakMap();
		customKeys.set(customKey, cache);
	}
	return cache;
}

/**
 * Canonical JSON: sorted object keys, `-0` written as `0`. Counts one walk. Built from its parts in one join, so the
 * text is one flat string: keys are kept (a decision's, a reader's arguments), and text concatenated piece by piece
 * is kept as the tree of its pieces (several times its size).
 */
export function canonicalJson(value: JsonValue, context: Context): string {
	chordMetrics(context.telemetry.metrics).counter("chord.data.walks").add(1);
	return canonicalText(value);
}

/** `canonicalJson` for a caller that counted its walk already (a decision's read counts one before it compares). */
export function canonicalText(value: JsonValue): string {
	// JSON.stringify writes -0 as 0.
	if (value === null || typeof value !== "object") return JSON.stringify(value);
	const parts: string[] = [];
	canonical(value, parts);
	return parts.join("");
}

/** Appends the canonical text of the array or object `value` to `parts`. */
function canonical(value: JsonValue[] | { readonly [key: string]: JsonValue }, parts: string[]): void {
	if (Array.isArray(value)) {
		parts.push("[");
		for (const [index, item] of value.entries()) {
			if (index > 0) parts.push(",");
			// What is no JSON (`undefined` in a list of plugin code's making) is written as nothing, as a join writes it.
			if (item !== null && typeof item === "object") canonical(item, parts);
			else parts.push(JSON.stringify(item) ?? "");
		}
		parts.push("]");
		return;
	}
	parts.push("{");
	for (const [index, key] of Object.keys(value).sort().entries()) {
		parts.push(index > 0 ? "," : "", JSON.stringify(key), ":");
		const field = value[key]!;
		if (field !== null && typeof field === "object") canonical(field, parts);
		else parts.push(`${JSON.stringify(field)}`);
	}
	parts.push("}");
}

/**
 * Whether `b` has the canonical JSON of `a`, decided without making text (AGENTS.md: never compare by serializing).
 * `a` is Chord's own copy of plain JSON (`copyPlainJson`); for `b` it says `equal` (keys in any order, `-0` as `0`),
 * `different`, or `odd`: `b` is no plain JSON within the bounds, which only canonical JSON's text compares. Plain JSON
 * is what canonical JSON writes without running anyone's code: finite numbers, strings, booleans, `null`, lists of
 * `Array.prototype` without an own `entries` (canonical JSON calls it) and objects of `Object.prototype` or none; at
 * most 16 deep and 256 values. It reads `b`'s own enumerable string keys and its lists' items, calls no method of
 * `b`'s and counts nothing. `skip` names a key of the outer objects left out of both.
 */
export function samePlainJson(a: unknown, b: unknown, skip?: string): PlainComparison {
	budget = PLAIN_VALUES;
	return comparePlain(a, b, PLAIN_DEPTH, skip);
}

/** What `samePlainJson` found for its second value. */
export type PlainComparison = "equal" | "different" | "odd";

/** The bounds of a direct comparison: the depth and the number of values of a small value (a decision's data). */
const PLAIN_DEPTH = 16;

const PLAIN_VALUES = 256;

/** The values a walk may still visit (one walk at a time: it calls no code of anyone's). */
let budget = 0;

function comparePlain(a: unknown, b: unknown, depth: number, skip: string | undefined): PlainComparison {
	if (--budget < 0) return "odd";
	switch (typeof b) {
		case "string":
		case "boolean":
			return a === b ? "equal" : "different";
		case "number":
			if (!Number.isFinite(b)) return "odd";
			return a === b ? "equal" : "different";
		case "object":
			break;
		default:
			return "odd";
	}
	if (b === null) return a === null ? "equal" : "different";
	if (depth === 0) return "odd";
	if (Array.isArray(b)) {
		if (!plainList(b)) return "odd";
		if (!Array.isArray(a) || a.length !== b.length) return "different";
		// Indexed: a for-of allocates an iterator per list.
		for (let index = 0; index < b.length; index++) {
			const item = comparePlain(a[index], b[index], depth - 1, undefined);
			if (item !== "equal") return item;
		}
		return "equal";
	}
	if (!plainPrototype(b)) return "odd";
	if (typeof a !== "object" || a === null || Array.isArray(a)) return "different";
	const left = a as { readonly [key: string]: unknown };
	const right = b as { readonly [key: string]: unknown };
	let keys = 0;
	// for-in with an own-enumerable filter (the keys `Object.keys` lists): `Object.keys` allocates its list.
	for (const key in right) {
		if (key === skip || !isEnumerable.call(right, key)) continue;
		if (!isEnumerable.call(left, key)) return "different";
		const field = comparePlain(left[key], right[key], depth - 1, undefined);
		if (field !== "equal") return field;
		keys++;
	}
	for (const key in left) if (key !== skip && isEnumerable.call(left, key)) keys--;
	return keys === 0 ? "equal" : "different";
}

const isEnumerable = Object.prototype.propertyIsEnumerable;

/** A list canonical JSON walks as Chord does: `Array.prototype`'s, its `entries` not its own. */
function plainList(list: readonly unknown[]): boolean {
	return Object.getPrototypeOf(list) === Array.prototype && !Object.hasOwn(list, "entries");
}

function plainPrototype(value: object): boolean {
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

/**
 * Chord's own copy of `value` when it is plain JSON (`samePlainJson`'s), else `undefined`: what a decision keeps to
 * compare later reads with, so nothing of the plugin's value is kept or read again. Objects are copied without a
 * prototype (an own `__proto__` key stays a key).
 */
export function copyPlainJson(value: unknown): unknown {
	budget = PLAIN_VALUES;
	const copy = copied(value, PLAIN_DEPTH);
	return copy === NOT_PLAIN ? undefined : copy;
}

/** No plain JSON: `copied`'s answer, never a value of JSON. */
const NOT_PLAIN: unique symbol = Symbol("not plain");

function copied(value: unknown, depth: number): unknown {
	if (--budget < 0) return NOT_PLAIN;
	switch (typeof value) {
		case "string":
		case "boolean":
			return value;
		case "number":
			return Number.isFinite(value) ? value : NOT_PLAIN;
		case "object":
			break;
		default:
			return NOT_PLAIN;
	}
	if (value === null) return null;
	if (depth === 0) return NOT_PLAIN;
	if (Array.isArray(value)) {
		if (!plainList(value)) return NOT_PLAIN;
		const list: unknown[] = [];
		for (let index = 0; index < value.length; index++) {
			const item = copied(value[index], depth - 1);
			if (item === NOT_PLAIN) return NOT_PLAIN;
			list.push(item);
		}
		return list;
	}
	if (!plainPrototype(value)) return NOT_PLAIN;
	const fields = value as { readonly [key: string]: unknown };
	const copy: { [key: string]: unknown } = Object.create(null);
	for (const key in fields) {
		if (!isEnumerable.call(fields, key)) continue;
		const field = copied(fields[key], depth - 1);
		if (field === NOT_PLAIN) return NOT_PLAIN;
		copy[key] = field;
	}
	return copy;
}

/**
 * Whether `principal` is `other`: the same default key (canonical JSON), each computed once per principal object; no
 * principal (`undefined`) is none.
 */
export function samePrincipal(principal: Principal | undefined, other: Principal, context: Context): boolean {
	return principal !== undefined && principalKey(principal, context) === principalKey(other, context);
}

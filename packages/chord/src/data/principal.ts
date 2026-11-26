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
 * Whether `b` has the canonical JSON of `a` (`canonicalJson`), decided without making text (AGENTS.md: never compare
 * by serializing): keys in any order, `-0` as `0`, a non-finite number as `null`, what is no JSON as canonical JSON
 * writes it (nothing in a list, `undefined` in an object). `a` was walked before (`canonicalJson` or `walkJson`): a
 * part of `b` that is the same object is equal at once. Throws where canonical JSON of `b` would (a bigint). Counts
 * nothing: its caller counts the walk. `skip` names a key of the outer objects left out of both.
 */
export function sameJson(a: unknown, b: unknown, skip?: string): boolean {
	if (skip !== undefined && isObject(a) && isObject(b) && !Array.isArray(a) && !Array.isArray(b)) {
		return sameFields(a, b, skip);
	}
	return sameAt(a, b, TOP);
}

/** Where a value is written: the text of what is no JSON depends on it (`canonicalJson`, `canonical`). */
type Place = typeof TOP | typeof ITEM | typeof FIELD;

const TOP = 0;

const ITEM = 1;

const FIELD = 2;

function sameAt(a: unknown, b: unknown, place: Place): boolean {
	if (a === b) return true;
	if (isObject(a) && isObject(b)) {
		if (Array.isArray(a)) return Array.isArray(b) && sameItems(a, b);
		return !Array.isArray(b) && sameFields(a, b, undefined);
	}
	// A function's or bigint's text is what JSON.stringify makes of it (its toJSON, or a throw): compared as text.
	if (byText(a) || byText(b)) return textAt(a, place) === textAt(b, place);
	if (isObject(a) || isObject(b)) return false;
	const kind = primitiveKind(a);
	return kind !== VALUE && kind === primitiveKind(b);
}

function isObject(value: unknown): value is object {
	return typeof value === "object" && value !== null;
}

function byText(value: unknown): boolean {
	return typeof value === "function" || typeof value === "bigint";
}

/** A primitive other than an equal one with the same text: `null` (non-finite numbers too), or none (`undefined`). */
function primitiveKind(value: unknown): typeof VALUE | typeof NULL | typeof NONE {
	if (value === null || (typeof value === "number" && !Number.isFinite(value))) return NULL;
	return value === undefined || typeof value === "symbol" ? NONE : VALUE;
}

const VALUE = 0;

const NULL = 1;

const NONE = 2;

/** Lists: the same length and items, or no items against one item written as nothing (`[]` and `[undefined]`). */
function sameItems(a: readonly unknown[], b: readonly unknown[]): boolean {
	if (a.length !== b.length) {
		if (a.length + b.length !== 1) return false;
		const item = a.length === 1 ? a[0] : b[0];
		return !isObject(item) && textAt(item, ITEM) === "";
	}
	// Indexed: a for-of allocates an iterator per list.
	for (let index = 0; index < a.length; index++) if (!sameAt(a[index], b[index], ITEM)) return false;
	return true;
}

/** Objects: the same own enumerable keys (`Object.keys`), each with the same value; `skip` left out. */
function sameFields(a: object, b: object, skip: string | undefined): boolean {
	const left = a as { readonly [key: string]: unknown };
	const right = b as { readonly [key: string]: unknown };
	let keys = 0;
	// for-in with an own-enumerable filter: `Object.keys` allocates its list.
	for (const key in right) {
		if (key === skip || !isEnumerable.call(right, key)) continue;
		if (!isEnumerable.call(left, key) || !sameAt(left[key], right[key], FIELD)) return false;
		keys++;
	}
	for (const key in left) if (key !== skip && isEnumerable.call(left, key)) keys--;
	return keys === 0;
}

const isEnumerable = Object.prototype.propertyIsEnumerable;

/** The text canonical JSON writes for `value` at `place` (only for what `sameAt` cannot tell apart otherwise). */
function textAt(value: unknown, place: Place): string | undefined {
	if (isObject(value)) {
		const parts: string[] = [];
		canonical(value as JsonValue[] | { readonly [key: string]: JsonValue }, parts);
		return parts.join("");
	}
	const text = JSON.stringify(value);
	if (place === TOP) return text;
	return place === ITEM ? (text ?? "") : `${text}`;
}

/**
 * Walks `value` as `canonicalJson` does, making no text: it throws where that throws (a bigint, a cycle), for a value
 * kept to be compared by `sameJson` later. Counts nothing: its caller counts the walk.
 */
export function walkJson(value: unknown): void {
	if (!isObject(value)) {
		if (byText(value)) JSON.stringify(value);
		return;
	}
	if (Array.isArray(value)) {
		for (let index = 0; index < value.length; index++) walkJson(value[index]);
		return;
	}
	const fields = value as { readonly [key: string]: unknown };
	for (const key in fields) if (isEnumerable.call(fields, key)) walkJson(fields[key]);
}

/**
 * Whether `principal` is `other`: the same default key (canonical JSON), each computed once per principal object; no
 * principal (`undefined`) is none.
 */
export function samePrincipal(principal: Principal | undefined, other: Principal, context: Context): boolean {
	return principal !== undefined && principalKey(principal, context) === principalKey(other, context);
}

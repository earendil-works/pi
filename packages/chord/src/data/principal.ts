// Principals: the app's caller identities, and the keys Chord derives from them.

import type { Context } from "../context/index.ts";
import type { JsonValue } from "../json.ts";
import { chordMetrics } from "../telemetry.ts";
import { invalid } from "./errors.ts";

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
	return canonicalText(value, TAKES_ANY, context);
}

/**
 * `canonicalJson` of a value that must be strict JSON as `isJsonValue` (`json.ts`) has it, refusing in the same walk
 * what is none (`invalid/args`: bytes, a function, `undefined`, a number that is not finite, an object of a class, an
 * array with other properties than its indexes, an accessor, a symbol key, a cycle): a named query's arguments, which
 * plugin code may pass past a schema that checks nothing (readers with equal texts share one read).
 */
export function canonicalJsonOnly(value: unknown, context: Context): string {
	return canonicalText(value as JsonValue, new StrictJson(), context);
}

/** What a canonical walk does with each value before writing it (nothing, or refuse it) and after writing an object. */
type Check = { enter(value: unknown): void; leave(value: object): void };

const TAKES_ANY: Check = { enter: () => {}, leave: () => {} };

/**
 * The rules of `isJsonValue` (`json.ts`), node by node as the canonical walk reaches each value: each node's own
 * properties are checked, its values when the walk enters them.
 */
class StrictJson implements Check {
	/** The objects being written: one entered again is a cycle. */
	readonly #ancestors = new Set<object>();

	enter(value: unknown): void {
		if (value === null || typeof value === "string" || typeof value === "boolean") return;
		if (typeof value === "number") {
			if (!Number.isFinite(value)) refuse(String(value));
			return;
		}
		if (typeof value !== "object") refuse(typeof value === "function" ? "a function" : String(value));
		if (Array.isArray(value)) {
			const keys = Reflect.ownKeys(value);
			// Indexes and `length` only: an extra, a symbol or a missing index changes the count or the kinds.
			if (Object.getPrototypeOf(value) !== Array.prototype) refuse("an array of a class");
			if (keys.length !== value.length + 1 || keys.some((key) => typeof key !== "string")) {
				refuse("an array with other properties than its items");
			}
			for (let index = 0; index < value.length; index++) dataProperty(value, String(index));
		} else {
			const prototype = Object.getPrototypeOf(value);
			if (prototype !== Object.prototype && prototype !== null) {
				refuse(value instanceof Uint8Array ? "bytes" : "an object of a class");
			}
			for (const key of Reflect.ownKeys(value)) {
				if (typeof key === "symbol") refuse("a symbol key");
				dataProperty(value, key);
			}
		}
		if (this.#ancestors.has(value)) refuse("a cycle");
		this.#ancestors.add(value);
	}

	leave(value: object): void {
		this.#ancestors.delete(value);
	}
}

/** Refuses an accessor or a property that is not enumerable. */
function dataProperty(value: object, key: string): void {
	const descriptor = Object.getOwnPropertyDescriptor(value, key);
	if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
		refuse(`a property "${key}" that is no enumerable data`);
	}
}

function refuse(what: string): never {
	throw invalid("args", `a query's arguments are JSON only, not ${what}`);
}

function canonicalText(value: JsonValue, check: Check, context: Context): string {
	chordMetrics(context.telemetry.metrics).counter("chord.data.walks").add(1);
	check.enter(value);
	// JSON.stringify writes -0 as 0.
	if (value === null || typeof value !== "object") return JSON.stringify(value);
	const parts: string[] = [];
	canonical(value, parts, check);
	check.leave(value);
	return parts.join("");
}

/** Appends the canonical text of the array or object `value` to `parts`, each value inside it checked first. */
function canonical(value: JsonValue[] | { readonly [key: string]: JsonValue }, parts: string[], check: Check): void {
	if (Array.isArray(value)) {
		parts.push("[");
		for (const [index, item] of value.entries()) {
			if (index > 0) parts.push(",");
			check.enter(item);
			// What is no JSON (`undefined` in a list of plugin code's making) is written as nothing, as a join writes it.
			if (item !== null && typeof item === "object") {
				canonical(item, parts, check);
				check.leave(item);
			} else parts.push(JSON.stringify(item) ?? "");
		}
		parts.push("]");
		return;
	}
	parts.push("{");
	for (const [index, key] of Object.keys(value).sort().entries()) {
		parts.push(index > 0 ? "," : "", JSON.stringify(key), ":");
		const field = value[key]!;
		check.enter(field);
		if (field !== null && typeof field === "object") {
			canonical(field, parts, check);
			check.leave(field);
		} else parts.push(`${JSON.stringify(field)}`);
	}
	parts.push("}");
}

/**
 * Whether `principal` is `other`: the same default key (canonical JSON), each computed once per principal object; no
 * principal (`undefined`) is none.
 */
export function samePrincipal(principal: Principal | undefined, other: Principal, context: Context): boolean {
	return principal !== undefined && principalKey(principal, context) === principalKey(other, context);
}

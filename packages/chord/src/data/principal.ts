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

/** Canonical JSON: sorted object keys, `-0` written as `0`. Counts one walk. */
export function canonicalJson(value: JsonValue, context: Context): string {
	chordMetrics(context.telemetry.metrics).counter("chord.data.walks").add(1);
	return canonical(value);
}

function canonical(value: JsonValue): string {
	// JSON.stringify writes -0 as 0.
	if (value === null || typeof value !== "object") return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
	const fields = Object.keys(value)
		.sort()
		.map((key) => `${JSON.stringify(key)}:${canonical(value[key]!)}`);
	return `{${fields.join(",")}}`;
}

/**
 * Whether `principal` is `other`: the same default key (canonical JSON), each computed once per principal object; no
 * principal (`undefined`) is none.
 */
export function samePrincipal(principal: Principal | undefined, other: Principal, context: Context): boolean {
	return principal !== undefined && principalKey(principal, context) === principalKey(other, context);
}

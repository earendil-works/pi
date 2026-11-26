// Plain JSON kept and compared without text (AGENTS.md: never compare values by serializing them): Chord's own copy of
// a value read from plugin code, and whether a later value is equal to it. Values are plain data (the owner's rule of
// the hot-path pass: plain objects and arrays, data properties only, nothing a JSON text cannot hold).

/**
 * Whether `value` is the plain JSON `kept` is, as their canonical JSON texts were the same: object keys in any order,
 * `-0` as `0`, a field that is missing other than one that is `undefined`. `skip` names a key of the outer objects left
 * out of both. Allocates nothing and counts nothing: its caller counts the walk.
 */
export function sameJson(kept: unknown, value: unknown, skip?: string): boolean {
	if (kept === value) return true;
	if (typeof kept !== "object" || kept === null || typeof value !== "object" || value === null) return false;
	if (Array.isArray(kept)) {
		if (!Array.isArray(value) || kept.length !== value.length) return false;
		// Indexed: a for-of allocates an iterator per list.
		for (let index = 0; index < kept.length; index++) if (!sameJson(kept[index], value[index])) return false;
		return true;
	}
	if (Array.isArray(value)) return false;
	const left = kept as { readonly [key: string]: unknown };
	const right = value as { readonly [key: string]: unknown };
	let keys = 0;
	// for-in: `Object.keys` allocates its list. Own keys only: a `__proto__` key is a key.
	for (const key in right) {
		if (key === skip) continue;
		if (!Object.hasOwn(left, key) || !sameJson(left[key], right[key])) return false;
		keys++;
	}
	for (const key in left) if (key !== skip) keys--;
	return keys === 0;
}

/**
 * Chord's own copy of the plain JSON `value`, what a decision keeps to compare later reads with: never the plugin's
 * object, which it may change in place or let go. An own `__proto__` key stays a key (an assignment would set the
 * copy's prototype). Never written: copies of objects without fields are one shared object.
 */
export function copyJson(value: unknown): unknown {
	if (typeof value !== "object" || value === null) return value;
	if (Array.isArray(value)) return value.map(copyJson);
	const fields = value as { readonly [key: string]: unknown };
	// Made by the first field: every object without one shares one empty copy (a decision's data is often none).
	let copy: { [key: string]: unknown } | undefined;
	for (const key in fields) {
		copy ??= {};
		if (key === "__proto__") {
			Object.defineProperty(copy, key, {
				value: copyJson(fields[key]),
				enumerable: true,
				writable: true,
				configurable: true,
			});
		} else copy[key] = copyJson(fields[key]);
	}
	return copy ?? NO_FIELDS;
}

/** The copy of every object without fields: shared, never written. */
const NO_FIELDS: { readonly [key: string]: unknown } = {};

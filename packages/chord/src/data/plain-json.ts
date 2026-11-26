// Plain JSON compared without text (AGENTS.md: never compare values by serializing them): whether a value read from
// plugin code is equal to one read before. Values are plain data, immutable by convention (the owner's rules of the
// hot-path pass: plain objects and arrays, data properties only, nothing a JSON text cannot hold).

/**
 * Whether `value` is the plain JSON `kept` is (a value read before), as their canonical JSON texts were the same: object keys in any order,
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

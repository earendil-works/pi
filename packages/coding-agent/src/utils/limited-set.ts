/**
 * Add a key to a Set while keeping only the newest `maxSize` entries.
 *
 * The caller owns `order`, which must contain keys in insertion order.
 * Returns true if the key was newly added.
 */
export function addToLimitedSet(set: Set<string>, order: string[], key: string, maxSize: number): boolean {
	if (set.has(key)) return false;

	set.add(key);
	order.push(key);

	while (order.length > maxSize) {
		const oldest = order.shift();
		if (oldest !== undefined) {
			set.delete(oldest);
		}
	}

	return true;
}

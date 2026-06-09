export type NormalizedOption = { label: string; description?: string };

export function normalizeOptions(input: unknown): NormalizedOption[] {
	// null/undefined → []
	if (input == null) return [];

	// Recursively unwrap .item until we hit an array
	let options: unknown = input;
	while (options != null && typeof options === 'object' && !Array.isArray(options) && 'item' in options) {
		options = (options as { item: unknown }).item;
	}

	// Not an array after unwrapping → []
	if (!Array.isArray(options)) return [];

	// Validate and normalize each item
	const result: NormalizedOption[] = [];
	for (const item of options) {
		if (item == null || typeof item !== 'object') continue;
		const obj = item as Record<string, unknown>;
		if (typeof obj.label !== 'string') continue;
		result.push({
			label: obj.label,
			description: typeof obj.description === 'string' ? obj.description : undefined,
		});
	}
	return result;
}

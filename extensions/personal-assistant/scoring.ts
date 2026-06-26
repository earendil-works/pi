const MAX_ALIAS_DEPTH = 10;

function isPlainObject(value: unknown): value is Record<string, string> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function foldToken(token: string, aliases: Record<string, string>): string {
	const visited = new Set<string>([token]);
	let current = token;
	for (let i = 0; i < MAX_ALIAS_DEPTH; i++) {
		const forward = aliases[current];
		if (forward !== undefined) {
			if (visited.has(forward)) return current;
			visited.add(forward);
			current = forward;
			continue;
		}
		let reverseKey: string | undefined;
		for (const key in aliases) {
			if (aliases[key] === current) {
				reverseKey = key;
				break;
			}
		}
		if (reverseKey === undefined) return current;
		if (visited.has(reverseKey)) return current;
		visited.add(reverseKey);
		current = reverseKey;
	}
	return current;
}

export function computeTagOverlap(
	query: string,
	tags: string[],
	queryAliases?: Record<string, string> | null,
): number {
	const aliasMap = isPlainObject(queryAliases) ? queryAliases : null;
	const tokens = query
		.split(/\s+/)
		.map((t) => t.toLowerCase())
		.filter((t) => t.length > 0);
	if (tokens.length === 0) return 0;
	const tagSet = new Set(tags.map((t) => t.toLowerCase()));
	let hits = 0;
	for (const token of tokens) {
		const folded = aliasMap ? foldToken(token, aliasMap) : token;
		if (tagSet.has(folded)) hits++;
	}
	return hits / tokens.length;
}

export function computeFreshness(updatedAt: number, now: number = Date.now()): number {
	const daysSinceUpdate = (now - updatedAt) / (1000 * 60 * 60 * 24);
	return Math.exp(-daysSinceUpdate / 30);
}

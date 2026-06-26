const MAX_ALIAS_DEPTH = 10;

function isPlainObject(value: unknown): value is Record<string, string> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function resolveAlias(
	tag: string,
	aliases: Record<string, string>,
	visited: Set<string>,
): string {
	let current = tag;
	for (let i = 0; i < MAX_ALIAS_DEPTH; i++) {
		const next = aliases[current];
		if (next === undefined) return current;
		if (visited.has(next)) return current;
		visited.add(next);
		current = next;
	}
	return current;
}

export function normalizeTags(
	input: string[],
	aliases?: Record<string, string> | null,
): string[] {
	const useAliases = isPlainObject(aliases);
	const aliasMap = useAliases ? (aliases as Record<string, string>) : null;

	const seen = new Set<string>();
	const result: string[] = [];

	for (const raw of input) {
		const trimmed = raw.trim();
		if (trimmed.length === 0) continue;
		const folded = aliasMap ? resolveAlias(trimmed, aliasMap, new Set([trimmed])) : trimmed;
		if (seen.has(folded)) continue;
		seen.add(folded);
		result.push(folded);
	}

	return result;
}

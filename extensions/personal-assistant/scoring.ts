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

/** Multiplicative boost weights for the score formula (Decision 8 in search.ts). */
const STRENGTH_WEIGHT = 0.3;
const IMPORTANCE_WEIGHT = 0.2;

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

/**
 * Inputs the score formula reads from an atom. Narrower than `MemoryAtom`
 * so callers (and tests) can build a partial atom instead of hydrating a
 * full DB row.
 */
export interface ScorableAtom {
	strength: number;
	importance: number;
	updated_at: number;
	tags: string[];
}

/**
 * Options the score formula consumes. Defaults match the canonical
 * `search.ts` weights; pass `now` to make the freshness term deterministic
 * in tests.
 */
export interface ScoreOptions {
	tagOverlapWeight?: number;
	freshnessWeight?: number;
	tagAliases?: Record<string, string> | null;
	now?: number;
}

/**
 * Result of the score formula. `tagOverlap` and `freshness` are exposed for
 * debug visibility (the UI / memory surface wants to know why an atom
 * ranked the way it did); `score` is the rank value used for ordering.
 */
export interface ScoredAtom {
	score: number;
	tagOverlap: number;
	freshness: number;
}

/**
 * Compute the ranking score for a single candidate atom. Formula:
 *
 *   score = cosine × (1 + 0.3 × strength + 0.2 × importance)
 *         + wTag × tagOverlap
 *         + wFreshness × freshness
 *
 * The multiplicative anchor is preserved verbatim from the dense-only era
 * (Decision 8 in search.ts): cosine=0 forces that term to 0 regardless of
 * strength/importance, so an unrelated atom cannot outrank a relevant one
 * via the additive knobs. Default weights (0.10 / 0.05) cap the additive
 * contribution at +0.15, which is why the additive terms are tuning
 * signals (keyword-rescue, recency) rather than primary ranking drivers.
 */
export function computeScore(
	cosine: number,
	atom: ScorableAtom,
	querySegment: string,
	options: ScoreOptions = {},
): ScoredAtom {
	const wTag = options.tagOverlapWeight ?? 0.10;
	const wFreshness = options.freshnessWeight ?? 0.05;
	const tagOverlap = computeTagOverlap(querySegment, atom.tags, options.tagAliases);
	const freshness = computeFreshness(atom.updated_at, options.now);
	const score =
		cosine * (1 + STRENGTH_WEIGHT * atom.strength + IMPORTANCE_WEIGHT * atom.importance) +
		wTag * tagOverlap +
		wFreshness * freshness;
	return { score, tagOverlap, freshness };
}

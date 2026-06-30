// Single source of truth for the v2 memory atom data model.
//
// All other modules (storage, embed, file-store, extraction, search, format,
// decay, webui routes) import their atom-related types from this file.
//
// Design constraints (from docs/sdd/changes/memory-v2-refactor):
//   - Exactly 3 atom categories: rule / fact / process.
//   - Atoms use the supersede chain: is_latest (0|1), parent_id, superseded_at.
//   - Strength starts at importance and is decay-modulated at read time.
//   - Tags are stored as a JSON-encoded string in sqlite, parsed on hydration.
//   - is_latest / archived are the integer union (0|1), not boolean, so that
//     values round-trip exactly with better-sqlite3 / sqlite-vec row returns.

// ---------------------------------------------------------------------------
// Type unions
// ---------------------------------------------------------------------------

/** The three canonical atom categories. v1's wider set is intentionally dropped. */
export type MemoryAtomType = "rule" | "fact" | "process";

// ---------------------------------------------------------------------------
// Core atom shape
// ---------------------------------------------------------------------------

/** Canonical atom record. One row per atom version; superseded rows are kept. */
export interface MemoryAtom {
	/** UUID v4 (crypto.randomUUID()). Stable across the atom's full version chain. */
	id: string;
	type: MemoryAtomType;
	title: string;
	content: string;
	summary: string;
	tags: string[];
	/** Static author-assigned priority in [0,1]. Never decays. */
	importance: number;
	/** Decay-modulated effective priority in [0,1]. Starts equal to importance. */
	strength: number;
	/** Number of times this atom (or any of its descendants) has been recalled. */
	access_count: number;
	/** 1 for newly created atoms, +1 on each update. */
	version: number;
	/** 1 = current version, 0 = superseded by a newer atom in the chain. */
	is_latest: 1 | 0;
	/** id of the atom this one supersedes (null for the first version). */
	parent_id: string | null;
	/** ms epoch at which this atom was superseded (null while still latest). */
	superseded_at: number | null;
	/** 0 = active, 1 = archived (soft-deleted). "rule" atoms are never archived. */
	archived: 0 | 1;
	/** ms epoch at which this version was created. */
	created_at: number;
	/** ms epoch of the last write to this atom (content, tags, etc.). */
	updated_at: number;
	/** ms epoch of the last successful recall (null if never recalled). */
	last_access: number | null;
	/** sha256(normalized content).slice(0, 16) — used to detect near-duplicates. */
	content_fingerprint: string;
	/** Optional provenance: id of the session that produced this atom. */
	source_session: string | null;
}

// ---------------------------------------------------------------------------
// Recall result
// ---------------------------------------------------------------------------

/** Hydrated atom + similarity metadata from vector search. */
export interface RecallResult {
	atom: MemoryAtom;
	/** Raw L2 distance returned by sqlite-vec. Smaller = closer. */
	distance: number;
	/** Cosine similarity in [0,1], derived as 1 - distance²/2 (for L2-normalized vectors). */
	cosine: number;
	/**
	 * Weighted ranking score used to order hits within each atom type during
	 * search. Formula:
	 *   score = cosine × (1 + 0.3 × strength + 0.2 × importance)
	 *         + 0.10 × tagOverlap
	 *         + 0.05 × freshness
	 *
	 * The first term is the multiplicative anchor (back-compat from the
	 * dense-only era): a cosine of 0 forces that term to 0, regardless of
	 * strength/importance. The strength/importance term adds a continuous
	 * boost capped at +0.5 (when both are 1.0), so an unrelated atom can
	 * never be boosted above a relevant one.
	 *
	 * The two additive terms (`tagOverlap` and `freshness`) are debug
	 * surfaces — they tune ranking for keyword-rescue and recency
	 * respectively, but are NOT used to override the multiplicative anchor
	 * (cosine=0 still produces score=0 since the additive terms alone cap
	 * at +0.15).
	 *
	 * `score` is exposed only in the search response (UI / debug surfaces).
	 * The format layer (`formatMemoryContext`) re-sorts hits by `distance` ASC
	 * before injecting them into the LLM prompt, so the LLM never sees
	 * `score` — it sees cosine-ordered blocks and uses `id` to call `memory_get`
	 * for full content.
	 */
	score: number;
	/**
	 * Tag overlap contribution: fraction of query segment tokens (after
	 * tag-alias folding via `computeTagOverlap`) that match an atom's tag
	 * set, in [0, 1]. Debug surface for the `0.10 × tagOverlap` additive
	 * term in the score formula. Computed per-segment so heterogeneous
	 * queries (`mgm工时计算` → ["mgm", "工时计算"]) get accurate per-tag
	 * matching against the original segment, not the joined query string.
	 */
	tagOverlap?: number;
	/**
	 * Freshness decay in [0, 1]: `exp(-daysSinceUpdate / 30)`. Debug surface
	 * for the `0.05 × freshness` additive term in the score formula. A
	 * freshly-updated atom scores 1.0; an atom updated ~30 days ago scores
	 * ≈0.37; a year-old atom scores ≈5.2e-6 (negligible).
	 */
	freshness?: number;
}

// ---------------------------------------------------------------------------
// Extraction pipeline types
// ---------------------------------------------------------------------------

/** Single item emitted by the LLM extraction pass. */
export interface ExtractionItem {
	type: MemoryAtomType;
	title: string;
	content: string;
	summary: string;
	tags: string[];
	importance: number;
}

/** Raw LLM output. Wraps a list of items; no action/id/changes fields. */
export interface ExtractionResult {
	items: ExtractionItem[];
}

/** Full extraction plan with computed supersede/skip/create decisions. */
export interface ExtractionPlan {
	items: Array<{
		item: ExtractionItem;
		status: "skip" | "supersede" | "create";
		/** Set when status is "skip" or "supersede": the existing atom id matched. */
		matchedAtomId?: string;
		/** Set when status is "supersede": cosine similarity to the matched atom. */
		similarity?: number;
		/** Computed fingerprint of the item's normalized content. */
		fingerprint?: string;
	}>;
	modelUsed: string;
	generatedAt: number;
}

// ---------------------------------------------------------------------------
// Storage row shape
// ---------------------------------------------------------------------------

/**
 * Row shape as returned by better-sqlite3 / sqlite-vec. Tags are stored as a
 * JSON-encoded string in a single TEXT column; all numeric flags are integers
 * (0|1), not booleans, to match what the driver hands back.
 */
export interface MemoryAtomRow {
	id: string;
	type: MemoryAtomType;
	title: string;
	summary: string;
	content: string;
	tags: string;
	importance: number;
	strength: number;
	access_count: number;
	version: number;
	is_latest: number;
	parent_id: string | null;
	superseded_at: number | null;
	archived: number;
	created_at: number;
	updated_at: number;
	last_access: number | null;
	content_fingerprint: string;
	source_session: string | null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Hydrate a database row into a domain atom. Parses the JSON-encoded `tags`
 * string back into an array. Defensive against null/empty/invalid input:
 * anything that does not parse cleanly yields an empty array rather than
 * throwing — callers should treat that as "no tags" rather than as an error.
 */
export function rowToAtom(row: MemoryAtomRow): MemoryAtom {
	let tags: string[] = [];
	if (row.tags !== null && row.tags !== undefined && row.tags !== "") {
		try {
			const parsed = JSON.parse(row.tags);
			if (Array.isArray(parsed)) {
				tags = parsed.filter((t): t is string => typeof t === "string");
			}
		} catch {
			// Invalid JSON in storage: fall through to empty array. The caller
			// can detect this by comparing content_fingerprint against a fresh
			// fingerprint if they need stricter behaviour.
			tags = [];
		}
	}

	return {
		id: row.id,
		type: row.type,
		title: row.title,
		content: row.content,
		summary: row.summary,
		tags,
		importance: row.importance,
		strength: row.strength,
		access_count: row.access_count,
		version: row.version,
		is_latest: row.is_latest === 1 ? 1 : 0,
		parent_id: row.parent_id,
		superseded_at: row.superseded_at,
		archived: row.archived === 1 ? 1 : 0,
		created_at: row.created_at,
		updated_at: row.updated_at,
		last_access: row.last_access,
		content_fingerprint: row.content_fingerprint,
		source_session: row.source_session,
	};
}

/**
 * Serialize a domain atom into the database row shape. JSON-encodes `tags`
 * into the single TEXT column. Preserves the 0|1 integer semantics on
 * is_latest and archived so the row round-trips exactly through sqlite.
 */
export function atomToRow(atom: MemoryAtom): MemoryAtomRow {
	return {
		id: atom.id,
		type: atom.type,
		title: atom.title,
		summary: atom.summary,
		content: atom.content,
		tags: JSON.stringify(atom.tags),
		importance: atom.importance,
		strength: atom.strength,
		access_count: atom.access_count,
		version: atom.version,
		is_latest: atom.is_latest,
		parent_id: atom.parent_id,
		superseded_at: atom.superseded_at,
		archived: atom.archived,
		created_at: atom.created_at,
		updated_at: atom.updated_at,
		last_access: atom.last_access,
		content_fingerprint: atom.content_fingerprint,
		source_session: atom.source_session,
	};
}
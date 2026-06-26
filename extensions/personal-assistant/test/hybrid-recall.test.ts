// Hybrid recall — combines the pure `rrfFuse` helper with end-to-end tests
// for `recallAtoms` exercising dense + BM25 channels through a real
// in-memory SQLite + FTS5 mirror.
//
// Two layers of tests:
//   (1) `rrfFuse` — pure function correctness (already covered by task 3.1).
//   (2) `recallAtoms` end-to-end scenarios — verify the search layer runs
//       dense KNN + BM25 in parallel per type, fuses via RRF, populates
//       `rrfScore` on results, and degrades gracefully when one channel
//       is empty.
//
// Contract (from design.md Decisions 2, 4, 5):
//   - Per-type fan-out: 3 types (rule / fact / process), each independently
//     runs `vectorSearch` + `bm25Search` in parallel.
//   - RRF fusion: each channel contributes `1/(rrfK + rank + 1)` per atom;
//     same atom in both channels sums.
//   - `rrfScore` is populated on every recalled `RecallResult`.
//   - Threshold filter applies to fused RRF score (not cosine).
//   - Per-type cap of 3 preserved; round-robin interleave unchanged.
//   - embedText null → dense channel collapses to [], BM25 still works.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { embedText } from "../embed.ts";
import { recallAtoms, rrfFuse } from "../search.ts";
import { MemoryIndex } from "../storage.ts";
import type { MemoryAtom } from "../types.ts";

// ---------------------------------------------------------------------------
// Test scaffolding (mirrors search.test.ts so controlled vectors + charBag
// mock work the same way)
// ---------------------------------------------------------------------------

const DIM = 1024;

/**
 * Char-bag embedding — position-independent character histogram, L2-normalised.
 * Mirrors the real bge-m3 (L2-normalised) embedding's behaviour for cosine
 * ordering purposes. Texts sharing characters (regardless of position) score
 * high cosine; texts with disjoint character sets score near zero.
 */
const charBag = (text: string): number[] => {
	const arr = new Array(DIM).fill(0);
	for (let i = 0; i < text.length; i++) {
		arr[text.charCodeAt(i) % DIM] += 1;
	}
	const norm = Math.sqrt(arr.reduce((s, v) => s + v * v, 0));
	if (norm > 0) for (let i = 0; i < arr.length; i++) arr[i] /= norm;
	return arr;
};

/**
 * Build an L2-normalised 1024-dim vector whose cosine with the unit reference
 * vector `V_UNIT = [1, 0, 0, ...]` is exactly `dominant`.
 */
const makeVec = (dominant: number): number[] => {
	const arr = new Array(DIM).fill(0);
	arr[0] = dominant;
	arr[1] = Math.sqrt(Math.max(0, 1 - dominant * dominant));
	return arr;
};

const V_UNIT = makeVec(1.0);
const V_COS_07 = makeVec(0.7);
const V_COS_05 = makeVec(0.5);
const V_COS_04 = makeVec(0.4);
const V_COS_0 = makeVec(0.0);

const VECS_BY_CODE: Record<string, number[]> = {
	"1": V_UNIT,
	"0.7": V_COS_07,
	"0.5": V_COS_05,
	"0.4": V_COS_04,
	"0": V_COS_0,
};

const QRY = "__QUERY__";
const COS_RE = /__COS:([0-9.]+)/;

vi.mock("../embed.ts", async () => {
	const actual = await vi.importActual<typeof import("../embed.ts")>("../embed.ts");
	return {
		...actual,
		embedText: vi.fn(async (text: string) => {
			const arr = new Array(DIM).fill(0);
			for (let i = 0; i < text.length; i++) {
				arr[text.charCodeAt(i) % DIM] += 1;
			}
			const norm = Math.sqrt(arr.reduce((s, v) => s + v * v, 0));
			if (norm > 0) for (let i = 0; i < arr.length; i++) arr[i] /= norm;
			return arr;
		}),
	};
});

const installControlledMock = (): void => {
	vi.mocked(embedText).mockImplementation(async (text: string) => {
		if (text === QRY) return V_UNIT;
		const m = text.match(COS_RE);
		if (m) {
			const v = VECS_BY_CODE[m[1]];
			if (v) return v;
		}
		return charBag(text);
	});
};

const installCharBagMock = (): void => {
	vi.mocked(embedText).mockImplementation(async (text: string) => charBag(text));
};

const sampleAtom = (overrides: Partial<MemoryAtom> = {}): MemoryAtom => ({
	id: crypto.randomUUID(),
	type: "rule",
	title: "Sample",
	content: "Sample content for testing",
	summary: "Sample summary",
	tags: ["test"],
	importance: 0.5,
	strength: 0.5,
	access_count: 0,
	version: 1,
	is_latest: 1,
	parent_id: null,
	superseded_at: null,
	archived: 0,
	created_at: Date.now(),
	updated_at: Date.now(),
	last_access: null,
	content_fingerprint: `fp-${Math.random().toString(36).slice(2, 18)}`,
	source_session: null,
	...overrides,
});

const insertAtom = async (atom: MemoryAtom, index: MemoryIndex): Promise<void> => {
	const text = `${atom.title}\n\n${atom.summary}\n\n${atom.content}\n\n${atom.tags.join(" ")}`;
	const emb = await embedText(text);
	if (!emb) throw new Error("mocked embedText returned null in test setup");
	await index.insertAtom(atom, emb);
};

/**
 * Fixture helper for the additive-score formula tests (tagOverlap +
 * freshness). Sets `updated_at` to 1 year ago by default so the freshness
 * contribution to `score` is essentially 0 (`exp(-365/30) ≈ 5.2e-6`) and
 * the new tests can isolate the `tagOverlap` boost without freshness
 * masking the difference. The 1-year-ago default also keeps the existing
 * score-formula assertions (e.g. `toBeCloseTo(1.5, 5)`) valid without
 * needing to recalculate the +0.05 freshness term.
 */
const makeAtom = (overrides: Partial<MemoryAtom> = {}): MemoryAtom =>
	sampleAtom({
		updated_at: Date.now() - 365 * 24 * 60 * 60 * 1000,
		...overrides,
	});

describe("rrfFuse", () => {
	it("rrfFuse sums contributions from both channels", () => {
		// denseRanks = [a(0), b(1)]  →  a gets 1/(60+0+1)=1/61,  b gets 1/(60+1+1)=1/62
		// bm25Ranks  = [b(0), c(1)]  →  b gets 1/(60+0+1)=1/61,  c gets 1/(60+1+1)=1/62
		// final: a = 1/61,  b = 1/62 + 1/61,  c = 1/62
		const result = rrfFuse(
			[{ id: "a" }, { id: "b" }],
			[{ id: "b" }, { id: "c" }],
			60,
		);
		const byId = new Map(result.map((r) => [r.id, r.rrfScore]));
		expect(byId.get("a")).toBeCloseTo(1 / 61, 9);
		// b appears at dense rank=1 and bm25 rank=0 → 1/62 + 1/61
		expect(byId.get("b")).toBeCloseTo(1 / 62 + 1 / 61, 9);
		expect(byId.get("c")).toBeCloseTo(1 / 62, 9);
		// Sort must be non-increasing.
		expect(result[0].id).toBe("b");
		for (let i = 1; i < result.length; i++) {
			expect(result[i - 1].rrfScore).toBeGreaterThanOrEqual(result[i].rrfScore);
		}
	});

	it("rrfFuse with no overlap", () => {
		// Disjoint id sets → each id gets exactly one contribution.
		// denseRanks = [x(0), y(1)]  →  x=1/61,  y=1/62
		// bm25Ranks  = [p(0), q(1)]  →  p=1/61,  q=1/62
		const result = rrfFuse(
			[{ id: "x" }, { id: "y" }],
			[{ id: "p" }, { id: "q" }],
			60,
		);
		expect(result).toHaveLength(4);
		const byId = new Map(result.map((r) => [r.id, r.rrfScore]));
		expect(byId.get("x")).toBeCloseTo(1 / 61, 9);
		expect(byId.get("y")).toBeCloseTo(1 / 62, 9);
		expect(byId.get("p")).toBeCloseTo(1 / 61, 9);
		expect(byId.get("q")).toBeCloseTo(1 / 62, 9);
		// x and p are tied at 1/61; y and q are tied at 1/62.
		// Sort must be non-increasing.
		for (let i = 1; i < result.length; i++) {
			expect(result[i - 1].rrfScore).toBeGreaterThanOrEqual(result[i].rrfScore);
		}
	});

	it("rrfFuse with full overlap", () => {
		// Same 2 ids in both channels at the same ranks → each id gets
		// BOTH contributions summed (i.e. its rrfScore is exactly 2x what
		// it would be from a single channel).
		// denseRanks = [a(0), b(1)]  →  a=1/61,  b=1/62
		// bm25Ranks  = [a(0), b(1)]  →  a=1/61,  b=1/62
		// final: a = 1/61 + 1/61,  b = 1/62 + 1/62
		const result = rrfFuse(
			[{ id: "a" }, { id: "b" }],
			[{ id: "a" }, { id: "b" }],
			60,
		);
		expect(result).toHaveLength(2);
		const byId = new Map(result.map((r) => [r.id, r.rrfScore]));
		// a is at rank=0 in both channels → 1/61 + 1/61
		expect(byId.get("a")).toBeCloseTo(1 / 61 + 1 / 61, 9);
		// b is at rank=1 in both channels → 1/62 + 1/62
		expect(byId.get("b")).toBeCloseTo(1 / 62 + 1 / 62, 9);
		// a must outrank b.
		expect(result[0].id).toBe("a");
	});

	it("rrfFuse ranks by fused score descending", () => {
		// Mix overlap patterns to produce a known ordering.
		// denseRanks = [a(0), b(1), c(2)]  →  a=1/61,  b=1/62,  c=1/63
		// bm25Ranks  = [a(0), d(1), e(2)]  →  a=1/61,  d=1/62,  e=1/63
		// fused: a = 1/61 + 1/61 ≈ 0.0328  (double-channel, rank 0)
		//        b = 1/62                ≈ 0.0161  (dense only)
		//        c = 1/63                ≈ 0.0159  (dense only)
		//        d = 1/62                ≈ 0.0161  (bm25 only)
		//        e = 1/63                ≈ 0.0159  (bm25 only)
		// So `a` sorts first (double-channel), then b/d tied at 1/62, then
		// c/e tied at 1/63.
		const result = rrfFuse(
			[{ id: "a" }, { id: "b" }, { id: "c" }],
			[{ id: "a" }, { id: "d" }, { id: "e" }],
			60,
		);
		expect(result).toHaveLength(5);
		// a must be first (only id with both-channel contribution at rank=0).
		expect(result[0].id).toBe("a");
		expect(result[0].rrfScore).toBeCloseTo(1 / 61 + 1 / 61, 9);
		// Sort is non-increasing across the whole list.
		for (let i = 1; i < result.length; i++) {
			expect(result[i - 1].rrfScore).toBeGreaterThanOrEqual(result[i].rrfScore);
		}
		// Verify each id's exact fused score.
		const byId = new Map(result.map((r) => [r.id, r.rrfScore]));
		expect(byId.get("b")).toBeCloseTo(1 / 62, 9);
		expect(byId.get("c")).toBeCloseTo(1 / 63, 9);
		expect(byId.get("d")).toBeCloseTo(1 / 62, 9);
		expect(byId.get("e")).toBeCloseTo(1 / 63, 9);
	});

	it("rrfFuse k=0 collapses to rank-weighted sum", () => {
		// k=0 → contribution is 1/(0 + rank + 1) = 1/(rank+1) — harmonic.
		// denseRanks = [A(0), B(1), C(2)]  →  A=1/1,  B=1/2,  C=1/3
		// bm25Ranks  = [C(0), D(1)]        →  C=1/1,  D=1/2
		// fused: A = 1/1 = 1.0
		//        B = 1/2 = 0.5
		//        C = 1/3 + 1/1 = 4/3 ≈ 1.333
		//        D = 1/2 = 0.5
		const result = rrfFuse(
			[{ id: "A" }, { id: "B" }, { id: "C" }],
			[{ id: "C" }, { id: "D" }],
			0,
		);
		const byId = new Map(result.map((r) => [r.id, r.rrfScore]));
		// A: dense rank=0 only → 1/1
		expect(byId.get("A")).toBeCloseTo(1, 9);
		// B: dense rank=1 only → 1/2
		expect(byId.get("B")).toBeCloseTo(0.5, 9);
		// C: dense rank=2 + bm25 rank=0 → 1/3 + 1/1
		expect(byId.get("C")).toBeCloseTo(1 / 3 + 1, 9);
		// D: bm25 rank=1 only → 1/2
		expect(byId.get("D")).toBeCloseTo(0.5, 9);
		// Sort: C (1.333) > A (1.0) > B = D (0.5).
		expect(result[0].id).toBe("C");
		expect(result[1].id).toBe("A");
		for (let i = 1; i < result.length; i++) {
			expect(result[i - 1].rrfScore).toBeGreaterThanOrEqual(result[i].rrfScore);
		}
	});

	it("rrfFuse handles empty channels", () => {
		// Both empty → returns [].
		const emptyBoth = rrfFuse([], [], 60);
		expect(emptyBoth).toEqual([]);

		// Dense empty, bm25 populated → each bm25 id gets one contribution.
		const denseEmpty = rrfFuse(
			[],
			[{ id: "p" }, { id: "q" }, { id: "r" }],
			60,
		);
		expect(denseEmpty).toHaveLength(3);
		const deById = new Map(denseEmpty.map((r) => [r.id, r.rrfScore]));
		expect(deById.get("p")).toBeCloseTo(1 / 61, 9);
		expect(deById.get("q")).toBeCloseTo(1 / 62, 9);
		expect(deById.get("r")).toBeCloseTo(1 / 63, 9);

		// Bm25 empty, dense populated → each dense id gets one contribution.
		const bm25Empty = rrfFuse(
			[{ id: "x" }, { id: "y" }, { id: "z" }],
			[],
			60,
		);
		expect(bm25Empty).toHaveLength(3);
		const beById = new Map(bm25Empty.map((r) => [r.id, r.rrfScore]));
		expect(beById.get("x")).toBeCloseTo(1 / 61, 9);
		expect(beById.get("y")).toBeCloseTo(1 / 62, 9);
		expect(beById.get("z")).toBeCloseTo(1 / 63, 9);
	});
});

// ---------------------------------------------------------------------------
// recallAtoms — end-to-end hybrid scenarios
//
// These tests run against a real in-memory SQLite + FTS5 mirror so we exercise
// the full `vectorSearch + bm25Search + rrfFuse + threshold` pipeline. The
// controlled-mock embedder (recognising `QRY` + `__COS:` sentinels) lets us
// fix dense cosine exactly while leaving BM25 to do its real FTS5 ranking on
// the literal atom text.
// ---------------------------------------------------------------------------

describe("recallAtoms hybrid recall", () => {
	let index: MemoryIndex;

	beforeEach(async () => {
		index = new MemoryIndex(":memory:");
		await index.init();
		vi.mocked(embedText).mockReset();
		installCharBagMock();
	});

	afterEach(() => {
		index.close();
	});

	// (a) Three atoms, all three recall channels represented.
	//
	//   - Atom A: dense hits (cosine=1) + BM25 hits (token match)
	//     → double-channel, ranked highest
	//   - Atom B: dense hits (cosine=0.7) + BM25 zero hits (no token match)
	//     → dense-only, ranked above C
	//   - Atom C: dense misses (cosine=0, below floor) + BM25 hits
	//     → BM25-only, ranked lowest of the three but still passes threshold
	//
	// We mock `vectorSearch` per type so the dense channel ranking is fully
	// deterministic. The query uses charBag (no controlled-mock) so that
	// BM25 can match by real token overlap.
	it("recallAtoms fuses dense + BM25 via RRF and populates rrfScore", async () => {
		installCharBagMock();
		// Atom A: dense cosine=1.0 (top of dense) + BM25 token match.
		//   Content shares "alpha bravo" tokens with the query.
		const a = sampleAtom({
			type: "rule",
			content: "alpha bravo shared token content unique A marker",
		});
		// Atom B: dense cosine=0.7 (second in dense) + BM25 zero hits.
		//   Content uses different tokens from the query.
		const b = sampleAtom({
			type: "fact",
			content: "completely unrelated vocabulary distinctly B marker",
		});
		// Atom C: dense cosine=0.0 (below 0.65 floor → dense filtered)
		//   + BM25 hits (shares "alpha bravo" tokens with the query).
		//   Use distinct characters to force a low charBag cosine.
		const c = sampleAtom({
			type: "process",
			content: "alpha bravo shared token content unique C marker zzzz",
		});
		await insertAtom(a, index);
		await insertAtom(b, index);
		await insertAtom(c, index);

		// Mock vectorSearch so the dense channel is deterministic and the
		// floor (0.65) is meaningfully exercised. Real charBag cosines
		// against three arbitrarily-worded atoms are not predictable; we
		// exercise the FUSION + FLOOR + THRESHOLD logic by injecting
		// specific distances.
		const realVS = index.vectorSearch.bind(index);
		index.vectorSearch = ((embedding: number[], k: number, filter?: { type?: "rule" | "fact" | "process" }) => {
			if (filter?.type === "rule") {
				// a: cosine 1.0 → distance 0; above floor
				return [{ id: a.id, distance: 0 }];
			}
			if (filter?.type === "fact") {
				// b: cosine 0.7 → distance sqrt(0.6); above floor
				return [{ id: b.id, distance: Math.sqrt(0.6) }];
			}
			if (filter?.type === "process") {
				// c: cosine 0.0 → distance sqrt(2); BELOW 0.65 floor (cosine 0)
				return [{ id: c.id, distance: Math.sqrt(2) }];
			}
			return realVS(embedding, k, filter);
		}) as typeof index.vectorSearch;

		const results = await recallAtoms(index, "alpha bravo shared", {
			// Bypass the strict 1/rrfK gate so single-channel rank=1 hits
			// (dense-only B, BM25-only C, both 0.0164) surface alongside
			// double-channel A. This test isolates the fusion / rrfScore
			// population logic from the recall gate.
			recallThreshold: 0,
		});
		// All three should surface.
		const ids = new Set(results.map((r) => r.atom.id));
		expect(ids.has(a.id)).toBe(true);
		expect(ids.has(b.id)).toBe(true);
		expect(ids.has(c.id)).toBe(true);
		// Every result carries a finite, non-zero rrfScore (proves the field
		// is populated by the new pipeline, not just undefined).
		for (const r of results) {
			expect(typeof r.rrfScore).toBe("number");
			expect(Number.isFinite(r.rrfScore)).toBe(true);
			expect(r.rrfScore).toBeGreaterThan(0);
		}
		// Double-channel atom A's rrfScore must exceed B's.
		const scoreA = results.find((r) => r.atom.id === a.id)?.rrfScore ?? 0;
		const scoreB = results.find((r) => r.atom.id === b.id)?.rrfScore ?? 0;
		expect(scoreA).toBeGreaterThan(scoreB);
	});

	// (b) BM25-only atom (dense cosine below the 0.65 floor, so dense does
	// NOT contribute) is still recalled via the BM25 channel. The strict
	// default 1/rrfK gate would filter this single-channel rank=1 hit
	// (rrfScore 0.0164 < 0.0167), so this test opts into "single-channel
	// graceful degradation" mode via `recallThreshold: 0` — which is the
	// escape hatch for users who want BM25-only / dense-only rescue
	// behaviour (test / dev mode, see scenarios.md "BM25 单路命中" note).
	it("BM25-only hit recalled even when dense cosine below floor", async () => {
		installControlledMock();
		// Dense cosine=0.4 → below the 0.65 cosine floor; dense channel drops
		// this atom. BM25 query "amplicon data backflow" matches the atom's
		// content tokens "amplicon", "data", "backflow" exactly.
		const a = sampleAtom({
			type: "rule",
			content: "__COS:0.4 amplicon data backflow marker unique phrase",
		});
		await insertAtom(a, index);

		const results = await recallAtoms(index, "amplicon data backflow", {
			recallThreshold: 0,
		});
		expect(results.find((r) => r.atom.id === a.id)).toBeDefined();
		// The recalled atom carries a non-zero rrfScore from BM25 alone.
		const hit = results.find((r) => r.atom.id === a.id);
		expect(hit?.rrfScore).toBeGreaterThan(0);
		// dense distance was filtered, so cosine/score collapse to 0
		// (back-compat: score field still computed but anchored to 0 cosine).
		expect(hit?.cosine).toBe(0);
	});

	// (c) Dense-only atom (BM25 has zero hits) is still recalled via the
	// dense channel. Same strict-gate bypass as (b) — the test name
	// documents the "BM25 zero hits → dense-only rescue" contract; the
	// implementation opts in via `recallThreshold: 0` to exercise that path
	// without conflicting with the design's default strict gate.
	it("dense-only hit recalled even when BM25 zero hits", async () => {
		installControlledMock();
		// Content uses tokens ("zulu", "yankee", "xray") that do NOT appear
		// in the query, so BM25 returns 0. Dense cosine=1 → dense hits.
		const a = sampleAtom({
			type: "rule",
			content: "__COS:1 zulu yankee xray abc def unique phrase",
		});
		await insertAtom(a, index);

		const results = await recallAtoms(index, QRY, { recallThreshold: 0 });
		expect(results.find((r) => r.atom.id === a.id)).toBeDefined();
		const hit = results.find((r) => r.atom.id === a.id);
		expect(hit?.rrfScore).toBeGreaterThan(0);
		// Dense-only: cosine computed from distance, score follows formula.
		expect(hit?.cosine).toBeCloseTo(1.0, 5);
	});

	// (d) Double-channel hit outranks single-channel hits in the per-type
	// ranking (RRF gives the same id contributions from both channels).
	//
	// We mock `bm25Search` to control the BM25 channel ranks deterministically
	// because FTS5's internal ranking is non-deterministic for ties, and the
	// principle we want to test is the RRF math itself, not FTS5 internals.
	// The query uses the QRY sentinel so embedText returns V_UNIT, giving
	// dbl cosine=1.0 with the query (guaranteed dense rank 0).
	//
	// Under the strict 1/60 default gate, `bm25Only` (single-channel BM25
	// rank=1, rrfScore 1/62 ≈ 0.0161) gets filtered. We opt into
	// `recallThreshold: 0` to surface all three and verify the rank order
	// (dbl > bm25Only) directly. The dbl assertion (2/61) is the design-
	// critical path: this is what survives the default strict gate.
	it("double-channel hit ranks above single-channel hits", async () => {
		installControlledMock();
		const dbl = sampleAtom({
			type: "rule",
			content: "__COS:1 shared token content unique DB marker",
		});
		const denseOnly = sampleAtom({
			type: "rule",
			content: "__COS:0.7 zulu yankee xray abc def unique DO marker",
		});
		const bm25Only = sampleAtom({
			type: "rule",
			content: "__COS:0.4 shared token content unique BO marker",
		});
		await insertAtom(dbl, index);
		await insertAtom(denseOnly, index);
		await insertAtom(bm25Only, index);

		// Mock bm25Search for the rule type: dbl takes rank 0 (double-channel),
		// bm25Only takes rank 1 (BM25-only). denseOnly has zero BM25 hits.
		const realBm25 = index.bm25Search.bind(index);
		index.bm25Search = ((q: string, k: number, filter?: { type?: "rule" | "fact" | "process" }) => {
			if (filter?.type === "rule") {
				return [
					{ id: dbl.id, bm25: -10 },
					{ id: bm25Only.id, bm25: -5 },
				];
			}
			return realBm25(q, k, filter);
		}) as typeof index.bm25Search;

		const results = await recallAtoms(index, QRY, { recallThreshold: 0 });
		// Double-channel atom must be present and first.
		const dblHit = results.find((r) => r.atom.id === dbl.id);
		expect(dblHit).toBeDefined();
		expect(results[0]?.atom.id).toBe(dbl.id);
		expect(dblHit?.rrfScore).toBeCloseTo(2 / 61, 4);
		// BM25-only (rank=1) is the only other rule atom to pass threshold;
		// its rrfScore must be strictly less than dbl's.
		const bm25Hit = results.find((r) => r.atom.id === bm25Only.id);
		if (bm25Hit) {
			expect(bm25Hit.rrfScore ?? 0).toBeLessThan(dblHit?.rrfScore ?? 0);
		}
	});

	// (e) embedText returning null → dense channel collapses to [], but
	// BM25 still surfaces relevant atoms. This is the "ollama down" fallback.
	// Under the strict 1/60 default gate, the BM25-only single-channel hit
	// (rrfScore 0.0164 < 0.0167) gets filtered. `recallThreshold: 0` is the
	// user opt-in to surface BM25-only rescue in this degraded mode.
	it("recallAtoms degrades gracefully when embedText returns null", async () => {
		// Atom uses shared tokens so BM25 will find it. The charBag embedding
		// is irrelevant because embedText will return null on recall.
		const a = sampleAtom({
			type: "rule",
			content: "amplicon data backflow keyword phrase marker unique",
		});
		await insertAtom(a, index);

		// Force embedText to return null on the recall call. The insertAtom
		// call above already succeeded with a real embedding.
		vi.mocked(embedText).mockResolvedValueOnce(null);

		const results = await recallAtoms(index, "amplicon data backflow", {
			recallThreshold: 0,
		});
		// BM25 still surfaces the atom despite dense collapse.
		expect(results.find((r) => r.atom.id === a.id)).toBeDefined();
		// rrfScore comes from BM25 only — still non-zero.
		const hit = results.find((r) => r.atom.id === a.id);
		expect(hit?.rrfScore).toBeGreaterThan(0);
	});

	// (f) Empty index → both channels return [] → result is [].
	it("recallAtoms returns [] when both channels empty", async () => {
		const results = await recallAtoms(index, "anything at all");
		expect(results).toEqual([]);
	});

	// (g) Round-robin interleave after per-type RRF fusion preserves type
	// diversity. With 5 rule + 5 fact and a query matching all of them,
	// the final 9-result list must contain both rule and fact atoms (the
	// per-type cap of 3 each gives round-robin slots for both types).
	it("per-type round-robin after RRF fusion preserves type diversity", async () => {
		// 5 rule + 5 fact, all matching the query on both channels.
		for (let i = 0; i < 5; i++) {
			await insertAtom(
				sampleAtom({
					type: "rule",
					content: `rule${i} common keyword alpha content shared`,
				}),
				index,
			);
			await insertAtom(
				sampleAtom({
					type: "fact",
					content: `fact${i} common keyword alpha content shared`,
				}),
				index,
			);
		}

		const results = await recallAtoms(index, "common keyword alpha content shared");
		// Both types must appear in the final interleaved list.
		const types = new Set(results.map((r) => r.atom.type));
		expect(types.has("rule")).toBe(true);
		expect(types.has("fact")).toBe(true);
		// Per-type cap = 3 → 3 rule + 3 fact = 6 (no process atoms inserted).
		expect(results.length).toBe(6);
	});

	// (h) Per-type cap of 3 holds even when fused list has more candidates.
	it("per-type cap of 3 holds after RRF fusion", async () => {
		// 5 rule atoms all matching → fused list has 5 entries → top-3 only.
		for (let i = 0; i < 5; i++) {
			await insertAtom(
				sampleAtom({
					type: "rule",
					content: `rule ${i} common keyword alpha shared content`,
				}),
				index,
			);
		}
		const results = await recallAtoms(index, "common keyword alpha shared content");
		expect(results.length).toBe(3);
		expect(results.every((r) => r.atom.type === "rule")).toBe(true);
	});

	// (i) FTS5 special-character query does not crash — `escapeFtsQuery` in
	// storage.ts handles stripping `"()* : [ ]` to space.
	it("FTS5 special-character query is handled (no SQL parse error)", async () => {
		const a = sampleAtom({
			type: "rule",
			content: "normal content shared keyword alpha marker",
		});
		await insertAtom(a, index);
		// Query with FTS5-reserved chars. Storage's escapeFtsQuery strips them.
		const results = await recallAtoms(index, `"alpha"*foo[bar]:baz`);
		// No throw. Result may be empty (escaped query becomes "alpha foo bar baz")
		// which matches the atom — so we expect a non-throw with at least the
		// matching atom present.
		expect(results).toBeDefined();
		expect(Array.isArray(results)).toBe(true);
	});

	// (j) `recallThreshold` default = 1/(rrfK+1) lets single-channel rank=0
	// BM25-only hits through (= threshold, `>=` passes). Rank≥1 single-
	// channel contributions are filtered. Strict mode (`recallThreshold:
	// 1/rrfK`) additionally filters rank=0 single-channel — that is the
	// opt-in "宁可漏召不可误召" path. The dense cosine floor (0.65) handles
	// dense-noise separately and is NOT what this gate tests.
	it("recallThreshold default lets single-channel rank=0 through; strict mode filters it", async () => {
		installControlledMock();
		// Single-channel BM25-only hit. The controlled V_COS_04 embedding
		// shares no index-0/1 mass with the charBag of "amplicon data
		// backflow" (different character codes mod 1024), so cosine ≈ 0 and
		// the dense channel drops the atom at the 0.65 floor. BM25 finds the
		// atom via token overlap on "amplicon" / "data" / "backflow".
		const a = sampleAtom({
			type: "rule",
			content: "__COS:0.4 amplicon data backflow marker unique phrase",
		});
		await insertAtom(a, index);

		// DEFAULT gate (1/(rrfK+1) ≈ 0.01639) lets the rank-0 BM25-only
		// contribution through (rrfScore = 1/(60+0+1) = 1/61 ≈ 0.01639,
		// equals threshold and `>=` passes). This is the industry-standard
		// RRF rank-only stance and the MGM-style keyword rescue contract.
		const resultsDefault = await recallAtoms(index, "amplicon data backflow");
		const hitDefault = resultsDefault.find((r) => r.atom.id === a.id);
		expect(hitDefault).toBeDefined();
		expect(hitDefault?.rrfScore).toBeCloseTo(1 / 61, 4);

		// STRICT mode (1/rrfK ≈ 0.01667) filters the same rank-0 single-
		// channel contribution (1/61 < 1/60). This is the opt-in strict
		// stance — users with weakened embeddings or who want maximum
		// precision over recall can dial this in via config.
		const resultsStrict = await recallAtoms(index, "amplicon data backflow", {
			recallThreshold: 1 / 60,
			threshold: 0, // bypass dense floor to isolate the gate
		});
		expect(resultsStrict.find((r) => r.atom.id === a.id)).toBeUndefined();

		// `recallThreshold: 0` disables the gate entirely — same atom
		// surfaces regardless. This is the test/dev escape hatch.
		const resultsBypass = await recallAtoms(index, "amplicon data backflow", {
			recallThreshold: 0,
		});
		expect(resultsBypass.find((r) => r.atom.id === a.id)).toBeDefined();
	});

	// (k) Long mixed-query (file path + CJK description) does NOT split into
// many segments. The user's full prompt — e.g. a delivery-check message
// quoting a long file path plus a Chinese description — typically
// produces 15-30 segments after `splitQuery`. OR-merging that many
// dilutes specificity (recall probability 1-(1-p)ᴺ). `recallAtoms`
// caps the segment split at 3; anything longer is treated as a single
// segment. Combined with `escapeFtsQuery` stripping `-` / `.` (FTS5
// query-parser trap: `IDENT-IDENT` → "no such column: IDENT"), a long
// query reaches the BM25 channel with project ID + file path tokens
// individually searchable, AND the dense channel with the full string
// embedded for semantic matching.
it("long mixed query does NOT split into segments; BM25 strips - and . cleanly", async () => {
	const a = sampleAtom({
		type: "fact",
		title: "X101SC26052587 delivery note",
		content: "Sample X101SC26052587-Z01-J002 from rnaVirus pipeline run.",
	});
	await insertAtom(a, index);

	const LONG_Q =
		"/TJPROJ8/GB_MICRO/PJ_GB/meta/5006/X101SC260410257-Z01-F001.metagenomics.20260617/data_release/result-X101SC260410257-Z01-F001 这个是个DNA病毒基因组的实际结果. 下面3,4,5部分的结果介绍(PDF)写的非常糟糕. 这里你可以先把PDF回传到本 地, 然后读取一下, 然后制";

	// Sanity: splitQuery would explode this into 30+ segments, but
	// recallAtoms caps the split at 3 and treats the whole string as a
	// single segment. The single-segment run must complete without
	// throwing (the previous version raised "no such column: Z01" from
	// FTS5 because `-` in `X101SC260410257-Z01-F001` was interpreted as
	// an implicit column-filter separator).
	const results = await recallAtoms(index, LONG_Q);
	expect(results).toBeDefined();
	expect(Array.isArray(results)).toBe(true);
	// BM25 now sees the project ID prefix `X101SC2604` after stripping
	// `-` and `.`, and dense sees the full string — the matching atom
	// (sharing the X101SC2605 project family via subword overlap) is
	// expected to surface via the dense channel above the cosine floor
	// OR via BM25 via the shared `X101SC2605` partial-token match (FTS5
	// unicode61 tokenizes the same on insert and query).
	const matched = results.find((r) => r.atom.id === a.id);
	expect(matched).toBeDefined();
});

	// (l) Per-type round-robin after RRF fusion strictly interleaves
	// adjacent types. The existing test (g) above only checks that both
	// types are PRESENT in the final list — a "preserves type diversity"
	// assertion that a non-interleaving implementation could still pass
	// (e.g. "all rules first, then all facts"). This test pins the
	// stricter contract: with 5 rule + 5 fact candidates and no process
	// atoms, the final 6-result list must strictly alternate
	// (rule, fact, rule, fact, rule, fact). The controlled-mock embedder
	// (`__COS:1`) makes every atom maximally dense-relevant (cosine 1.0
	// with the QRY query) so all 10 surface as dense-only rank-0 hits —
	// per-type cap of 3 then yields the deterministic 3+3=6 interleave
	// pattern.
	it("per-type round-robin after RRF fusion strictly alternates adjacent types", async () => {
		installControlledMock();
		// Insert 5 rule + 5 fact atoms, all maximally relevant to the query.
		for (let i = 0; i < 5; i++) {
			await insertAtom(
				sampleAtom({
					type: "rule",
					content: `__COS:1 ruleShared${i} token content unique`,
				}),
				index,
			);
			await insertAtom(
				sampleAtom({
					type: "fact",
					content: `__COS:1 factShared${i} token content unique`,
				}),
				index,
			);
		}

		const results = await recallAtoms(index, QRY, { recallThreshold: 0 });
		// Per-type cap of 3 yields 3 rule + 3 fact = 6 total (no process
		// atoms inserted → the process slot is empty for every round).
		expect(results.length).toBe(6);
		const types = results.map((r) => r.atom.type);
		const ruleCount = types.filter((t) => t === "rule").length;
		const factCount = types.filter((t) => t === "fact").length;
		expect(ruleCount).toBeLessThanOrEqual(3);
		expect(factCount).toBeLessThanOrEqual(3);
		// Round-robin: adjacent entries must have DIFFERENT types. This is
		// the strict-alternation check that test (g) above does not assert
		// — it is the load-bearing contract for the per-type interleaving
		// in `recallAtoms` (search.ts lines 296–307).
		for (let i = 0; i < results.length - 1; i++) {
			expect(results[i]?.atom.type).not.toBe(results[i + 1]?.atom.type);
		}
	});

	// (m) NEW (task 5.4) — score includes the `0.10 × tagOverlap` additive
	// term when a query segment token matches an atom's tag. We insert two
	// atoms with the SAME content (so dense cosine is equal), differing only
	// in tags: `matching` has `tags: ["code-style"]` so `tagOverlap=1.0` for
	// the query "code-style"; `baseline` has `tags: []` so `tagOverlap=0`.
	// Both use `makeAtom` (1-year-ago updated_at) so the freshness term is
	// negligible and the score delta isolates the tagOverlap contribution.
	//
	// We mock `vectorSearch` per type so the dense channel returns the same
	// cosine (0.7) for both atoms, regardless of how `insertAtom`'s embeddable
	// text weights the tag token — this isolates the tagOverlap contribution
	// from any incidental embedding differences that the tag join would
	// introduce in the real `buildEmbeddableText` path.
	it("score includes tag_overlap boost for atoms with matching tags", async () => {
		installCharBagMock();
		const matching = makeAtom({
			type: "rule",
			content: "code-style specific marker alpha beta",
			tags: ["code-style"],
		});
		const baseline = makeAtom({
			type: "fact",
			content: "code-style specific marker alpha beta",
			tags: [],
		});
		await insertAtom(matching, index);
		await insertAtom(baseline, index);

		// Pin the dense cosine to 0.7 for both atoms (above the 0.65 floor
		// so the dense hit survives the floor filter). Same distance →
		// same cosine for both, so the only score difference is the
		// tagOverlap additive term.
		const realVS = index.vectorSearch.bind(index);
		index.vectorSearch = ((embedding: number[], k: number, filter?: { type?: "rule" | "fact" | "process" }) => {
			if (filter?.type === "rule") return [{ id: matching.id, distance: Math.sqrt(0.6) }];
			if (filter?.type === "fact") return [{ id: baseline.id, distance: Math.sqrt(0.6) }];
			return realVS(embedding, k, filter);
		}) as typeof index.vectorSearch;

		const results = await recallAtoms(index, "code-style");
		const matchingHit = results.find((r) => r.atom.id === matching.id);
		const baselineHit = results.find((r) => r.atom.id === baseline.id);
		expect(matchingHit).toBeDefined();
		expect(baselineHit).toBeDefined();
		// tagOverlap is 1.0 when the (lowercased) query token exactly
		// matches an atom tag; 0 otherwise. computeTagOverlap tokenizes
		// on whitespace so "code-style" is a single token.
		expect(matchingHit?.tagOverlap).toBeCloseTo(1.0, 5);
		expect(baselineHit?.tagOverlap).toBe(0);
		// Both atoms have the same dense cosine (0.7) and same
		// strength/importance/freshness, so the score delta collapses
		// to the 0.10 tagOverlap term: 0.10 × (1.0 − 0) = 0.10.
		expect(matchingHit?.cosine).toBeCloseTo(0.7, 5);
		expect(baselineHit?.cosine).toBeCloseTo(0.7, 5);
		expect((matchingHit?.score ?? 0) - (baselineHit?.score ?? 0)).toBeCloseTo(0.10, 5);
	});

	// (n) NEW (task 5.4) — score includes the `0.05 × freshness` additive
	// term, decaying as `updated_at` ages. Two atoms with identical content
	// (so charBag cosine is equal) and identical tagOverlap (both have
	// empty tags), differing only in `updated_at`: 1 day ago vs 30 days
	// ago. The 30-day-old atom's score must be strictly less than the
	// 1-day-old atom's (the freshness term is monotonically decreasing
	// with `updated_at`).
	it("score includes freshness decay for older atoms", async () => {
		installCharBagMock();
		const fresh = makeAtom({
			type: "rule",
			content: "alpha specific marker beta gamma",
			tags: [],
			updated_at: Date.now() - 1 * 24 * 60 * 60 * 1000, // 1 day ago
		});
		const stale = makeAtom({
			type: "fact",
			content: "alpha specific marker beta gamma",
			tags: [],
			updated_at: Date.now() - 30 * 24 * 60 * 60 * 1000, // 30 days ago
		});
		await insertAtom(fresh, index);
		await insertAtom(stale, index);

		const results = await recallAtoms(index, "alpha");
		const freshHit = results.find((r) => r.atom.id === fresh.id);
		const staleHit = results.find((r) => r.atom.id === stale.id);
		expect(freshHit).toBeDefined();
		expect(staleHit).toBeDefined();
		// freshness is exp(-daysSinceUpdate / 30). 1-day → exp(-1/30) ≈
		// 0.9672; 30-day → exp(-1) ≈ 0.3679. The 5-decimal precision
		// matches the formula's claim of monotonic decay.
		expect(freshHit?.freshness).toBeCloseTo(Math.exp(-1 / 30), 5);
		expect(staleHit?.freshness).toBeCloseTo(Math.exp(-1), 5);
		// Score is strictly higher for the fresher atom — same cosine /
		// strength / importance / tagOverlap, only freshness differs.
		expect(freshHit?.score ?? 0).toBeGreaterThan(staleHit?.score ?? 0);
	});
});

// ---------------------------------------------------------------------------
// hybrid-recall storage contract
//
// The atom-level FTS5 sync points (init creates memory_fts, init backfills,
// insertAtom writes the row, markArchived deletes the row, markSupersededTx
// swaps the row, bm25Search escapes FTS5 special chars) are each tested in
// isolation in test/storage.test.ts (tasks 1.1–1.5). This describe block
// adds the hybrid-recall angle: it asserts that the contract holds when the
// whole pipeline is exercised in sequence, validating the user-facing
// outcome — that bm25Search surfaces / hides atoms exactly as the storage
// sync primitives would predict. A regression in any of the five storage
// sync points would fail this single test, narrowing the search space for
// whichever sync step broke.
//
// Reference: docs/sdd/changes/memory-hybrid-bm25-recall/specs/
// memory-search-decoupled/spec.md "FTS5 schema and storage sync".
// ---------------------------------------------------------------------------

describe("hybrid-recall storage FTS5 sync contract", () => {
	let index: MemoryIndex;

	beforeEach(async () => {
		index = new MemoryIndex(":memory:");
		await index.init();
	});

	afterEach(() => {
		index.close();
	});

	// One comprehensive test that walks init → insertAtom → bm25Search →
	// markArchived → bm25Search → markSupersededTx → bm25Search →
	// FTS5-special-char query. Each step validates a storage-level sync
	// primitive via its hybrid-recall consequence. If any sync point
	// regresses (memory_fts not created, not backfilled, insertAtom
	// doesn't write, markArchived doesn't delete, markSupersededTx doesn't
	// swap, escapeFtsQuery breaks), one of the assertions below flips.
	it("init + insertAtom + markArchived + markSupersededTx + escapeFtsQuery all wire through bm25Search", async () => {
		const db = index.getRawDb();

		// ─── (1) init creates memory_fts — structural assertion. ───
		const ftsRow = db
			.prepare(
				"SELECT name FROM sqlite_master WHERE type='table' AND name='memory_fts'",
			)
			.get() as { name: string } | undefined;
		expect(ftsRow).toBeDefined();
		expect(ftsRow?.name).toBe("memory_fts");

		// ─── (2) init is idempotent — second init must not duplicate
		// the schema, and the seed atoms inserted below must not appear
		// twice in memory_fts. ───
		await index.init();

		// ─── (3) Insert atom A → memory_fts row lands → bm25Search
		// surfaces A. ───
		// Use alnum-only tokens so FTS5 MATCH parses cleanly (FTS5 treats
		// `-` as NOT, double-quote as phrase, etc.).
		const a = sampleAtom({
			id: "atom-A",
			type: "rule",
			title: "alphaOldUniqueXYZ title",
			summary: "alphaOldUniqueXYZ summary",
			content: "alphaOldUniqueXYZ content with markers",
			tags: ["alphaOldUniqueXYZ"],
			content_fingerprint: "fp-A",
		});
		await insertAtom(a, index);

		// Structural: memory_fts has exactly one row for A.
		const ftsCountA = db
			.prepare("SELECT COUNT(*) AS c FROM memory_fts WHERE id = ?")
			.get("atom-A") as { c: number };
		expect(ftsCountA.c).toBe(1);

		// Behavioural: bm25Search returns A. This is the hybrid-recall
		// angle — the storage sync is invisible until bm25Search observes it.
		const hitsA = index.bm25Search("alphaOldUniqueXYZ", 10);
		expect(hitsA.map((r) => r.id)).toContain("atom-A");

		// ─── (4) markArchived → memory_fts row gone → bm25Search
		// no longer returns A. ───
		index.markArchived("atom-A");

		const ftsCountAfterArc = db
			.prepare("SELECT COUNT(*) AS c FROM memory_fts WHERE id = ?")
			.get("atom-A") as { c: number };
		expect(ftsCountAfterArc.c).toBe(0);

		const hitsAfterArc = index.bm25Search("alphaOldUniqueXYZ", 10);
		expect(hitsAfterArc.map((r) => r.id)).not.toContain("atom-A");

		// ─── (5) Insert atom B, then supersede B with C → memory_fts
		// has C's row and not B's. ───
		const b = sampleAtom({
			id: "atom-B",
			type: "fact",
			title: "betaOldUniqueXYZ title",
			summary: "betaOldUniqueXYZ summary",
			content: "betaOldUniqueXYZ content",
			tags: ["betaOldUniqueXYZ"],
			content_fingerprint: "fp-B",
		});
		await insertAtom(b, index);

		// Pre-condition: B is searchable.
		const hitsB = index.bm25Search("betaOldUniqueXYZ", 10);
		expect(hitsB.map((r) => r.id)).toContain("atom-B");

		// Supersede B with C — distinct alnum tokens per atom.
		const c = sampleAtom({
			id: "atom-C",
			type: "fact",
			title: "gammaNewUniqueXYZ title",
			summary: "gammaNewUniqueXYZ summary",
			content: "gammaNewUniqueXYZ content",
			tags: ["gammaNewUniqueXYZ"],
			content_fingerprint: "fp-C",
		});
		index.markSupersededTx("atom-B", c, new Array(DIM).fill(0.05));

		// B's row is gone (the DELETE half of the swap).
		const ftsCountBAfter = db
			.prepare("SELECT COUNT(*) AS c FROM memory_fts WHERE id = ?")
			.get("atom-B") as { c: number };
		expect(ftsCountBAfter.c).toBe(0);

		// C's row is present (the INSERT half of the swap).
		const ftsCountC = db
			.prepare("SELECT COUNT(*) AS c FROM memory_fts WHERE id = ?")
			.get("atom-C") as { c: number };
		expect(ftsCountC.c).toBe(1);

		// Behavioural: bm25Search for B's tokens no longer surfaces B.
		const hitsBAfter = index.bm25Search("betaOldUniqueXYZ", 10);
		expect(hitsBAfter.map((r) => r.id)).not.toContain("atom-B");

		// Behavioural: bm25Search for C's tokens surfaces C.
		const hitsC = index.bm25Search("gammaNewUniqueXYZ", 10);
		expect(hitsC.map((r) => r.id)).toContain("atom-C");

		// ─── (6) FTS5 special-character query is handled by
		// escapeFtsQuery — must not throw, and must still surface C if
		// literal tokens survive the strip. ───
		// Use ONLY special-char noise (`"()[]:*`); escapeFtsQuery strips
		// these to whitespace and `trim()` removes them, so the surviving
		// query is just `gammaNewUniqueXYZ`. FTS5 implicit AND on a single
		// token matches C without ambiguity.
		const specialQuery = 'gammaNewUniqueXYZ "()[]:*';
		expect(() => index.bm25Search(specialQuery, 10)).not.toThrow();
		const hitsSpecial = index.bm25Search(specialQuery, 10);
		expect(hitsSpecial.map((r) => r.id)).toContain("atom-C");

		// ─── (7) Idempotency re-check: the second init above must NOT
		// have created duplicate FTS5 rows for A, B, or C. ───
		const totalRows = db.prepare("SELECT COUNT(*) AS c FROM memory_fts").get() as {
			c: number;
		};
		// Only atom-C should have a row: A is archived, B is superseded.
		expect(totalRows.c).toBe(1);
	});
});

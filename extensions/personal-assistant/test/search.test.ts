// recallAtoms — per-type top-3 KNN with multiplicative boost score.
//
// Contract (from design.md Decisions 2, 7, 8):
//   - 3 independent vectorSearch calls (one per atom type), each capped at
//     DEFAULT_TOP_K = 3 by `cosine × (1 + 0.3 × strength + 0.2 × importance)`.
//   - Per-type lists sorted by score DESC, then interleaved round-robin so
//     each type gets a turn. Sparse types skip their slot (never pad with
//     cross-type items or placeholders).
//   - cosine < 0.65 is dropped after the KNN returns.
//   - Results carry `{ atom, distance, cosine, score }` — no `file_path`.
//   - Search is DISCOVERY ONLY: does NOT bump `access_count`. Programmatic
//     strength feedback is the responsibility of the agent's `memory_get`
//     tool (R-search-cheap / R-feedback-loop).
//   - `embedText` returning null → `recallAtoms` returns `[]`. No FTS /
//     keyword fallback (Decision 7).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { embedText } from "../embed.ts";
import { recallAtoms } from "../search.ts";
import { MemoryIndex } from "../storage.ts";
import type { MemoryAtom, RecallResult } from "../types.ts";

// ---------------------------------------------------------------------------
// Test scaffolding
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
 * vector `V_UNIT = [1, 0, 0, ...]` is exactly `dominant`. The construction
 * puts `dominant` at dimension 0 and `sqrt(1 - dominant²)` at dimension 1, so
 * two such vectors with the same `dominant` value also have cosine = `dominant`
 * with each other (dim-1 is orthogonal in cosine terms).
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

// Sentinels recognised by the controlled embedText mock. Tests that need
// precise cosine values prefix the atom's content with `__COS:<code>` and
// query with the literal string `__QUERY__`. The mock extracts the code
// from anywhere in the embedText input — the joined `insertAtom` text
// interleaves title/summary/content/tags, so a prefix-only match would miss.
const QRY = "__QUERY__";
const COS_RE = /__COS:([0-9.]+)/;

vi.mock("../embed.ts", async () => {
	const actual = await vi.importActual<typeof import("../embed.ts")>("../embed.ts");
	return {
		...actual,
		embedText: vi.fn(async (text: string) => {
			// Default implementation — char-bag fallback. Per-test setup may
			// override with `installControlledMock` for precise cosine values.
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

/** Switch embedText to controlled vectors (recognises `QRY` + `__COS:` sentinels). */
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("recallAtoms", () => {
	let index: MemoryIndex;

	beforeEach(async () => {
		// :memory: avoids WAL setup and per-test filesystem teardown. Search
		// no longer reads from disk, so the atomsDir parameter is now just a
		// signature-compat placeholder.
		index = new MemoryIndex(":memory:");
		await index.init();
		vi.mocked(embedText).mockReset();
		installCharBagMock();
	});

	afterEach(() => {
		index.close();
	});

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
		// 1 year ago by default so the score-formula additive `0.05 ×
		// freshness` term is `exp(-365/30) ≈ 5.2e-6` × 0.05 ≈ 2.6e-7
		// (negligible). Keeps the multiplicative-formula tests
		// (`toBeCloseTo(1.5, 5)`, `toBeCloseTo(1.05, 5)`) valid without
		// accounting for the +0.05 freshness boost.
		updated_at: Date.now() - 365 * 24 * 60 * 60 * 1000,
		last_access: null,
		content_fingerprint: `fp-${Math.random().toString(36).slice(2, 18)}`,
		source_session: null,
		...overrides,
	});

	const insertAtom = async (atom: MemoryAtom): Promise<void> => {
		const text = `${atom.title}\n\n${atom.summary}\n\n${atom.content}\n\n${atom.tags.join(" ")}`;
		const emb = await embedText(text);
		if (!emb) throw new Error("mocked embedText returned null in test setup");
		await index.insertAtom(atom, emb);
	};

	// (a) KEEP AS-IS — embedText null → empty result, no fallback.
	it("returns empty array when ollama is unreachable (no fallback)", async () => {
		// Force the recall-time embedText call to return null. Earlier calls
		// (none, since we don't insert any atoms here) still see the default.
		vi.mocked(embedText).mockResolvedValueOnce(null);

		const results = await recallAtoms(index, "test query");
		expect(results).toEqual([]);
	});

	// (b) UPDATE — per-type cap: 3 atoms (1 per type) → 3 results max.
	it("returns top-K results sorted by cosine (per-type cap)", async () => {
		const rule = sampleAtom({
			type: "rule",
			content: "common keyword alpha rule content extended",
		});
		const fact = sampleAtom({
			type: "fact",
			content: "common keyword alpha fact content extended",
		});
		const process = sampleAtom({
			type: "process",
			content: "common keyword alpha process content extended",
		});
		await insertAtom(rule);
		await insertAtom(fact);
		await insertAtom(process);

		const results = await recallAtoms(index, "common keyword alpha", {
			topK: 5,
		});
		// One atom per type → at most one result per type → 3 total.
		expect(results.length).toBe(3);
		// Each result must carry a finite positive score (cosine > 0 against
		// the query).
		expect(results.every((r: RecallResult) => Number.isFinite(r.score) && r.score > 0)).toBe(true);
		// Round-robin interleaves per-type lists in TYPES order
		// (rule → fact → process); position 0 is therefore the rule atom.
		expect(results[0]?.atom.id).toBe(rule.id);
		expect(results[1]?.atom.id).toBe(fact.id);
		expect(results[2]?.atom.id).toBe(process.id);
	});

	// (c) NEW — per-type cap = 3, even with topK > 3 and 5 matching atoms of
	// a single type. We use one type only because sqlite-vec's `k = N` is a
	// global KNN limit — with multiple types present, the top-N nearest may
	// span types and the per-type filter trims the result below the cap. The
	// per-type cap behaviour is best observed with a single type where every
	// matching atom is in the global top-N.
	it("respects per-type topK cap (3 per type)", async () => {
		for (let i = 0; i < 5; i++) {
			await insertAtom(
				sampleAtom({
					type: "rule",
					content: `Common shared content marker ${i} unique words ${i * 100}`,
				}),
			);
		}
		const results = await recallAtoms(index, "Common shared content marker", {
			topK: 20,
		});
		// Hard cap: only 3 of the 5 matching rule atoms surface, even though
		// the caller asked for 20 and 5 cleared the cosine threshold.
		expect(results.length).toBe(3);
		expect(results.every((r: RecallResult) => r.atom.type === "rule")).toBe(true);
	});

	// (d) KEEP AS-IS — filter restricts KNN to a single type.
	it("filters by type", async () => {
		const rule = sampleAtom({ type: "rule", content: "Rule content unique alpha keyword" });
		const fact = sampleAtom({ type: "fact", content: "Fact content unique beta keyword" });
		await insertAtom(rule);
		await insertAtom(fact);

		const results = await recallAtoms(index, "alpha content keyword", {
			filter: { type: "rule" },
		});
		expect(results.length).toBeGreaterThan(0);
		expect(results.every((r: RecallResult) => r.atom.type === "rule")).toBe(true);
	});

	// (e) KEEP AS-IS — archived atoms are filtered out by the KNN query.
	it("excludes archived atoms", async () => {
		const a = sampleAtom({ content: "Active content gamma signal unique" });
		const arch = sampleAtom({
			content: "Archived content delta signal unique",
			archived: 1,
		});
		await insertAtom(a);
		await insertAtom(arch);

		const results = await recallAtoms(index, "gamma signal unique");
		expect(results.find((r: RecallResult) => r.atom.id === arch.id)).toBeUndefined();
	});

	// (f) KEEP AS-IS — superseded (is_latest=0) atoms are filtered out.
	it("excludes superseded atoms (is_latest=0)", async () => {
		const a = sampleAtom({ content: "Latest content epsilon signal unique" });
		const sup = sampleAtom({
			content: "Superseded content zeta signal unique",
			is_latest: 0,
		});
		await insertAtom(a);
		await insertAtom(sup);

		const results = await recallAtoms(index, "epsilon signal unique");
		expect(results.find((r: RecallResult) => r.atom.id === sup.id)).toBeUndefined();
	});

	// (g) REPLACE old file_path test — discovery-only shape: id + score only.
	it("does NOT carry file_path (search is discovery-only with id+score)", async () => {
		const a = sampleAtom({
			type: "process",
			content: "discovery test xi signal unique",
		});
		await insertAtom(a);

		const results = await recallAtoms(index, "xi signal unique");
		expect(results.length).toBeGreaterThan(0);
		const first = results[0] as RecallResult;
		// Runtime check: the new contract drops `file_path` from results.
		// `RecallResult` no longer types the field, so use `hasOwn` rather
		// than direct property access (which the type system rejects).
		expect(Object.hasOwn(first, "file_path")).toBe(false);
		// The agent reads full content via memory_get(atom.id) — id is the
		// handle, not a path.
		expect(first.atom.id).toBe(a.id);
	});

	// (h) NEW — every result carries the multiplicative score field.
	it("returns score field for each result", async () => {
		const a = sampleAtom({ content: "Score field test omicron signal unique" });
		await insertAtom(a);

		const results = await recallAtoms(index, "omicron signal unique");
		expect(results.length).toBeGreaterThan(0);
		for (const r of results) {
			expect(typeof r.score).toBe("number");
			expect(Number.isFinite(r.score)).toBe(true);
			expect(r.score).toBeGreaterThan(0);
		}
	});

	// (i) REPLACE old updateAccess test — search does NOT bump access_count.
	it("does NOT bump access_count on search (programmatic feedback is via memory_get only)", async () => {
		const a = sampleAtom({ content: "No bump test pi signal unique" });
		await insertAtom(a);

		await recallAtoms(index, "pi signal unique");
		const got = index.getAtom(a.id);
		// Strength feedback is the memory_get tool's job, not search's.
		expect(got?.access_count).toBe(0);
	});

	// (j) NEW — sparse types skip their slot (no padding, no cross-type fill).
	it("sparse type slot is skipped in round-robin", async () => {
		// 1 rule + 0 fact + 2 process → round-robin yields:
		//   round 0: rule[0], (fact[0]=undef skip), process[0]
		//   round 1: (rule[1]=undef skip), (fact[1]=undef skip), process[1]
		// Final: [rule, process, process] — fact is sparse, no padding.
		const r1 = sampleAtom({
			type: "rule",
			content: "rule common content sigma marker",
		});
		const p1 = sampleAtom({
			type: "process",
			content: "process common content sigma marker",
		});
		const p2 = sampleAtom({
			type: "process",
			content: "process common content sigma marker two",
		});
		await insertAtom(r1);
		await insertAtom(p1);
		await insertAtom(p2);

		const results = await recallAtoms(index, "sigma marker");
		expect(results.length).toBe(3);
		expect(results[0]?.atom.type).toBe("rule");
		expect(results[1]?.atom.type).toBe("process");
		expect(results[2]?.atom.type).toBe("process");
	});

	// (k) NEW — cosine below threshold is dropped after vectorSearch returns.
	it("cosine below threshold (0.65) is dropped", async () => {
		installControlledMock();
		const a = sampleAtom({
			content: "__COS:0.4 below threshold atom rho signal",
		});
		await insertAtom(a);

		const results = await recallAtoms(index, QRY);
		expect(results.find((r: RecallResult) => r.atom.id === a.id)).toBeUndefined();
	});

	// (l) NEW — cosine=0 forces score=0; even max boost cannot rescue it.
	it("score formula: cosine=0 yields score=0 regardless of strength/importance", async () => {
		installControlledMock();
		// Orthogonal vector (cosine=0 with query). Even at max boost
		// (strength=1, importance=1), the multiplicative formula gives
		// score = 0 × (1 + 0.3 + 0.2) = 0, and the cosine=0 result falls
		// below the 0.5 threshold — so the atom never surfaces. An additive
		// formula would give score = 0 + 0.3 + 0.2 = 0.5, landing on the
		// threshold boundary; the multiplicative-anchor property is what
		// keeps this atom out of results.
		const a = sampleAtom({
			content: "__COS:0 orthogonal atom tau signal",
			strength: 1.0,
			importance: 1.0,
		});
		await insertAtom(a);

		const results = await recallAtoms(index, QRY);
		expect(results.find((r: RecallResult) => r.atom.id === a.id)).toBeUndefined();
	});

	// (m) NEW — cosine=1 with max boost yields score=1.5.
	it("score formula: cosine=1 with max boost yields score=1.5", async () => {
		installControlledMock();
		// score = 1 × (1 + 0.3 × 1 + 0.2 × 1) = 1.5.
		const a = sampleAtom({
			content: "__COS:1 perfect atom upsilon signal",
			strength: 1.0,
			importance: 1.0,
		});
		await insertAtom(a);

		// recallThreshold: 0 bypasses the strict default 1/rrfK gate so this
		// single-channel dense-only rank=1 hit (rrfScore 0.0164) surfaces.
		// This test isolates the score-formula math from the recall gate.
		const results = await recallAtoms(index, QRY, { recallThreshold: 0 });
		expect(results.length).toBe(1);
		expect(results[0]?.atom.id).toBe(a.id);
		expect(results[0]?.score).toBeCloseTo(1.5, 5);
	});

	// (n) NEW — score follows the multiplicative formula exactly.
	it("score field follows the multiplicative formula", async () => {
		installControlledMock();
		// score = 0.7 × (1 + 0.3 × 1 + 0.2 × 1) = 0.7 × 1.5 = 1.05.
		const a = sampleAtom({
			content: "__COS:0.7 mid cosine atom phi signal",
			strength: 1.0,
			importance: 1.0,
		});
		await insertAtom(a);

		// recallThreshold: 0 bypasses the strict default 1/rrfK gate so this
		// single-channel dense-only rank=1 hit (rrfScore 0.0164) surfaces.
		// This test isolates the score-formula math from the recall gate.
		const results = await recallAtoms(index, QRY, { recallThreshold: 0 });
		expect(results.length).toBe(1);
		expect(results[0]?.atom.id).toBe(a.id);
		expect(results[0]?.score).toBeCloseTo(1.05, 5);
	});

	// (o) NEW — round-robin interleaves per-type slots in canonical order.
	//
	// We mock `index.vectorSearch` per type filter because sqlite-vec's
	// `k = N` is a global KNN limit; with multiple types in the index, the
	// top-N nearest can span types and the per-type filter trims the result
	// below the per-type cap. Mocking isolates the round-robin algorithm
	// from the KNN's global-k behaviour so we can exercise a 3+3+3 → 9
	// result interleaving directly.
	it("round-robin interleaves type slots", async () => {
		// Build 3 atoms of each type so getAtom() inside search.ts can
		// resolve every mocked id back to a real row.
		const ruleAtoms: MemoryAtom[] = [];
		const factAtoms: MemoryAtom[] = [];
		const processAtoms: MemoryAtom[] = [];
		for (let i = 0; i < 3; i++) {
			ruleAtoms.push(
				await (async () => {
					const a = sampleAtom({
						type: "rule",
						content: `rule ${i} round robin common content chi marker`,
					});
					await insertAtom(a);
					return a;
				})(),
			);
			factAtoms.push(
				await (async () => {
					const a = sampleAtom({
						type: "fact",
						content: `fact ${i} round robin common content chi marker`,
					});
					await insertAtom(a);
					return a;
				})(),
			);
			processAtoms.push(
				await (async () => {
					const a = sampleAtom({
						type: "process",
						content: `process ${i} round robin common content chi marker`,
					});
					await insertAtom(a);
					return a;
				})(),
			);
		}

		// Mock vectorSearch to return 3 per type. Distances are crafted so
		// cosine = 1 - dist²/2 = 0.9 (well above the 0.5 threshold) and so
		// that within-type ordering is stable: rule-0 < rule-1 < rule-2 by
		// score (i.e., higher cosine first).
		const makeEntries = (atoms: MemoryAtom[]) =>
			atoms.map((a, i) => ({ id: a.id, distance: Math.sqrt(0.2) + i * 0.001 }));

		index.vectorSearch = ((_embedding: number[], _k: number, filter?: { type?: string }) => {
			if (filter?.type === "rule") return makeEntries(ruleAtoms);
			if (filter?.type === "fact") return makeEntries(factAtoms);
			if (filter?.type === "process") return makeEntries(processAtoms);
			return [];
		}) as typeof index.vectorSearch;

		const results = await recallAtoms(index, "round robin common content chi marker");
		expect(results.length).toBe(9);
		// Round-robin interleaves per-type lists in TYPES order. Position k:
		//   rule   at k ∈ {0, 3, 6}
		//   fact   at k ∈ {1, 4, 7}
		//   process at k ∈ {2, 5, 8}
		expect(results[0]?.atom.type).toBe("rule");
		expect(results[1]?.atom.type).toBe("fact");
		expect(results[2]?.atom.type).toBe("process");
		expect(results[3]?.atom.type).toBe("rule");
		expect(results[4]?.atom.type).toBe("fact");
		expect(results[5]?.atom.type).toBe("process");
		expect(results[6]?.atom.type).toBe("rule");
		expect(results[7]?.atom.type).toBe("fact");
		expect(results[8]?.atom.type).toBe("process");
		// And the within-type order must match the score-DESC order we
		// mocked (rule-0 first, rule-1 second, rule-2 third).
		expect(results[0]?.atom.id).toBe(ruleAtoms[0]!.id);
		expect(results[3]?.atom.id).toBe(ruleAtoms[1]!.id);
		expect(results[6]?.atom.id).toBe(ruleAtoms[2]!.id);
	});

	// (p) NEW — empty index yields empty result across all three type slots.
	it("returns empty when all 3 types have zero matching atoms", async () => {
		const results = await recallAtoms(index, "anything at all");
		expect(results).toEqual([]);
	});
});
import { describe, it, expect } from "vitest";
import { formatMemoryContext } from "../format.ts";
import type { RecallResult, MemoryAtom } from "../types.ts";

const sampleAtom = (overrides: Partial<MemoryAtom> = {}): MemoryAtom => ({
	id: crypto.randomUUID(),
	type: "rule",
	title: "T",
	content: "Detailed content here",
	summary: "S",
	tags: [],
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
	content_fingerprint: "fp",
	source_session: null,
	...overrides,
});

const sampleResult = (overrides: Partial<RecallResult> = {}): RecallResult => ({
	atom: sampleAtom(overrides.atom as never),
	cosine: 0.75,
	sparseScore: 0.2,
	rrf: 0.0167,
	relativePath: "rule/abc.md",
	...overrides,
});

/**
 * R3 / recall-precision task 1.3 — formatMemoryContext sorts by rerankScore
 * DESC with rrf DESC fallback for hits where rerankScore === undefined.
 *
 * Spec R3: "原 RRF score 不再参与排序, formatMemoryContext 按 rerank_score 降序"
 * (design.md D5). The `-1` sentinel for `undefined` rerankScore means a hit
 * without a rerank score sorts after ANY hit with a real score (including 0).
 */
describe("formatMemoryContext sort — rerankScore DESC with rrf fallback", () => {
	it("mixed rerankScore + undefined: scored hits first (DESC), then undefined by rrf DESC", () => {
		// 5 hits, mixed: scored ones (0.92, 0.85, 0.55) + undefined (rrf 0.15, 0.08).
		// Input order is intentionally scrambled to ensure the formatter re-sorts.
		const results = [
			sampleResult({
				rerankScore: 0.85,
				rrf: 0.10,
				atom: sampleAtom({ title: "hit_1_rr0.85" }),
			}),
			sampleResult({
				rrf: 0.08,
				atom: sampleAtom({ title: "hit_3_undef_rr0.08" }),
			}),
			sampleResult({
				rerankScore: 0.55,
				rrf: 0.20,
				atom: sampleAtom({ title: "hit_4_rr0.55_rrf0.20" }),
			}),
			sampleResult({
				rerankScore: 0.92,
				rrf: 0.05,
				atom: sampleAtom({ title: "hit_0_rr0.92" }),
			}),
			sampleResult({
				rrf: 0.15,
				atom: sampleAtom({ title: "hit_2_undef_rr0.15" }),
			}),
		];

		const out = formatMemoryContext(results, 10000);
		expect(out.included).toBe(5);

		// Expected order: hit_0 (0.92) > hit_1 (0.85) > hit_4 (0.55) >
		// hit_2 (undef, rrf 0.15) > hit_3 (undef, rrf 0.08).
		const idx0 = out.text.indexOf("hit_0_rr0.92");
		const idx1 = out.text.indexOf("hit_1_rr0.85");
		const idx4 = out.text.indexOf("hit_4_rr0.55_rrf0.20");
		const idx2 = out.text.indexOf("hit_2_undef_rr0.15");
		const idx3 = out.text.indexOf("hit_3_undef_rr0.08");

		expect(idx0).toBeGreaterThan(-1);
		expect(idx1).toBeGreaterThan(-1);
		expect(idx4).toBeGreaterThan(-1);
		expect(idx2).toBeGreaterThan(-1);
		expect(idx3).toBeGreaterThan(-1);

		// Scored hits before undefined hits (any real score > -1 sentinel).
		expect(idx0).toBeLessThan(idx2);
		expect(idx0).toBeLessThan(idx3);
		expect(idx1).toBeLessThan(idx2);
		expect(idx1).toBeLessThan(idx3);
		expect(idx4).toBeLessThan(idx2);
		expect(idx4).toBeLessThan(idx3);

		// Scored hits in rerankScore DESC order.
		expect(idx0).toBeLessThan(idx1);
		expect(idx1).toBeLessThan(idx4);

		// Undefined hits in rrf DESC order.
		expect(idx2).toBeLessThan(idx3);
	});

	it("all undefined rerankScore: falls back to rrf DESC (backward compat)", () => {
		const results = [
			sampleResult({
				rrf: 0.05,
				atom: sampleAtom({ title: "WORST" }),
			}),
			sampleResult({
				rrf: 0.15,
				atom: sampleAtom({ title: "BEST" }),
			}),
			sampleResult({
				rrf: 0.10,
				atom: sampleAtom({ title: "MID" }),
			}),
		];

		const out = formatMemoryContext(results, 10000);
		const bestIdx = out.text.indexOf("BEST");
		const midIdx = out.text.indexOf("MID");
		const worstIdx = out.text.indexOf("WORST");

		expect(bestIdx).toBeGreaterThan(-1);
		expect(midIdx).toBeGreaterThan(-1);
		expect(worstIdx).toBeGreaterThan(-1);

		expect(bestIdx).toBeLessThan(midIdx);
		expect(midIdx).toBeLessThan(worstIdx);
	});

	it("tie on rerankScore: secondary key is rrf DESC (stable ordering by score)", () => {
		// Both hit 0 and hit 1 share rerankScore=0.55. rrf breaks the tie:
		// hit 0 (rrf 0.05) should come before hit 1 (rrf 0.04).
		const results = [
			sampleResult({
				rerankScore: 0.55,
				rrf: 0.04,
				atom: sampleAtom({ title: "TIE_LOW_RRF" }),
			}),
			sampleResult({
				rerankScore: 0.55,
				rrf: 0.05,
				atom: sampleAtom({ title: "TIE_HIGH_RRF" }),
			}),
		];

		const out = formatMemoryContext(results, 10000);
		const highIdx = out.text.indexOf("TIE_HIGH_RRF");
		const lowIdx = out.text.indexOf("TIE_LOW_RRF");

		expect(highIdx).toBeGreaterThan(-1);
		expect(lowIdx).toBeGreaterThan(-1);
		expect(highIdx).toBeLessThan(lowIdx);
	});

	it("rerankScore=0 still ranks BEFORE undefined rerankScore (sentinel -1 < 0)", () => {
		// Critical edge: a real 0 (lowest possible real score) must sort AFTER
		// any positive score, but BEFORE any undefined (-1 sentinel).
		const results = [
			sampleResult({
				atom: sampleAtom({ title: "UNDEFINED_HIT" }),
			}),
			sampleResult({
				rerankScore: 0,
				rrf: 0.01,
				atom: sampleAtom({ title: "ZERO_SCORE_HIT" }),
			}),
			sampleResult({
				rerankScore: 0.5,
				rrf: 0.01,
				atom: sampleAtom({ title: "HALF_SCORE_HIT" }),
			}),
		];

		const out = formatMemoryContext(results, 10000);
		const halfIdx = out.text.indexOf("HALF_SCORE_HIT");
		const zeroIdx = out.text.indexOf("ZERO_SCORE_HIT");
		const undefIdx = out.text.indexOf("UNDEFINED_HIT");

		expect(halfIdx).toBeGreaterThan(-1);
		expect(zeroIdx).toBeGreaterThan(-1);
		expect(undefIdx).toBeGreaterThan(-1);

		expect(halfIdx).toBeLessThan(zeroIdx);
		expect(zeroIdx).toBeLessThan(undefIdx);
	});
});
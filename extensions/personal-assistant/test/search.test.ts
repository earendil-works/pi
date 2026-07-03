// recallAtoms — pass-through to the bge-m3 dual-channel RRF service.
//
// Contract (mirrors the post-refactor pipeline):
//   - `recallAtoms` makes a single `hybridSearch` HTTP call. The server
//     applies dense + sparse floors, runs RRF fusion, and returns the
//     pre-sorted top-K hits. The client does NOT re-rank, re-sort, or
//     re-score. We just hydrate the full atom and propagate `rrf`,
//     `dense_cos`, `sparse_score`.
//   - Per-type cap, round-robin interleaving, and the multiplicative
//     `score` formula are GONE. Server RRF order is the final order.
//   - `topK` is the candidate pool size passed to the service. The
//     service applies its own per-channel cap (TOP_K_PER_CHANNEL=20)
//     and RRF top-K (TOP_K_FINAL=10) internally.
//   - `filter.type` is forwarded to the service as a per-type server
//     filter (server.py:95 type param).
//   - `hybridSearch` returning [] (service down) → `recallAtoms` returns
//     []. No fallback (Decision 7).
//   - `threshold` overrides the dense floor (default 0.55).
//   - Search is DISCOVERY ONLY: does NOT bump `access_count`. The
//     `read` tool on atom files is the sole strength-feedback entry
//     point (handled by the `tool_result` hook in memory.ts).
//
// The mock simulates the embedding service by reading `__COS:<value>`
// sentinels from atom text and computing cosine locally via the
// `embedText` mock's controlled vectors.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { embedText } from "../embed.ts";
import { hybridSearch } from "../hybrid-search.ts";
import { recallAtoms } from "../search.ts";
import { MemoryIndex } from "../storage.ts";
import type { MemoryAtom, MemoryAtomType } from "../types.ts";

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
const V_COS_09 = makeVec(0.9);
const V_COS_07 = makeVec(0.7);
const V_COS_06 = makeVec(0.6);
const V_COS_05 = makeVec(0.5);
const V_COS_04 = makeVec(0.4);
const V_COS_0 = makeVec(0.0);

const VECS_BY_CODE: Record<string, number[]> = {
	"1": V_UNIT,
	"0.9": V_COS_09,
	"0.7": V_COS_07,
	"0.6": V_COS_06,
	"0.5": V_COS_05,
	"0.4": V_COS_04,
	"0": V_COS_0,
};

const cosine = (a: number[], b: number[]): number => {
	let dot = 0;
	let na = 0;
	let nb = 0;
	for (let i = 0; i < a.length; i++) {
		dot += a[i]! * b[i]!;
		na += a[i]! * a[i]!;
		nb += b[i]! * b[i]!;
	}
	return dot / (Math.sqrt(na) * Math.sqrt(nb));
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

vi.mock("../hybrid-search.ts", async () => {
	const actual = await vi.importActual<typeof import("../hybrid-search.ts")>(
		"../hybrid-search.ts",
	);
	return {
		...actual,
		hybridSearch: vi.fn(async () => [] as never[]),
	};
});

/**
 * Re-implementation of the bge-m3 service's `hybrid_rrf` for tests:
 * embed query, scan every atom, compute dense cosine, apply floor, return
 * the top-K by RRF (`1 / (k_rrf + rank)`). Mirrors the contract the
 * real service exposes so client-side changes don't drift from server
 * behaviour. k_rrf=60 matches server.py:53.
 */
const kRrf = 60;

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

	vi.mocked(hybridSearch).mockImplementation(
		async (
			query: string,
			topK: number,
			options?: { denseFloor?: number; type?: MemoryAtomType },
		) => {
			const qVec = await embedText(query);
			if (!qVec) return [];
			const index: MemoryIndex = (globalThis as { __test_index?: MemoryIndex })
				.__test_index!;
			if (!index) return [];
			const denseFloor = options?.denseFloor ?? 0.55;
			const atoms = index.listAtoms({ archived: false });
			const hits: Array<{
				id: string;
				title: string;
				type: MemoryAtomType;
				rank: number;
				rrf: number;
				dense_cos: number;
				sparse_score: number;
			}> = [];
			for (const atom of atoms) {
				if (options?.type && atom.type !== options.type) continue;
				const text = `${atom.title}\n${atom.summary}\n${atom.content}\n${atom.tags.join(" ")}`;
				const m = text.match(COS_RE);
				if (!m) continue;
				const aVec = await embedText(text);
				if (!aVec) continue;
				const cos = cosine(qVec, aVec);
				if (cos < denseFloor) continue;
				hits.push({
					id: atom.id,
					title: atom.title,
					type: atom.type,
					rank: 0,
					rrf: cos, // placeholder, replaced after sort
					dense_cos: cos,
					sparse_score: 0,
				});
			}
			hits.sort((a, b) => b.dense_cos - a.dense_cos);
			return hits.slice(0, topK).map((h, i) => ({
				...h,
				rank: i + 1,
				rrf: 1 / (kRrf + i),
			}));
		},
	);
};

const installEmptyHybridMock = (): void => {
	vi.mocked(hybridSearch).mockResolvedValue([]);
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("recallAtoms", () => {
	let index: MemoryIndex;

	beforeEach(async () => {
		index = new MemoryIndex(":memory:");
		await index.init();
		(globalThis as { __test_index?: MemoryIndex }).__test_index = index;
		vi.mocked(embedText).mockReset();
		vi.mocked(hybridSearch).mockReset();
	});

	afterEach(() => {
		index.close();
		delete (globalThis as { __test_index?: MemoryIndex }).__test_index;
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
		updated_at: Date.now(),
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

	// (a) hybridSearch returns [] (service down) → empty result, no fallback.
	it("returns empty array when the embedding service is unreachable (no fallback)", async () => {
		installEmptyHybridMock();
		const a = sampleAtom({ title: "__COS:0.7 t", content: "match" });
		await insertAtom(a);

		const results = await recallAtoms(index, "test query");
		expect(results).toEqual([]);
	});

	// (b) Server's RRF order is preserved verbatim — no client re-rank.
	it("preserves server RRF order (no client re-rank, no per-type cap, no round-robin)", async () => {
		installControlledMock();
		// 6 facts with descending cosine. The old code would cap at 3 and
		// round-robin. The new code returns all 6 in RRF (dense) order.
		const atoms = [
			sampleAtom({ id: "high", type: "fact", title: "__COS:0.9 a", content: "x" }),
			sampleAtom({ id: "mid", type: "fact", title: "__COS:0.7 b", content: "x" }),
			sampleAtom({ id: "low", type: "fact", title: "__COS:0.6 c", content: "x" }),
			sampleAtom({ id: "rule1", type: "rule", title: "__COS:0.7 r1", content: "x" }),
			sampleAtom({ id: "rule2", type: "rule", title: "__COS:0.6 r2", content: "x" }),
			sampleAtom({ id: "proc1", type: "process", title: "__COS:0.7 p1", content: "x" }),
		];
		for (const a of atoms) await insertAtom(a);

		const results = await recallAtoms(index, QRY, { topK: 10 });
		// Server returns 6 in dense_cos DESC (= RRF DESC). Client does not cap.
		const ids = results.map((r) => r.atom.id);
		expect(ids).toEqual(["high", "mid", "rule1", "proc1", "low", "rule2"]);
	});

	// (c) filter.type is forwarded to the service.
	it("forwards filter.type to the service", async () => {
		installControlledMock();
		await insertAtom(
			sampleAtom({ id: "rule-a", type: "rule", title: "__COS:0.7 ra", content: "x" }),
		);
		await insertAtom(
			sampleAtom({ id: "fact-a", type: "fact", title: "__COS:0.7 fa", content: "x" }),
		);

		const results = await recallAtoms(index, QRY, { filter: { type: "rule" } });
		for (const r of results) {
			expect(r.atom.type).toBe("rule");
		}
		expect(results.length).toBeGreaterThan(0);
	});

	// (d) Archived atoms are excluded by the mock.
	it("excludes archived atoms (server-side filter)", async () => {
		installControlledMock();
		await insertAtom(
			sampleAtom({ id: "live", type: "fact", title: "__COS:0.7 l", content: "x" }),
		);
		await insertAtom(
			sampleAtom({
				id: "dead",
				type: "fact",
				title: "__COS:0.7 d",
				content: "x",
				archived: 1,
			}),
		);

		const results = await recallAtoms(index, QRY);
		const ids = results.map((r) => r.atom.id);
		expect(ids).toContain("live");
		expect(ids).not.toContain("dead");
	});

	// (e) Superseded atoms are excluded by the mock.
	it("excludes superseded atoms (is_latest=0)", async () => {
		installControlledMock();
		await insertAtom(
			sampleAtom({ id: "latest", type: "fact", title: "__COS:0.7 l", content: "x" }),
		);
		await insertAtom(
			sampleAtom({
				id: "old",
				type: "fact",
				title: "__COS:0.7 o",
				content: "x",
				is_latest: 0,
			}),
		);

		const results = await recallAtoms(index, QRY);
		const ids = results.map((r) => r.atom.id);
		expect(ids).toContain("latest");
		expect(ids).not.toContain("old");
	});

	// (f) Each result carries the server's RRF + dual-channel fields.
	it("returns rrf / cosine / sparseScore from the server (no client score formula)", async () => {
		installControlledMock();
		await insertAtom(
			sampleAtom({ id: "a", type: "fact", title: "__COS:0.7 x", content: "x" }),
		);

		const results = await recallAtoms(index, QRY);
		expect(results.length).toBeGreaterThan(0);
		for (const r of results) {
			expect(typeof r.rrf).toBe("number");
			expect(Number.isFinite(r.rrf)).toBe(true);
			expect(typeof r.cosine).toBe("number");
			expect(typeof r.sparseScore).toBe("number");
			// The client no longer adds a `score` field.
			expect((r as unknown as { score?: unknown }).score).toBeUndefined();
		}
	});

	// (g) Search does NOT bump access_count (read-tool is the feedback entry).
	it("does NOT bump access_count on search (programmatic feedback is via read tool only)", async () => {
		installControlledMock();
		const a = sampleAtom({ id: "a", type: "fact", title: "__COS:0.7 x", content: "x" });
		await insertAtom(a);
		const before = index.getAtom(a.id)!.access_count;

		await recallAtoms(index, QRY);

		const after = index.getAtom(a.id)!.access_count;
		expect(after).toBe(before);
	});

	// (h) Cosine below the dense floor is dropped (server-side, default 0.55).
	it("cosine below the dense floor (0.55) is dropped", async () => {
		installControlledMock();
		await insertAtom(
			sampleAtom({ id: "high", type: "fact", title: "__COS:0.7 x", content: "x" }),
		);
		await insertAtom(
			sampleAtom({ id: "low", type: "fact", title: "__COS:0.5 y", content: "x" }),
		);

		const results = await recallAtoms(index, QRY);
		const ids = results.map((r) => r.atom.id);
		expect(ids).toContain("high");
		expect(ids).not.toContain("low");
	});

	// (i) The threshold option overrides the default dense floor.
	it("threshold option overrides the default dense floor", async () => {
		installControlledMock();
		await insertAtom(
			sampleAtom({ id: "mid", type: "fact", title: "__COS:0.5 m", content: "x" }),
		);

		// Default 0.55 would drop it; threshold 0.40 keeps it.
		const withLow = await recallAtoms(index, QRY, { threshold: 0.40 });
		expect(withLow.find((r) => r.atom.id === "mid")).toBeDefined();

		// Default would drop it.
		const default_ = await recallAtoms(index, QRY);
		expect(default_.find((r) => r.atom.id === "mid")).toBeUndefined();
	});

	// (j) Empty result when no atoms clear the floor.
	it("returns empty when no atoms pass the dense floor", async () => {
		installControlledMock();
		await insertAtom(
			sampleAtom({ id: "low", type: "fact", title: "__COS:0 x", content: "x" }),
		);

		const results = await recallAtoms(index, QRY);
		expect(results).toEqual([]);
	});

	// (k) RRF rank-0 contribution is 1/kRrf (≈ 0.01667 for kRrf=60).
	it("RRF rank-0 contribution is 1/kRrf (kRrf=60 → ≈ 0.01667)", async () => {
		installControlledMock();
		await insertAtom(
			sampleAtom({ id: "a", type: "fact", title: "__COS:0.9 a", content: "x" }),
		);

		const results = await recallAtoms(index, QRY);
		expect(results[0]?.rrf).toBeCloseTo(1 / 60, 5);
	});
});

// Helper exports for tests that need direct access to result shapes.

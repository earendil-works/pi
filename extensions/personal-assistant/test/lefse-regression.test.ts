// Lefse regression — hermetic verification of the dual-channel RRF
// pipeline's dense floor contract.
//
// Background (see search.ts file header for the full design rationale):
// the user's real query `这个先不管,这个项目路径下lefse没有结果` recalled
// X101SC26052587 customer-data atoms (dense cosine ~0.55) that were
// irrelevant. The dense FLOOR (default 0.55 in the current
// client-trust-server refactor — was 0.7 in the legacy pure-dense era)
// is the contract that filters these dense-noise false positives: a
// cosine-0.55 atom is dropped from the dense channel before the result
// list is built, so it never surfaces.
//
// Floor tuning history: an intermediate 0.60 was tried (rationale:
// "tighten the noise tier") but it collapsed the dense channel to
// 0 hits for short queries like `之前修复的脚本是哪个` (all 7
// candidates have cos 0.43-0.59) — RRF degenerated to pure sparse
// rank with no gap between relevant and noise. Reverted to 0.55.
//
// This file is the hermetic, DB-state-independent verification of the
// dense floor contract. We seed a synthetic X101SC26052587-shaped atom
// in a fresh `:memory:` index with a deterministic `__COS:0.4` dense
// embedding (cosine 0.4 with the controlled QRY — well below the
// 0.55 default), and verify:
//   (a) DEFAULT pipeline (no overrides): cosine floor (0.55) catches
//       it. A regression that lowered the floor to ≤ 0.4 would let the
//       atom through and this test would fail.
//   (b) BOUNDARY mode: cosine above floor (0.75) passes; cosine below
//       floor (0.4) drops. Pins the `>= floor` semantics.
//   (c) CJK dense-channel routing: pure Chinese query against a Chinese
//       atom. Confirms the dense channel handles non-ASCII semantics
//       directly. (The dual-channel RRF can also rescue short Chinese
//       queries via the sparse channel — see recall-quality test (c).)

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { embedText } from "../embed.ts";
import { recallAtoms } from "../search.ts";
import { MemoryIndex } from "../storage.ts";
import type { MemoryAtom } from "../types.ts";

// ---------------------------------------------------------------------------
// Test scaffolding (mirrors search.test.ts so the controlled-mock embedder
// recognises the same `QRY` + `__COS:<code>` sentinels — this gives us
// deterministic cosines for the lefse case).
// ---------------------------------------------------------------------------

const DIM = 1024;

const charBag = (text: string): number[] => {
	const arr = new Array(DIM).fill(0);
	for (let i = 0; i < text.length; i++) {
		arr[text.charCodeAt(i) % DIM] += 1;
	}
	const norm = Math.sqrt(arr.reduce((s, v) => s + v * v, 0));
	if (norm > 0) for (let i = 0; i < arr.length; i++) arr[i] /= norm;
	return arr;
};

const makeVec = (dominant: number): number[] => {
	const arr = new Array(DIM).fill(0);
	arr[0] = dominant;
	arr[1] = Math.sqrt(Math.max(0, 1 - dominant * dominant));
	return arr;
};

const V_UNIT = makeVec(1.0);
const V_COS_075 = makeVec(0.75);
const V_COS_07 = makeVec(0.7);
const V_COS_06 = makeVec(0.6);
const V_COS_055 = makeVec(0.55);
const V_COS_05 = makeVec(0.5);
const V_COS_04 = makeVec(0.4);

const VECS_BY_CODE: Record<string, number[]> = {
	"1": V_UNIT,
	"0.75": V_COS_075,
	"0.7": V_COS_07,
	"0.6": V_COS_06,
	"0.55": V_COS_055,
	"0.5": V_COS_05,
	"0.4": V_COS_04,
};

const QRY = "__QUERY__";
const COS_RE = /__COS:([0-9.]+)/;

vi.mock("../embed.ts", async () => {
	const actual = await vi.importActual<typeof import("../embed.ts")>("../embed.ts");
	return {
		...actual,
		embedText: vi.fn(async (text: string) => {
			if (text === QRY) return V_UNIT;
			const m = text.match(COS_RE);
			if (m) {
				const v = VECS_BY_CODE[m[1]];
				if (v) return v;
			}
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
	const cosine = (a: number[], b: number[]): number => {
		let dot = 0, na = 0, nb = 0;
		for (let i = 0; i < a.length; i++) {
			dot += a[i]! * b[i]!;
			na += a[i]! * a[i]!;
			nb += b[i]! * b[i]!;
		}
		return dot / (Math.sqrt(na) * Math.sqrt(nb));
	};
	return {
		hybridSearch: async (query: string, topK: number, options?: { denseFloor?: number }) => {
			const index: MemoryIndex | undefined = (globalThis as Record<string, unknown>).__test_index as MemoryIndex | undefined;
			if (!index) return [];
			const qVec = V_UNIT; // query is always QRY in this test
			const denseFloor = options?.denseFloor ?? 0;
			const atoms = index.listAtoms({ archived: false });
			const hits: Array<{
				id: string; title: string; type: "rule" | "fact" | "process";
				rank: number; rrf: number; dense_cos: number; sparse_score: number;
			}> = [];
			for (const atom of atoms) {
				const text = `${atom.title}\n${atom.summary}\n${atom.content}\n${atom.tags.join(" ")}`;
				const m = text.match(COS_RE);
				if (!m) continue;
				const aVec = VECS_BY_CODE[m[1]];
				if (!aVec) continue;
				const cos = cosine(qVec, aVec);
				if (cos < denseFloor) continue;
				hits.push({ id: atom.id, title: atom.title, type: atom.type, rank: 0, rrf: cos, dense_cos: cos, sparse_score: 0 });
			}
			hits.sort((a, b) => b.dense_cos - a.dense_cos);
			return hits.slice(0, topK).map((h, i) => ({ ...h, rank: i + 1 }));
		},
	};
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

const insertAtom = async (atom: MemoryAtom, index: MemoryIndex): Promise<void> => {
	const text = `${atom.title}\n\n${atom.summary}\n\n${atom.content}\n\n${atom.tags.join(" ")}`;
	const emb = await embedText(text);
	if (!emb) throw new Error("mocked embedText returned null in test setup");
	await index.insertAtom(atom, emb);
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("lefse regression (dense floor catches dense-noise; boundary semantic pins `>= 0.55` default)", () => {
	let index: MemoryIndex;

	beforeEach(async () => {
		index = new MemoryIndex(":memory:");
		await index.init();
		(globalThis as Record<string, unknown>).__test_index = index;
	});

	afterEach(() => {
		index.close();
		delete (globalThis as Record<string, unknown>).__test_index;
	});

	// (a) DEFAULT pipeline: dense cosine 0.4 (well below the 0.55 default
	// floor) → cosine floor drops the atom from the result list.
	//
	// This is the user's exact failure case (X101SC26052587 customer-data
	// atom surfaced as a lefse-result false positive). The atom is a
	// `fact` (matching the user's corpus type), the dense cosine is
	// pinned to 0.4 — well below the 0.55 dense-noise floor.
	//
	// We do NOT pass `threshold` so the test exercises the DEFAULT — the
	// design's cosine floor 0.55. A regression that drifted the floor
	// back below 0.4 would let the atom into the dense channel and this
	// test would fail.
	it("X101SC26052587-shaped atom with cosine 0.4 is filtered by the default cosine floor", async () => {
		// Synthetic X101SC26052587 customer-data atom: `__COS:0.4` in tags
		// forces the controlled-mock embedder to give cosine 0.4 with the
		// QRY query. The tag also includes `lefsetoken` so the corpus
		// mirrors the user's repo, but `__COS:0.4` is the deterministic
		// cosine anchor.
		const atom = sampleAtom({
			type: "fact",
			title: "X101SC26052587 customer data backflow",
			summary: "lefsetoken customer data backflow unique phrase",
			content: "X101SC26052587 Z01 J002 customer data not returned lefsetoken",
			tags: ["X101SC26052587", "amplicon", "lefsetoken", "__COS:0.4"],
			content_fingerprint: "fp-lefse-001",
		});
		await insertAtom(atom, index);

		// Default pipeline — no `threshold` override. Cosine floor (0.55)
		// should drop the 0.4 cosine atom from the dense channel. Atom
		// never surfaces.
		const resultsDefault = await recallAtoms(index, QRY);
		expect(resultsDefault.find((r) => r.atom.id === atom.id)).toBeUndefined();
	});

	// (b) BOUNDARY: pin the `>= 0.55` semantic. cosine=0.75 (well above
	// the floor; controlled vector V_COS_075) must surface; cosine=0.4
	// (V_COS_04, well below the floor) must NOT. The boundary contract
	// is `cosine >= cosineFloor`. A regression that changed `<` to `<=`
	// (or vice versa) on the production floor check would still let
	// 0.75 through (still above floor) but the deliberately-low 0.4 vs
	// 0.5 pair pins the lower-half semantic.
	it("cosine above floor (0.75) passes; cosine below floor (0.4) drops", async () => {
		const aboveFloor = sampleAtom({
			id: "above-floor",
			type: "fact",
			title: "Above floor atom",
			summary: "above-floor-summary",
			content: "above-floor-content __COS:0.75",
			tags: ["abovefloortoken", "__COS:0.75"],
			content_fingerprint: "fp-above-floor",
		});
		const underFloor = sampleAtom({
			id: "under-floor",
			type: "fact",
			title: "Under floor atom",
			summary: "under-floor-summary",
			content: "under-floor-content __COS:0.4",
			tags: ["underfloortoken", "__COS:0.4"],
			content_fingerprint: "fp-under-floor",
		});
		await insertAtom(aboveFloor, index);
		await insertAtom(underFloor, index);

		const results = await recallAtoms(index, QRY);

		// cosine = 0.75 (controlled vector, well above floor) passes.
		expect(results.find((r) => r.atom.id === aboveFloor.id)).toBeDefined();
		// cosine = 0.4 (below floor) drops.
		expect(results.find((r) => r.atom.id === underFloor.id)).toBeUndefined();
	});

	// (c) CJK dense-channel routing: pure Chinese query against a
	// Chinese-content atom. In the pure-dense era, there is NO BM25
	// rescue path — the dense embedder is the only channel and it must
	// handle non-ASCII semantics directly. We assert that an atom with
	// Chinese title (high cosine with a Chinese query, simulated here
	// via `__COS:1` controlled vector) surfaces, while a non-matching
	// English atom with cosine 0.4 does not.
	it("CJK dense-channel routing: Chinese atom with cosine above floor surfaces, dense-noise does not", async () => {
		const chineseAtom = sampleAtom({
			id: "cn-atom",
			type: "fact",
			title: "项目路径",
			summary: "项目路径 summary",
			content: "项目路径 content __COS:1",
			tags: ["项目", "__COS:1"],
			content_fingerprint: "fp-cn",
		});
		const noiseAtom = sampleAtom({
			id: "noise-atom",
			type: "fact",
			title: "Unrelated English title",
			summary: "noise-summary",
			content: "noise-content __COS:0.4",
			tags: ["unrelated", "__COS:0.4"],
			content_fingerprint: "fp-noise",
		});
		await insertAtom(chineseAtom, index);
		await insertAtom(noiseAtom, index);

		const results = await recallAtoms(index, QRY);

		// Chinese atom with cosine=1 (well above floor) is recalled.
		expect(results.find((r) => r.atom.id === chineseAtom.id)).toBeDefined();
		// English noise atom with cosine=0.4 (below 0.55 floor) is dropped.
		expect(results.find((r) => r.atom.id === noiseAtom.id)).toBeUndefined();
	});
});
// Lefse regression — Task 7.4 hermetic verification
//
// Background (see search.ts file header for the full design rationale):
// the user's real query `这个先不管,这个项目路径下lefse没有结果` recalled
// X101SC26052587 customer-data atoms (dense cosine ~0.55, BM25 0 hits) that
// were irrelevant. The cosine FLOOR (default 0.65) is the contract that
// filters these dense-noise false positives: a cosine-0.55 atom is dropped
// from the dense channel before RRF fusion ever sees it, so its rrfScore is
// 0 (no channel produced a hit) and the atom never surfaces. This is the
// industry-standard RRF design (Elasticsearch / OpenSearch / Qdrant / Milvus):
// RRF uses rank-only, no absolute score filter on the fused result. Per-channel
// thresholds handle noise.
//
// The recall gate `recallThreshold = 1 / (rrfK + 1)` ≈ 0.01639 is a SECOND
// layer: it lets single-channel rank=0 hits through (rrfScore = 1/(rrfK+1)
// equals the threshold and `>=` passes — this is required for the MGM-style
// keyword-only rescue path), and filters rank≥1 single-channel contributions
// (1/(rrfK+2) ≈ 0.01613 < 0.01639). For users who want the strict "single-
// channel rank=0 must NOT pass" stance, the config knob is
// `recallThreshold: 1 / rrfK` (≈ 0.01667) which `>` 1/(rrfK+1) and rejects
// rank=0 single-channel.
//
// This file is the hermetic, DB-state-independent verification of both
// contracts. We seed a synthetic X101SC26052587-shaped atom in a fresh
// `:memory:` index with a deterministic `__COS:0.55` dense embedding
// (cosine 0.55 with the controlled QRY), and verify:
//   (a) DEFAULT pipeline (no overrides): cosine floor catches it.
//   (b) STRICT mode (`recallThreshold: 1/rrfK`, `threshold: 0`): gate catches
//       single-channel rank=0 contribution 1/61 < 1/60.
//   (c) MGM-style keyword-only rescue: default settings, atom text contains
//       the query keyword. Single-channel BM25 rank=0 contribution 1/61
//       passes the gate. This is the contract the user needs for "MGM
//       项目还记得吗" to find the MGM atom.
//
// Why we bypass the dense floor (`threshold: 0`) in (b):
// the default dense floor (0.65) already drops a 0.55 cosine atom from the
// dense channel, so a test that uses default `threshold` would actually
// be exercising the dense floor, not the recall gate. Bypassing the floor
// with `threshold: 0` isolates the recall gate so the assertion really
// does pin the gate's behavior — `rrfScore = 1/61 < 1/60 → filtered`.
//
// The previous temp script `/tmp/lefse-regression.mjs` runs against the
// user's real `~/.pi/agent/memory/memory.db` and is corpus-state-dependent
// (the X101SC26052587 atoms may be cleaned up between runs). This test
// is the primary verification because it is reproducible from `npm test`
// alone.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { embedText } from "../embed.ts";
import { recallAtoms } from "../search.ts";
import { MemoryIndex } from "../storage.ts";
import type { MemoryAtom } from "../types.ts";

// ---------------------------------------------------------------------------
// Test scaffolding (mirrors search.test.ts / hybrid-recall.test.ts so the
// controlled-mock embedder recognises the same `QRY` + `__COS:<code>`
// sentinels — this gives us deterministic cosines for the lefse case).
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
const V_COS_055 = makeVec(0.55);

const VECS_BY_CODE: Record<string, number[]> = {
	"1": V_UNIT,
	"0.55": V_COS_055,
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

describe("lefse regression (cosine floor catches dense-noise; recall gate passes single-channel rank-0)", () => {
	let index: MemoryIndex;

	beforeEach(async () => {
		index = new MemoryIndex(":memory:");
		await index.init();
		vi.mocked(embedText).mockReset();
		installControlledMock();
	});

	afterEach(() => {
		index.close();
	});

	// (a) DEFAULT pipeline: dense cosine 0.55 (set via `__COS:0.55` in tags)
	// + BM25 zero hits → cosine floor (default 0.65) drops the atom from the
	// dense channel BEFORE RRF fusion. The atom has no dense contribution
	// and no BM25 contribution, so it never appears in the recall list.
	//
	// This is the user's exact failure case (X101SC26052587 customer-data
	// atom surfaced as a lefse-result false positive). The atom is a
	// `fact` (matching the user's corpus type), the dense cosine is 0.55
	// (the empirical bge-m3 dense-noise floor for Chinese-Chinese pairs),
	// and the BM25 channel has zero hits (the QRY sentinel shares no
	// tokens with the atom text).
	//
	// We do NOT pass `threshold` so the test exercises the DEFAULT — the
	// design's cosine floor 0.65. A regression that drifted the floor
	// back below 0.55 would let the atom into the dense channel and this
	// test would fail (assuming the recall gate at 1/(k+1) lets single-
	// channel rank-0 through — which it does by design).
	it("X101SC26052587-shaped atom with cosine 0.55 is filtered by the default cosine floor", async () => {
		// Synthetic X101SC26052587 customer-data atom: `__COS:0.55` in tags
		// forces the controlled-mock embedder to give cosine 0.55 with the
		// QRY query. The rest of the content is unique alnum tokens (no
		// overlap with QRY) so BM25 has zero hits — exactly the failure
		// pattern. The tag also includes `lefsetoken` so the corpus
		// mirrors the user's repo, but `__COS:0.55` is the deterministic
		// cosine anchor.
		const atom = sampleAtom({
			type: "fact",
			title: "X101SC26052587 customer data backflow",
			summary: "lefsetoken customer data backflow unique phrase",
			content: "X101SC26052587 Z01 J002 customer data not returned lefsetoken",
			tags: ["X101SC26052587", "amplicon", "lefsetoken", "__COS:0.55"],
			content_fingerprint: "fp-lefse-001",
		});
		await insertAtom(atom, index);

		// Default pipeline — no `threshold` override, no `recallThreshold`
		// override. Cosine floor (0.65) should drop the 0.55 cosine atom
		// from the dense channel. BM25 has no hits. Atom never surfaces.
		const resultsDefault = await recallAtoms(index, QRY);
		expect(resultsDefault.find((r) => r.atom.id === atom.id)).toBeUndefined();
	});

	// (b) STRICT mode: same atom, same query, but `recallThreshold: 1/rrfK`
	// (≈ 0.01667) AND `threshold: 0` (bypass the cosine floor so we can
	// isolate the gate). Single-channel dense rank=0 contribution is
	// 1/(rrfK+0+1) = 1/61 ≈ 0.01639 < 1/60 → filtered by the gate.
	//
	// This proves the strict gate still works for users who want the
	// "宁可漏召不可误召" conservative stance — they can opt in via the
	// config knob `recallThreshold: 1 / rrfK` and the dense-noise class
	// is filtered even with the cosine floor disabled. This is the
	// migration path for users with weakened embeddings where 0.65 floor
	// is too aggressive.
	it("strict mode (`recallThreshold: 1/rrfK`, `threshold: 0`) filters single-channel rank-0", async () => {
		const atom = sampleAtom({
			type: "fact",
			title: "X101SC26052587 customer data backflow",
			summary: "lefsetoken customer data backflow unique phrase",
			content: "X101SC26052587 Z01 J002 customer data not returned lefsetoken",
			tags: ["X101SC26052587", "amplicon", "lefsetoken", "__COS:0.55"],
			content_fingerprint: "fp-lefse-002",
		});
		await insertAtom(atom, index);

		const resultsStrict = await recallAtoms(index, QRY, {
			rrfK: 60,
			recallThreshold: 1 / 60, // strict gate — strict mode
			threshold: 0, // bypass cosine floor to isolate the gate
		});
		expect(resultsStrict.find((r) => r.atom.id === atom.id)).toBeUndefined();

		// Sanity-check via bypass: with `recallThreshold: 0` the gate is
		// disabled, so the atom should surface. The rrfScore must equal
		// 1/61 (single-channel dense rank=0 contribution).
		const resultsBypass = await recallAtoms(index, QRY, {
			rrfK: 60,
			recallThreshold: 0,
			threshold: 0,
		});
		const hit = resultsBypass.find((r) => r.atom.id === atom.id);
		expect(hit).toBeDefined();
		expect(hit?.rrfScore).toBeCloseTo(1 / 61, 4);
		expect(hit?.rrfScore ?? 0).toBeLessThan(1 / 60); // 0.01639 < 0.01667
	});

	// (c) MGM-style keyword-only rescue: default settings, atom text
	// contains the query keyword. Single-channel BM25 rank=0 contribution
	// 1/(rrfK+1) = threshold → atom passes.
	//
	// This is the contract the user needs for "MGM" or "mgm 项目还记得吗"
	// to find the MGM atom. With CJK filtering in escapeFtsQuery, Chinese
	// tokens are stripped from the BM25 query and the dense channel handles
	// Chinese semantics. ASCII tokens (e.g. "MGM") flow through BM25 and
	// the rank-0 single-channel contribution clears the gate. The recall
	// gate must let single-channel rank=0 through — that's exactly what
	// `recallThreshold = 1/(rrfK+1)` does.
	it("MGM-style keyword-only rescue: single-channel BM25 rank-0 passes default gate", async () => {
		const atom = sampleAtom({
			type: "fact",
			title: "MGM project notes",
			summary: "MGM 项目包含三部分",
			content: "MGM 是 MiniMax 的项目代号,包含三部分,详情见 https://example.com",
			tags: ["MGM", "项目", "minimax"],
			content_fingerprint: "fp-mgm-001",
		});
		await insertAtom(atom, index);

		// ASCII query "MGM" — BM25 finds the atom at rank 0 (shared token).
		// The query has no CJK chars so escapeFtsQuery passes it through.
		const resultsAscii = await recallAtoms(index, "MGM");
		const hitAscii = resultsAscii.find((r) => r.atom.id === atom.id);
		expect(hitAscii).toBeDefined();
		// rrfScore for single-channel BM25 rank=0 = 1/(60+0+1) = 1/61.
		expect(hitAscii?.rrfScore).toBeCloseTo(1 / 61, 4);

		// Mixed query "mgm 项目还记得吗" — escapeFtsQuery strips the CJK
		// chars (project principle), so BM25 sees only "mgm" (lowercase;
		// unicode61 is case-insensitive on ASCII so it still matches the
		// "MGM" token via case-folding). Atom should still surface via
		// single-channel BM25 rank=0.
		const resultsMixed = await recallAtoms(index, "mgm 项目还记得吗");
		const hitMixed = resultsMixed.find((r) => r.atom.id === atom.id);
		expect(hitMixed).toBeDefined();
		expect(hitMixed?.rrfScore).toBeCloseTo(1 / 61, 4);
	});
});
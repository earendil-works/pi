// Lefse regression — Task 7.4 hermetic verification
//
// Background (see search.ts file header for the full design rationale):
// the user's real query `这个先不管,这个项目路径下lefse没有结果` recalled
// X101SC26052587 customer-data atoms (dense cosine ~0.55, BM25 0 hits) that
// were irrelevant. The strict `recallThreshold = 1/rrfK = 0.01667` gate is
// the contract that filters single-channel rank=0 contributions out: their
// dense rank=0 contribution is `1/(rrfK+0+1) = 1/61 ≈ 0.01639` which is
// strictly below `1/rrfK = 1/60 ≈ 0.01667`.
//
// This file is the hermetic, DB-state-independent verification of that
// contract. We seed a synthetic X101SC26052587-shaped atom in a fresh
// `:memory:` index, give it a deterministic `__COS:0.55` dense embedding
// (cosine 0.55 with the controlled QRY), and verify the strict gate
// filters it while the bypass mode (`recallThreshold: 0`) surfaces it —
// proving the gate is what filters, not the channel logic.
//
// Why we bypass the dense floor (`threshold: 0`) in both tests:
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

describe("lefse regression (strict 1/60 recall gate filters single-channel rank-0 contributions)", () => {
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

	// (a) Strict default gate: dense cosine 0.55 (forced into the dense
	// channel via `threshold: 0` to isolate the gate from the dense
	// floor) + BM25 zero hits → rrfScore = 1/61 ≈ 0.01639 < 0.01667
	// → atom filtered.
	//
	// This is the user's exact failure case (X101SC26052587 customer-data
	// atom surfaced as a lefse-result false positive). The atom is a
	// `fact` (matching the user's corpus type), the dense cosine is 0.55
	// (the empirical bge-m3 dense-noise floor for Chinese-Chinese pairs),
	// and the BM25 channel has zero hits (the QRY sentinel shares no
	// tokens with the atom text).
	//
	// We pass `threshold: 0` to bypass the dense floor so the recall gate
	// is the actual filter being exercised. Without this, the floor
	// (0.65) would drop the 0.55 cosine atom from the dense channel
	// before the gate saw it — and the test would silently pass without
	// proving anything about the gate.
	it("X101SC26052587-shaped atom with cosine 0.55 is filtered under strict 1/60 gate", async () => {
		// Synthetic X101SC26052587 customer-data atom: `__COS:0.55` gives
		// dense cosine 0.55 with the QRY query (controlled mock). Tags
		// include the project ID verbatim to mirror the user's corpus; the
		// rest of the content is a unique alnum token (no overlap with QRY)
		// so BM25 has zero hits — exactly the failure pattern.
		const atom = sampleAtom({
			type: "fact",
			title: "X101SC26052587 customer data backflow",
			summary: "lefsetoken customer data backflow unique phrase",
			content: "X101SC26052587 Z01 J002 customer data not returned lefsetoken",
			tags: ["X101SC26052587", "amplicon", "lefsetoken"],
			content_fingerprint: "fp-lefse-001",
		});
		await insertAtom(atom, index);

		// We deliberately do NOT pass `recallThreshold` so the test exercises
		// the DEFAULT — the design's strict `1/rrfK` value. A regression
		// that drifted the default back to the legacy `1/(rrfK+1)` would let
		// the 1/61 rank-0 contribution through and this test would fail.
		// We also pass `threshold: 0` to bypass the dense floor so the
		// recall gate is the actual filter being exercised: rrfScore =
		// 1/(60+0+1) = 1/61 ≈ 0.01639 < 1/60.
		const resultsStrict = await recallAtoms(index, QRY, {
			rrfK: 60,
			threshold: 0,
		});
		expect(resultsStrict.find((r) => r.atom.id === atom.id)).toBeUndefined();
	});

	// (b) Bypass mode: same atom, same query, but `recallThreshold: 0`
	// disables the gate. The atom must surface — proving the gate is what
	// filters in (a), not the dense floor (bypassed here too) or the
	// BM25 channel (zero hits).
	it("same atom surfaces under recallThreshold: 0 (proves the gate, not the channel, is what filters)", async () => {
		const atom = sampleAtom({
			type: "fact",
			title: "X101SC26052587 customer data backflow",
			summary: "lefsetoken customer data backflow unique phrase",
			content: "X101SC26052587 Z01 J002 customer data not returned lefsetoken",
			tags: ["X101SC26052587", "amplicon", "lefsetoken"],
			content_fingerprint: "fp-lefse-002",
		});
		await insertAtom(atom, index);

		const resultsBypass = await recallAtoms(index, QRY, {
			rrfK: 60,
			recallThreshold: 0,
			threshold: 0,
		});
		expect(resultsBypass.find((r) => r.atom.id === atom.id)).toBeDefined();

		// rrfScore for the rank-0 dense-only contribution is 1/(60+0+1) =
		// 1/61 ≈ 0.01639. We assert it is below 1/60 so the strict gate
		// from (a) is verified to be the filter — the math is consistent
		// with the design contract (1/61 < 1/60 → filtered by the gate).
		const hit = resultsBypass.find((r) => r.atom.id === atom.id);
		expect(hit?.rrfScore).toBeCloseTo(1 / 61, 4);
		expect(hit?.rrfScore ?? 0).toBeLessThan(1 / 60); // 0.01639 < 0.01667
	});
});

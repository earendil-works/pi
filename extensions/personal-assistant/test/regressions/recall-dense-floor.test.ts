// Regression test: Chinese-query no-false-positive
//
// Delta Spec scenario: a Chinese-language query that mixes CJK with
// technical terms (e.g. "然后制做成为novo skill") must recall atoms that
// match the technical intent (e.g. "novo skill 创建方法") and NOT pull in
// unrelated Chinese atoms whose dense cosine lands in the noise band
// (0.55 — the empirical bge-m3 dense-noise floor).
//
// Before the pure-dense migration, the legacy hybrid pipeline could leak
// BM25 keyword matches from unrelated Chinese atoms through the dense
// floor (single-channel BM25 rank-0 contribution 1/(rrfK+1) cleared the
// recall gate). In the pure-dense era, the ONLY relevance gate is the
// cosine floor (0.7). Atoms with cosine < 0.7 must NOT surface regardless
// of any string overlap.
//
// This test pins the contract: a 0.75-cosine atom surfaces; a 0.55-cosine
// atom with overlapping Chinese tokens is dropped.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { embedText } from "../../embed.ts";
import { recallAtoms } from "../../search.ts";
import { MemoryIndex } from "../../storage.ts";
import type { MemoryAtom } from "../../types.ts";

// ---------------------------------------------------------------------------
// Test scaffolding (mirrors search.test.ts controlled-mock pattern)
// ---------------------------------------------------------------------------

const DIM = 1024;

const makeVec = (dominant: number): number[] => {
	const arr = new Array(DIM).fill(0);
	arr[0] = dominant;
	arr[1] = Math.sqrt(Math.max(0, 1 - dominant * dominant));
	return arr;
};

const V_UNIT = makeVec(1.0);
const V_COS_075 = makeVec(0.75);
const V_COS_055 = makeVec(0.55);

// Sentinels recognised by the controlled embedText mock. The atom's
// content includes a `__COS:<code>` token that the mock detects; the
// query is the literal `__QUERY__` string.
const QRY = "__QUERY__";
const COS_RE = /__COS:([0-9.]+)/;

vi.mock("../../embed.ts", async () => {
	const actual = await vi.importActual<typeof import("../../embed.ts")>("../../embed.ts");
	return {
		...actual,
		embedText: vi.fn(async (text: string) => {
// Default char-bag fallback; tests install the controlled
		// mock via installControlledMock() for precise cosines.
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

const VECS_BY_CODE: Record<string, number[]> = {
	"1": V_UNIT,
	"0.75": V_COS_075,
	"0.55": V_COS_055,
};

const installControlledMock = (): void => {
	vi.mocked(embedText).mockImplementation(async (text: string) => {
		if (text === QRY) return V_UNIT;
		const m = text.match(COS_RE);
		if (m) {
			const v = VECS_BY_CODE[m[1]];
			if (v) return v;
		}
		// Fallback: char-bag so non-mocked inputs (e.g. tag embeddings)
		// don't crash — they just won't surface.
		const arr = new Array(DIM).fill(0);
		for (let i = 0; i < text.length; i++) {
			arr[text.charCodeAt(i) % DIM] += 1;
		}
		const norm = Math.sqrt(arr.reduce((s, v) => s + v * v, 0));
		if (norm > 0) for (let i = 0; i < arr.length; i++) arr[i] /= norm;
		return arr;
	});
};

// ---------------------------------------------------------------------------
// Atom factory — must support a 1-year-old created_at so the score-formula
// freshness term (`0.05 × exp(-daysSinceUpdate/30)`) is negligible. The
// multiplicative score formula `cosine × (1 + 0.3 × strength + 0.2 ×
// importance)` plus additive terms is what determines recall ranking.
// ---------------------------------------------------------------------------

const sampleAtom = (overrides: Partial<MemoryAtom> = {}): MemoryAtom => ({
	id: crypto.randomUUID(),
	type: "rule",
	title: "Sample",
	content: "Sample content",
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
	created_at: Date.now() - 365 * 24 * 60 * 60 * 1000,
	updated_at: Date.now() - 365 * 24 * 60 * 60 * 1000,
	last_access: null,
	content_fingerprint: `fp-${Math.random().toString(36).slice(2, 18)}`,
	source_session: null,
	...overrides,
});

const insertAtom = async (atom: MemoryAtom, index: MemoryIndex): Promise<void> => {
	const text = `${atom.title}\n\n${atom.summary}\n\n${atom.content}\n\n${atom.tags.join(" ")}`;
	const emb = await embedText(text);
	if (!emb) throw new Error("controlled mock returned null");
	await index.insertAtom(atom, emb);
};

// ---------------------------------------------------------------------------
// Test
// ---------------------------------------------------------------------------

describe("Chinese query no-false-positive (pure-dense cosine floor)", () => {
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

	it("recalls the matching atom (cosine 0.75, above floor) and drops the noise atom (cosine 0.55, below floor)", async () => {
		// Atom A: the atom the user actually wants. Chinese title about
		// "novo skill 创建方法"; embedding controlled to cosine 0.75 with
		// the query — above the 0.7 floor.
		const matchingAtom = sampleAtom({
			id: "novo-skill-method",
			type: "fact",
			title: "novo skill 创建方法",
			summary: "novo skill 创建方法 summary __COS:0.75",
			content: "novo skill 创建方法 详细步骤 __COS:0.75",
			tags: ["novo", "skill", "__COS:0.75"],
			content_fingerprint: "fp-novo-skill",
		});

		// Atom B: an unrelated Chinese atom with overlapping CJK tokens
		// (e.g. shares the character 创 with the query) but a different
		// semantic domain. Embedding controlled to cosine 0.55 — below
		// the 0.7 floor. In the legacy hybrid era this atom could leak
		// through via single-channel BM25 keyword match; in the pure-
		// dense era the cosine floor is the only relevance gate.
		const noiseAtom = sampleAtom({
			id: "bmk-brand-replace",
			type: "fact",
			title: "BMK 报告品牌替换",
			summary: "BMK 报告品牌替换 summary __COS:0.55",
			content: "BMK 报告品牌替换 详细描述 __COS:0.55",
			tags: ["bmk", "report", "__COS:0.55"],
			content_fingerprint: "fp-bmk-brand",
		});

		await insertAtom(matchingAtom, index);
		await insertAtom(noiseAtom, index);

		// The query: a real-world mixed CJK + technical query that mixes
		// unrelated Chinese tokens with the target technical phrase.
		// We use the QRY sentinel so the controlled mock returns V_UNIT
		// (cosine 1.0 with itself, giving the deterministic cosine values
		// for A and B from their `__COS:<code>` tags). The sentinel is
		// identical to the production-side recallAtoms contract: any
		// string is a valid query; the mock just intercepts the QRY
		// sentinel for deterministic testing.
		const query = QRY;

		const results = await recallAtoms(index, query);

		// Assertion 1: the matching atom (cosine 0.75, above floor)
		// surfaces in the recall results.
		expect(results.find((r) => r.atom.id === matchingAtom.id)).toBeDefined();

		// Assertion 2: the noise atom (cosine 0.55, below floor) does NOT
		// surface. This is the no-false-positive contract — pure-dense
		// cosine floor must filter dense-noise false positives even when
		// the atoms share CJK tokens.
		expect(results.find((r) => r.atom.id === noiseAtom.id)).toBeUndefined();
	});
});
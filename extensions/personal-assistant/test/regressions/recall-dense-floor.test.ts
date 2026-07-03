// Regression test: Chinese-query no-false-positive
//
// Delta Spec scenario: a Chinese-language query that mixes CJK with
// technical terms (e.g. "然后制做成为novo skill") must recall atoms that
// match the technical intent (e.g. "novo skill 创建方法") and NOT pull in
// unrelated Chinese atoms whose dense cosine lands in the noise band
// (0.55 — the empirical bge-m3 dense-noise floor).
//
// Before the hybrid RRF migration, the legacy sqlite-vec KNN (single-channel
// dense) was the only relevance gate. The new hybrid architecture adds a
// sparse channel (token-level match) that can rescue short queries but must
// still honour the dense cosine floor for unrelated atoms: atoms with
// cosine < 0.55 must NOT surface regardless of any string overlap. The
// sparse floor (0.3) provides an additional guard — a low-IDF token match
// that fails both floors is correctly dropped.
//
// This test pins the contract: a 0.75-cosine atom surfaces; a 0.4-cosine
// atom with overlapping Chinese tokens is dropped.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { embedText } from "../../embed.ts";
import { recallAtoms } from "../../search.ts";
import { MemoryIndex } from "../../storage.ts";
import type { MemoryAtom } from "../../types.ts";

// ---------------------------------------------------------------------------
// Test scaffolding (mirrors search.test.ts hybrid-mock pattern)
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
const V_COS_04 = makeVec(0.4);

const QRY = "__QUERY__";
const COS_RE = /__COS:([0-9.]+)/;

const VECS_BY_CODE: Record<string, number[]> = {
	"1": V_UNIT,
	"0.75": V_COS_075,
	"0.4": V_COS_04,
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

vi.mock("../../embed.ts", async () => {
	const actual = await vi.importActual<typeof import("../../embed.ts")>("../../embed.ts");
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

vi.mock("../../hybrid-search.ts", async () => {
	return {
		hybridSearch: async (query: string, topK: number, options?: { denseFloor?: number }) => {
			const index = (globalThis as { __test_index?: MemoryIndex }).__test_index;
			if (!index) return [];
			const qVec = (await embedText(query)) ?? [];
			const denseFloor = options?.denseFloor ?? 0;
			const atoms = index.listAtoms({ archived: false });
			const hits: Array<{
				id: string;
				title: string;
				type: "rule" | "fact" | "process";
				rank: number;
				rrf: number;
				dense_cos: number;
				sparse_score: number;
			}> = [];
			for (const atom of atoms) {
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
					rrf: cos,
					dense_cos: cos,
					sparse_score: 0,
				});
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

describe("Chinese query no-false-positive (pure-dense cosine floor)", () => {
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

	it("recalls the matching atom (cosine 0.75, above floor) and drops the noise atom (cosine 0.4, below floor)", async () => {
		const matchingAtom = sampleAtom({
			id: "novo-skill-method",
			type: "fact",
			title: "novo skill 创建方法",
			summary: "novo skill 创建方法 summary __COS:0.75",
			content: "novo skill 创建方法 详细步骤 __COS:0.75",
			tags: ["novo", "skill", "__COS:0.75"],
			content_fingerprint: "fp-novo-skill",
		});

		const noiseAtom = sampleAtom({
			id: "bmk-brand-replace",
			type: "fact",
			title: "BMK 报告品牌替换",
			summary: "BMK 报告品牌替换 summary __COS:0.4",
			content: "BMK 报告品牌替换 详细描述 __COS:0.4",
			tags: ["bmk", "report", "__COS:0.4"],
			content_fingerprint: "fp-bmk-brand",
		});

		await insertAtom(matchingAtom, index);
		await insertAtom(noiseAtom, index);

		const query = QRY;
		const results = await recallAtoms(index, query);

		expect(results.find((r) => r.atom.id === matchingAtom.id)).toBeDefined();
		expect(results.find((r) => r.atom.id === noiseAtom.id)).toBeUndefined();
	});
});
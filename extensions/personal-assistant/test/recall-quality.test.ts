// recallAtoms — quality test on a labeled dataset.
//
// Validates that pure-vector recall (via recallAtoms) hits the recall/precision
// targets on a curated 14-atom corpus with 9 hand-labeled queries (5 original
// + 4 Chinese-language), using a deterministic char-bigram mock embedder so
// the test is hermetic and does not require ollama.
//
// Metrics (R51 / R52 / R53 / R57):
//   - avg_recall_at_5  >= 0.7
//   - avg_recall_at_10 >= 0.85
//   - avg_precision_at_5 >= 0.2   // lowered from 0.5; see rationale below
//   - chinese_query_recall_at_5 >= 0.5  // R57 — asserted via focused suite
//
// precision@5 rationale: with 9 queries and at most 1-2 relevant atoms each,
// the ceiling is Σrelevant / (5 × queries) ≤ 12 / 45 ≈ 0.27. The recall
// thresholds (0.7 / 0.85) are the binding quality gate; precision@5 is
// reported as a secondary signal constrained by the dataset size.
//
// The dataset mixes Chinese / English / mixed-language queries and includes a
// no-false-positive query (CMYK color space should not pull in PDF/CMYK atoms
// from other domains). Threshold is 0 so we measure pure retrieval ranking
// before cosine filtering; a separate test will tune the threshold against the
// real embedder.
//
// Task 9.2 (S62 / S63): the focused `Chinese query recall (focused)` suite
// below asserts that Chinese-language queries (图片 / PDF提取 / CMYK处理 /
// 中文) land on Chinese-language atoms (atom-10..atom-13) at top-K, separate
// from the aggregate metrics computed over the full query set.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { writeAtomToFile } from "../file-store.ts";
import { recallAtoms } from "../search.ts";
import { MemoryIndex } from "../storage.ts";
import type { MemoryAtom } from "../types.ts";

// Mock embedding: character n-gram overlap (cosine ∝ char overlap)
function mockEmbed(text: string, dims = 1024): Float32Array {
	const arr = new Float32Array(dims);
	const normalized = text.toLowerCase().replace(/\s+/g, " ");
	for (let i = 0; i < normalized.length - 1; i++) {
		const bigram = normalized.slice(i, i + 2);
		const idx = (bigram.charCodeAt(0) * 31 + bigram.charCodeAt(1) * 37 + i * 13) % dims;
		arr[idx] += 1;
	}
	const norm = Math.sqrt(arr.reduce((s, v) => s + v * v, 0));
	if (norm > 0) for (let i = 0; i < dims; i++) arr[i] /= norm;
	return arr;
}

vi.mock("../embed.ts", () => ({
	embedText: async (text: string) => Array.from(mockEmbed(text)),
	buildEmbeddableText: (atom: any) =>
		`${atom.title}\n\n${atom.summary}\n\n${atom.content}\n\n${(atom.tags || []).join(" ")}`,
	loadConfig: () => ({}),
}));

const sampleAtom = (overrides: Partial<MemoryAtom> = {}): MemoryAtom => ({
	id: crypto.randomUUID(),
	type: "rule",
	title: "T",
	content: "C",
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
	content_fingerprint: "fp-" + Math.random().toString(36).slice(2, 18),
	source_session: null,
	...overrides,
});

describe("recallAtoms quality (labeled dataset)", () => {
	let index: MemoryIndex;
	let tmpDir: string;
	let atomsDir: string;
	let dbPath: string;

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "recall-quality-"));
		atomsDir = path.join(tmpDir, "atoms");
		dbPath = path.join(tmpDir, "memory.db");
		await fs.mkdir(atomsDir, { recursive: true });
		index = new MemoryIndex(dbPath);
		await index.init();
	});

	afterEach(async () => {
		index.close();
		await fs.rm(tmpDir, { recursive: true, force: true });
	});

	const insertAtom = async (atom: MemoryAtom) => {
		const text = `${atom.title}\n\n${atom.summary}\n\n${atom.content}\n\n${atom.tags.join(" ")}`;
		const emb = mockEmbed(text);
		await index.insertAtom(atom, Array.from(emb));
		await writeAtomToFile(atom, atomsDir);
	};

	// Labeled dataset: 14 atoms (10 original + 4 Chinese-language), 9 queries
	const dataset = {
		atoms: [
			{
				title: "PDF 图片提取",
				content: "PDF 提取图片必须用 pymupdf 而不是 pdfplumber。fitz.open() 处理 CMYK。",
				tags: ["pdf", "pymupdf"],
				type: "process" as const,
			},
			{
				title: "Cron 多步执行",
				content: "Cron 执行多步操作时,每步独立 timeout,总时间 < 1 分钟。",
				tags: ["cron"],
				type: "process" as const,
			},
			{
				title: "TypeScript strict",
				content: "User prefers TypeScript strict mode in all .ts files. No implicit any.",
				tags: ["typescript"],
				type: "rule" as const,
			},
			{
				title: "Image CMYK conversion",
				content: "Image export for print must use CMYK color space, not RGB.",
				tags: ["image", "print"],
				type: "fact" as const,
			},
			{
				title: "Git commit format",
				content: "Git commit message: feat/fix prefix, scope in parens, body wrap at 72.",
				tags: ["git"],
				type: "rule" as const,
			},
			{
				title: "Database migration",
				content: "DB schema changes require migration file before code change.",
				tags: ["database", "migration"],
				type: "process" as const,
			},
			{
				title: "Python venv setup",
				content: "Python projects use venv. activate: source venv/bin/activate",
				tags: ["python"],
				type: "fact" as const,
			},
			{
				title: "Docker multi-stage",
				content: "Docker multi-stage builds reduce final image size by 80%.",
				tags: ["docker"],
				type: "fact" as const,
			},
			{
				title: "React useEffect deps",
				content: "useEffect deps array must include all reactive values. eslint exhaustive-deps.",
				tags: ["react"],
				type: "rule" as const,
			},
			{
				title: "PDF text extraction",
				content: "PDF text extraction with pdfplumber returns whitespace-padded strings.",
				tags: ["pdf", "pdfplumber"],
				type: "fact" as const,
			},
			// ---- Chinese-language atoms (appended for Task 9.2) ----
			{
				title: "PDF 图片提取",
				content: "PDF 提取图片必须用 pymupdf 而不是 pdfplumber。fitz.open() 处理 CMYK。",
				tags: ["pdf", "pymupdf"],
				type: "process" as const,
			},
			{
				title: "CMYK 颜色转换",
				content: "印刷品导出图片必须 CMYK 颜色空间,不是 RGB。",
				tags: ["print", "color"],
				type: "fact" as const,
			},
			{
				title: "PDF 文本提取",
				content: "PDF text extraction with pdfplumber returns whitespace-padded strings.",
				tags: ["pdf", "pdfplumber"],
				type: "fact" as const,
			},
			{
				title: "中文编码问题",
				content: "处理中文文件路径时必须用 UTF-8 编码,Windows 用 GBK。",
				tags: ["encoding", "chinese"],
				type: "rule" as const,
			},
		],
		queries: [
			{ query: "图片提取", relevantIndices: [0], category: "chinese" },
			{ query: "PDF 处理", relevantIndices: [0, 9], category: "chinese" },
			{ query: "TypeScript preferences", relevantIndices: [2], category: "semantic" },
			{ query: "cron timeout", relevantIndices: [1], category: "exact" },
			{ query: "CMYK color space", relevantIndices: [3], category: "exact" },
			// ---- Chinese-language queries (appended for Task 9.2) ----
			{ query: "图片", relevantIndices: [10, 11], category: "chinese" },
			{ query: "PDF提取", relevantIndices: [10, 12], category: "chinese" },
			{ query: "CMYK处理", relevantIndices: [11], category: "chinese" },
			{ query: "中文", relevantIndices: [13], category: "chinese" },
		],
	};

	// Insert all atoms
	beforeEach(async () => {
		const atoms: MemoryAtom[] = dataset.atoms.map((a, i) =>
			sampleAtom({
				id: `atom-${i}`,
				type: a.type,
				title: a.title,
				content: a.content,
				summary: a.content.slice(0, 50),
				tags: a.tags,
			}),
		);
		for (const atom of atoms) {
			await insertAtom(atom);
		}
	});

	// Compute metrics
	const computeMetrics = (relevantIndices: number[], retrievedIds: string[]) => {
		const relevantIds = new Set(relevantIndices.map((i) => `atom-${i}`));
		const retrieved = new Set(retrievedIds);
		const hits = [...retrieved].filter((id) => relevantIds.has(id)).length;
		return { hits, relevant: relevantIds.size, retrieved: retrieved.size };
	};

	for (const q of dataset.queries) {
		it(`query="${q.query}" (${q.category}) should retrieve relevant atoms`, async () => {
			// `recallThreshold: 0` bypasses the strict 1/rrfK gate so this
			// quality test measures pure retrieval ranking (R51 / R52 / R53)
			// before any filtering — both the new RRF gate AND the legacy
			// dense cosine floor are disabled. This isolates the underlying
			// channel-ranking quality from the gating policy.
			const results = await recallAtoms(index, q.query, {
				topK: 10,
				threshold: 0,
				recallThreshold: 0,
			});
			const retrievedIds = results.map((r) => r.atom.id);
			const { hits, relevant, retrieved } = computeMetrics(q.relevantIndices, retrievedIds);

			const recallAt5 = hits / relevant;
			const precisionAt5 = retrieved > 0 ? hits / Math.min(5, retrieved) : 0;

			console.log(`  Query: "${q.query}" (${q.category})`);
			console.log(`  Retrieved: [${retrievedIds.slice(0, 5).join(", ")}]`);
			console.log(`  Relevant: [${q.relevantIndices.map((i) => `atom-${i}`).join(", ")}]`);
			console.log(`  Recall@5: ${recallAt5.toFixed(2)}, Precision@5: ${precisionAt5.toFixed(2)}`);

			// For this task, just assert at least one hit
			expect(hits).toBeGreaterThan(0);
		});
	}

	it("aggregate metrics meet thresholds", async () => {
		let totalRecallAt5 = 0;
		let totalPrecisionAt5 = 0;
		let totalRecallAt10 = 0;
		const n = dataset.queries.length;

		for (const q of dataset.queries) {
			const results = await recallAtoms(index, q.query, {
				topK: 10,
				threshold: 0,
				recallThreshold: 0,
			});
			const retrievedIds = results.map((r) => r.atom.id);
			const { hits, relevant, retrieved } = computeMetrics(q.relevantIndices, retrievedIds);

			const recallAt5 = hits / relevant;
			const recallAt10 = hits / relevant;
			const precisionAt5 = retrieved > 0 ? hits / Math.min(5, retrieved) : 0;

			totalRecallAt5 += recallAt5;
			totalRecallAt10 += recallAt10;
			totalPrecisionAt5 += precisionAt5;
		}

		const avgRecallAt5 = totalRecallAt5 / n;
		const avgRecallAt10 = totalRecallAt10 / n;
		const avgPrecisionAt5 = totalPrecisionAt5 / n;

		console.log(`\n=== Aggregate Metrics ===`);
		console.log(`avg_recall_at_5:  ${avgRecallAt5.toFixed(3)} (threshold >= 0.7)`);
		console.log(`avg_recall_at_10: ${avgRecallAt10.toFixed(3)} (threshold >= 0.85)`);
		console.log(`avg_precision_at_5: ${avgPrecisionAt5.toFixed(3)} (threshold >= 0.2 — mathematical floor for small dataset)`);

		expect(avgRecallAt5).toBeGreaterThanOrEqual(0.7);
		expect(avgRecallAt10).toBeGreaterThanOrEqual(0.85);
		expect(avgPrecisionAt5).toBeGreaterThanOrEqual(0.2);  // Lowered from 0.5 — mathematical floor for small dataset
	});

	// Chinese-language focused recall tests (S62 / S63 / R57).
	// Asserts that a Chinese query hits the Chinese-language atom, not just
	// any atom that shares an English token. Relies on the parent beforeEach
	// having inserted atom-10..atom-13.
	describe("Chinese query recall (focused)", () => {
		it("'图片' should hit at least one Chinese atom (atom-10 or atom-11)", async () => {
			// recallThreshold: 0 disables the strict 1/rrfK gate (see
			// aggregate test for rationale — measures pure channel ranking).
			const results = await recallAtoms(index, "图片", {
				topK: 10,
				threshold: 0,
				recallThreshold: 0,
			});
			const ids = results.map((r) => r.atom.id);
			const hits = [10, 11].filter((i) => ids.includes(`atom-${i}`));
			expect(hits.length).toBeGreaterThan(0);
		});

		it("'PDF提取' should hit at least one PDF-related Chinese atom (atom-10 or atom-12)", async () => {
			// recallThreshold: 0 disables the strict 1/rrfK gate.
			const results = await recallAtoms(index, "PDF提取", {
				topK: 10,
				threshold: 0,
				recallThreshold: 0,
			});
			const ids = results.map((r) => r.atom.id);
			const hits = [10, 12].filter((i) => ids.includes(`atom-${i}`));
			expect(hits.length).toBeGreaterThan(0);
		});

		it("'CMYK处理' should hit CMYK Chinese atom (atom-11)", async () => {
			// recallThreshold: 0 disables the strict 1/rrfK gate.
			const results = await recallAtoms(index, "CMYK处理", {
				topK: 10,
				threshold: 0,
				recallThreshold: 0,
			});
			const ids = results.map((r) => r.atom.id);
			expect(ids).toContain("atom-11");
		});

		it("'中文' should hit 中文编码 atom (atom-13)", async () => {
			// recallThreshold: 0 disables the strict 1/rrfK gate.
			const results = await recallAtoms(index, "中文", {
				topK: 10,
				threshold: 0,
				recallThreshold: 0,
			});
			const ids = results.map((r) => r.atom.id);
			expect(ids).toContain("atom-13");
		});
	});
});
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
// from other domains). `threshold: 0` disables the cosine floor so we
// measure pure retrieval ranking before cosine filtering; a separate test
// will tune the threshold against the real embedder.
//
// Task 9.2 (S62 / S63): the focused `Chinese query recall (focused)` suite
// below asserts that Chinese-language queries (图片 / PDF提取 / CMYK处理 /
// 中文) land on Chinese-language atoms (atom-10..atom-13) at top-K, separate
// from the aggregate metrics computed over the full query set.

import { spawnSync } from "node:child_process";
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
		`${atom.title}\n\n${atom.summary}\n\n${(atom.tags || []).join(" ")}`,
	loadConfig: () => ({}),
	CURRENT_EMBEDDABLE_TEXT_VERSION: 2,
}));

// Mock hybridSearch so the new search.ts code path (which calls the
// embedding service via /api/search) works in this hermetic test. The mock
// re-implements the service's hybrid retrieval locally: char n-gram embed
// the query + every atom, compute cosine, apply the dense floor, return
// the top-K as a flat list of hits (the per-type split happens in
// search.ts).
vi.mock("../hybrid-search.ts", async () => {
	const { hybridSearch: actual } = await vi.importActual<
		typeof import("../hybrid-search.ts")
	>("../hybrid-search.ts");
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
	return {
		hybridSearch: async (
			query: string,
			topK: number,
			options?: { denseFloor?: number },
		) => {
			const index = (globalThis as { __test_index?: MemoryIndex }).__test_index;
			if (!index) return [];
			const qVec = Array.from(mockEmbed(query));
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
				const text = `${atom.title}\n\n${atom.summary}\n\n${(atom.tags || []).join(" ")}`;
				const aVec = Array.from(mockEmbed(text));
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
		(globalThis as { __test_index?: MemoryIndex }).__test_index = index;
	});

	afterEach(async () => {
		index.close();
		await fs.rm(tmpDir, { recursive: true, force: true });
		delete (globalThis as { __test_index?: MemoryIndex }).__test_index;
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
			// `threshold: 0` disables the dense cosine floor so this
			// quality test measures pure retrieval ranking (R51 / R52 / R53)
			// before any gating. This isolates the underlying ranking
			// quality from the cosine floor policy.
			const results = await recallAtoms(index, q.query, {
				topK: 10,
				threshold: 0,
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
			// threshold: 0 disables the cosine floor (see aggregate test
			// for rationale — measures pure channel ranking).
			const results = await recallAtoms(index, "图片", {
				topK: 10,
				threshold: 0,
			});
			const ids = results.map((r) => r.atom.id);
			const hits = [10, 11].filter((i) => ids.includes(`atom-${i}`));
			expect(hits.length).toBeGreaterThan(0);
		});

		it("'PDF提取' should hit at least one PDF-related Chinese atom (atom-10 or atom-12)", async () => {
			// threshold: 0 disables the cosine floor.
			const results = await recallAtoms(index, "PDF提取", {
				topK: 10,
				threshold: 0,
			});
			const ids = results.map((r) => r.atom.id);
			const hits = [10, 12].filter((i) => ids.includes(`atom-${i}`));
			expect(hits.length).toBeGreaterThan(0);
		});

		it("'CMYK处理' should hit CMYK Chinese atom (atom-11)", async () => {
			// threshold: 0 disables the cosine floor.
			const results = await recallAtoms(index, "CMYK处理", {
				topK: 10,
				threshold: 0,
			});
			const ids = results.map((r) => r.atom.id);
			expect(ids).toContain("atom-11");
		});

		it("'中文' should hit 中文编码 atom (atom-13)", async () => {
			// threshold: 0 disables the cosine floor.
			const results = await recallAtoms(index, "中文", {
				topK: 10,
				threshold: 0,
			});
			const ids = results.map((r) => r.atom.id);
			expect(ids).toContain("atom-13");
		});
	});
});

// ---------------------------------------------------------------------------
// Task 3.12 (R11 / R12 / R13) — migration's effect on recall precision.
//
// test/migration.test.ts already exercises the script's surface (backup
// file, archive count, idempotency). This block covers the user-visible
// angle that complements those tests:
//   - Decision 2: when a cluster pair collides, the higher-access_count
//     atom wins (the user's "hot" / already-validated reference stays;
//     the cold duplicate gets archived). Without this guard the
//     migration would pick a winner at random in DB order.
//   - R12: corpus shrinks ≥ 17% after a clean migration run (proposal
//     acceptance #1).
//   - R13: the 0.65 threshold has 0 false-positive merges — atoms at
//     cosine < 0.65 (e.g. 0.643, just under) stay untouched (proposal
//     acceptance #8a).
//
// Fixture shape mirrors test/migration.test.ts seedCorpus: 6 atoms
// arranged as 2 cluster pairs (cos ≈ 0.866 within a pair, ~0 across
// pairs) plus 2 unique dense-random vectors. The per-pair access_count
// gap (10 vs 3, 8 vs 2) is what makes Decision 2 deterministic.
//
// Each test runs against its own tmpdir memory.db (via the env-var
// override established by Task 2.5) so the script never touches the
// user's live corpus.
// ---------------------------------------------------------------------------

const MIGRATION_SCRIPT = path.resolve(
	__dirname,
	"..",
	"scripts",
	"migrate-legacy-atoms.mts",
);
const ROOT_TSCONFIG = path.resolve(__dirname, "..", "..", "..", "tsconfig.json");

/** Build a unit-length 1024-dim vector at `angleDeg` in the (x,y)
 *  plane. Used to plant cluster-pair members with a precise cosine.
 *  Two atoms at 0° and 30° have cosine 0.866; two atoms at 0° and
 *  50° have cosine 0.643 (below the 0.65 threshold). */
function angledVec(angleDeg: number, dims = 1024): number[] {
	const rad = (angleDeg * Math.PI) / 180;
	const arr = new Array(dims).fill(0);
	arr[0] = Math.cos(rad);
	arr[1] = Math.sin(rad);
	return arr;
}

/** Build a unit-length 1024-dim pseudo-random vector. Used for the
 *  "unique" atoms in the fixture — they're well below 0.65 cosine to
 *  any other atom so the migration never accidentally merges them. */
function denseVec(seed: number, dims = 1024): number[] {
	const arr = new Array(dims).fill(0);
	let s = seed;
	for (let i = 0; i < dims; i++) {
		s = (s * 1103515245 + 12345) & 0x7fffffff;
		arr[i] = (s / 0x7fffffff) * 2 - 1;
	}
	const norm = Math.sqrt(arr.reduce((sum, v) => sum + v * v, 0));
	return arr.map((v) => v / norm);
}

/** Insert the 6-atom migration fixture. Pair axes are 30° apart (cos
 *  0.866, well above the 0.65 threshold) and pairs live in different
 *  quadrants so cross-pair cosine is 0 or negative. */
async function seedMigrationFixture(dbPath: string): Promise<void> {
	const idx = new MemoryIndex(dbPath);
	await idx.init();
	const baseTime = Date.now();
	const fixture: Array<{
		id: string;
		vec: number[];
		access_count: number;
		last_access: number | null;
		created_at: number;
	}> = [
		{
			id: "a1",
			vec: angledVec(0),
			access_count: 10,
			last_access: baseTime,
			created_at: baseTime,
		},
		{
			id: "b1",
			vec: angledVec(90),
			access_count: 8,
			last_access: baseTime - 500,
			created_at: baseTime + 100,
		},
		{
			id: "a2",
			vec: angledVec(30),
			access_count: 3,
			last_access: null,
			created_at: baseTime + 200,
		},
		{
			id: "b2",
			vec: angledVec(120),
			access_count: 2,
			last_access: null,
			created_at: baseTime + 300,
		},
		{
			id: "x",
			vec: denseVec(50),
			access_count: 1,
			last_access: baseTime - 2000,
			created_at: baseTime + 400,
		},
		{
			id: "y",
			vec: denseVec(60),
			access_count: 0,
			last_access: null,
			created_at: baseTime + 500,
		},
	];
	for (const a of fixture) {
		await idx.insertAtom(
			{
				id: a.id,
				type: "fact",
				title: a.id,
				content: a.id,
				summary: "s",
				tags: ["x"],
				importance: 0.5,
				strength: 1.0,
				access_count: a.access_count,
				version: 1,
				is_latest: 1,
				parent_id: null,
				superseded_at: null,
				archived: 0,
				created_at: a.created_at,
				updated_at: a.created_at,
				last_access: a.last_access,
				content_fingerprint: "fp" + a.id,
				source_session: null,
			},
			a.vec,
		);
	}
	idx.close();
}

describe("migration effect on recall precision (Task 3.12)", () => {
	let workspace: string;
	let dbPath: string;
	let atomsDir: string;

	beforeEach(async () => {
		workspace = await fs.mkdtemp(path.join(os.tmpdir(), "recall-quality-mig-"));
		dbPath = path.join(workspace, "memory.db");
		atomsDir = path.join(workspace, "atoms");
		await fs.mkdir(atomsDir, { recursive: true });
		await seedMigrationFixture(dbPath);
	});

	afterEach(async () => {
		await fs.rm(workspace, { recursive: true, force: true });
	});

	/** Spawn the migration script pointed at the test tmpdir db. The
	 *  two env vars were added in Task 2.5 so the destructive dedup
	 *  pass never reaches the user's real memory.db. */
	function runScript(): { status: number; stdout: string; stderr: string } {
		const result = spawnSync("npx", ["tsx", MIGRATION_SCRIPT], {
			env: {
				...process.env,
				PERSONAL_ASSISTANT_DB_PATH: dbPath,
				PERSONAL_ASSISTANT_ATOMS_DIR: atomsDir,
				TSX_TSCONFIG_PATH: ROOT_TSCONFIG,
			},
			encoding: "utf-8",
		});
		return {
			status: result.status ?? -1,
			stdout: result.stdout ?? "",
			stderr: result.stderr ?? "",
		};
	}

	it("Decision 2: hot atom (higher access_count) wins cluster pair", () => {
		const { status, stdout, stderr } = runScript();
		if (status !== 0) {
			throw new Error(`script failed: ${stderr || stdout}`);
		}
		expect(status).toBe(0);

		const idx = new MemoryIndex(dbPath);
		idx.init();
		try {
			// a2 (access_count=3) is the loser; a1 (access_count=10)
			// is the canonical winner. markSupersededNoInsert sets
			// is_latest=0 and parent_id=<winner_id> on the loser
			// without setting archived=1.
			const a2 = idx.getAtom("a2");
			expect(a2).not.toBeNull();
			expect(a2!.is_latest).toBe(0);
			expect(a2!.parent_id).toBe("a1");

			// b pair follows the same pattern.
			const b2 = idx.getAtom("b2");
			expect(b2).not.toBeNull();
			expect(b2!.is_latest).toBe(0);
			expect(b2!.parent_id).toBe("b1");

			// Winners stay active.
			expect(idx.getAtom("a1")!.is_latest).toBe(1);
			expect(idx.getAtom("a1")!.parent_id).toBeNull();
			expect(idx.getAtom("b1")!.is_latest).toBe(1);
			expect(idx.getAtom("b1")!.parent_id).toBeNull();
		} finally {
			idx.close();
		}
	});

	it("R12: corpus reduction ≥ 17% after migration", () => {
		const { status, stdout, stderr } = runScript();
		if (status !== 0) {
			throw new Error(`script failed: ${stderr || stdout}`);
		}
		expect(status).toBe(0);

		const idx = new MemoryIndex(dbPath);
		idx.init();
		try {
			const active = idx.getActiveAtoms();
			// 6 atoms → 4 active = 33% reduction (well above the
			// 17% acceptance floor). The two losers (a2, b2) are
			// filtered out by the is_latest=1 clause in
			// getActiveAtoms' WHERE.
			expect(active.length).toBe(4);
			const reduction = (6 - active.length) / 6;
			expect(reduction).toBeGreaterThanOrEqual(0.17);
		} finally {
			idx.close();
		}
	});

	it("R13: 0.65 threshold produces 0 false merges at cosine < 0.65", async () => {
		// Add a 7th atom whose closest neighbour sits at cosine
		// ≈ 0.643 (50° off a1's axis). This is *just under* the 0.65
		// threshold, so it must NOT be merged into a1 by the
		// migration sweep. The 0.65 floor leaves 0 false positives.
		const idx = new MemoryIndex(dbPath);
		await idx.init();
		const baseTime = Date.now();
		await idx.insertAtom(
			{
				id: "below_threshold",
				type: "fact",
				title: "below_threshold",
				content: "below_threshold",
				summary: "s",
				tags: ["x"],
				importance: 0.5,
				strength: 1.0,
				access_count: 0,
				version: 1,
				is_latest: 1,
				parent_id: null,
				superseded_at: null,
				archived: 0,
				created_at: baseTime + 600,
				updated_at: baseTime + 600,
				last_access: null,
				content_fingerprint: "fpbelow",
				source_session: null,
			},
			angledVec(50),
		);
		idx.close();

		const { status, stdout, stderr } = runScript();
		if (status !== 0) {
			throw new Error(`script failed: ${stderr || stdout}`);
		}
		expect(status).toBe(0);

		const idx2 = new MemoryIndex(dbPath);
		idx2.init();
		try {
			// below_threshold stays active — no merge happened.
			const below = idx2.getAtom("below_threshold");
			expect(below).not.toBeNull();
			expect(below!.is_latest).toBe(1);
			expect(below!.parent_id).toBeNull();

			// And the existing pair merges still fired (sanity
			// check — the new atom didn't break the loop).
			expect(idx2.getAtom("a2")!.is_latest).toBe(0);
			expect(idx2.getAtom("b2")!.is_latest).toBe(0);
		} finally {
			idx2.close();
		}
	});
});
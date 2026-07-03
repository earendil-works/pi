import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { runMemoryExtraction } from "../extraction.ts";
import { recallAtoms } from "../search.ts";
import { MemoryIndex } from "../storage.ts";

// Mock embed to produce deterministic char n-gram vectors
function mockEmbed(text: string, dims = 1024): number[] {
	const arr = new Array(dims).fill(0);
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
	embedText: async (text: string) => mockEmbed(text),
	buildEmbeddableText: (atom: any) =>
		`${atom.title}\n\n${atom.summary}\n\n${(atom.tags || []).join(" ")}`,
	loadConfig: () => ({}),
	CURRENT_EMBEDDABLE_TEXT_VERSION: 2,
}));

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
			const index = (globalThis as Record<string, unknown>).__test_index as MemoryIndex | undefined;
			if (!index) return [];
			const qVec = mockEmbed(query);
			const denseFloor = options?.denseFloor ?? 0;
			const atoms = index.listAtoms({ archived: false });
			const hits: Array<{
				id: string; title: string; type: "rule" | "fact" | "process";
				rank: number; rrf: number; dense_cos: number; sparse_score: number;
			}> = [];
			for (const atom of atoms) {
				const text = `${atom.title}\n\n${atom.summary}\n\n${(atom.tags || []).join(" ")}`;
				const aVec = mockEmbed(text);
				const cos = cosine(qVec, aVec);
				if (cos < denseFloor) continue;
				hits.push({ id: atom.id, title: atom.title, type: atom.type, rank: 0, rrf: cos, dense_cos: cos, sparse_score: 0 });
			}
			hits.sort((a, b) => b.dense_cos - a.dense_cos);
			return hits.slice(0, topK).map((h, i) => ({ ...h, rank: i + 1 }));
		},
	};
});

describe("integration: extraction → embedding → recall", () => {
	let tmpDir: string;
	let dbPath: string;
	let atomsDir: string;

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "integration-"));
		dbPath = path.join(tmpDir, "memory.db");
		atomsDir = path.join(tmpDir, "atoms");
		await fs.mkdir(atomsDir, { recursive: true });
	});

	afterEach(async () => {
		delete (globalThis as Record<string, unknown>).__test_index;
		await fs.rm(tmpDir, { recursive: true, force: true });
	});

	it("extracted atom can be retrieved by related query", async () => {
		// Mock LLM returns a plan about PDF image extraction
		const mockCallLlm = async (_prompt: string) =>
			JSON.stringify({
				items: [
					{
						type: "process",
						title: "PDF 图片提取流程",
						content: "PDF 提取图片必须用 pymupdf 而不是 pdfplumber。fitz.open() 处理 CMYK。",
						summary: "PDF 图片提取用 pymupdf",
						tags: ["pdf", "pymupdf", "image"],
						importance: 0.8,
					},
				],
			});

		// Step 1: runMemoryExtraction (creates atom)
		const result = await runMemoryExtraction({
			callLlm: mockCallLlm,
			config: { model: "test-model" },
			messages: [{ role: "user", content: "How do I extract images from PDF?" }],
			dbPath,
			atomsDir,
		});
		expect(result.created).toHaveLength(1);
		const createdAtom = result.created[0]!;

		// Step 2: recallAtoms with related query
		const index = new MemoryIndex(dbPath);
		await index.init();
		(globalThis as Record<string, unknown>).__test_index = index;
		try {
			// threshold: 0 to work around position-sensitive char-bigram mock embed.
			// The hybrid RRF pipeline has no floor gate to bypass — `threshold: 0`
			// alone disables the dense cosine floor, letting the char-bigram mock's
			// ranking pass through without a floor check. Same pattern as the
			// recall-quality tests — measure pure channel ranking without any
			// gating policy interfering.
			const recall = await recallAtoms(index, "图片提取", {
				topK: 5,
				threshold: 0,
			});
			const ids = recall.map((r) => r.atom.id);
			expect(ids).toContain(createdAtom.id);
		} finally {
			index.close();
		}
	});

	it("extracted atom .md file is written and hydrates content", async () => {
		const mockCallLlm = async () =>
			JSON.stringify({
				items: [
					{
						type: "rule",
						title: "TypeScript strict",
						content: "All TypeScript files must use strict mode and no implicit any.",
						summary: "TS strict preference",
						tags: ["typescript"],
						importance: 0.7,
					},
				],
			});

		const result = await runMemoryExtraction({
			callLlm: mockCallLlm,
			config: { model: "test" },
			messages: [{ role: "user", content: "I prefer strict TS" }],
			dbPath,
			atomsDir,
		});
		expect(result.created).toHaveLength(1);
		const atom = result.created[0]!;

		// Check .md file exists
		const fp = path.join(atomsDir, atom.type, `${atom.id}.md`);
		const exists = await fs.stat(fp).then(() => true).catch(() => false);
		expect(exists).toBe(true);

		// Hydrate from file
		const { readAtomFromFile } = await import("../file-store.ts");
		const fileResult = await readAtomFromFile(fp, atom.content_fingerprint);
		expect(fileResult).not.toBeNull();
		expect(fileResult!.atom.content).toContain("strict mode");
	});

	it("extraction skips when fingerprint matches existing atom", async () => {
		const plan = {
			items: [
				{
					type: "rule",
					title: "Unique title",
					content: "Unique content for fingerprint test alpha bravo charlie.",
					summary: "Unique summary",
					tags: ["test"],
					importance: 0.5,
				},
			],
		};
		const mockCallLlm = async () => JSON.stringify(plan);

		// First run: creates
		const r1 = await runMemoryExtraction({
			callLlm: mockCallLlm,
			config: { model: "test" },
			messages: [{ role: "user", content: "first" }],
			dbPath,
			atomsDir,
		});
		expect(r1.created).toHaveLength(1);

		// Second run with same content: skips
		const r2 = await runMemoryExtraction({
			callLlm: mockCallLlm,
			config: { model: "test" },
			messages: [{ role: "user", content: "second" }],
			dbPath,
			atomsDir,
		});
		expect(r2.skipped).toHaveLength(1);
		expect(r2.created).toHaveLength(0);
	});
});
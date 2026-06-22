// recallAtoms — pure vector KNN retrieval (no fallback, no FTS).
//
// Architecture constraints (from design.md Decision 7, 8):
//   - embedText returns null on failure → recallAtoms must return [] (no fallback).
//   - Pure sqlite-vec KNN: no keyword matching, no FTS5.
//   - Discovery-only: every result carries file_path, no L0/L1 hydration split.
//     The agent reads full content via the standard `read` tool on demand.
//   - updateAccess called for every returned atom.
//   - Default cosine threshold = 0.5.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { embedText } from "../embed.ts";
import { writeAtomToFile } from "../file-store.ts";
import { recallAtoms } from "../search.ts";
import { MemoryIndex } from "../storage.ts";
import type { MemoryAtom, RecallResult } from "../types.ts";

// Mock embed.ts at module top — vitest hoists vi.mock, so this applies to all
// imports below (including the static import in search.ts). The factory passes
// through real implementations of buildEmbeddableText / loadConfig and replaces
// embedText with a deterministic char-bag mock that produces L2-normalised
// 1024-dim vectors. The char-bag hashes each char into a 1024-bin histogram so
// texts sharing characters (regardless of position) score high cosine and texts
// with disjoint character sets score near zero — this gives a wide margin above
// the 0.5 threshold for "similar" texts that a position-based bag cannot.
vi.mock("../embed.ts", async () => {
	const actual = await vi.importActual<typeof import("../embed.ts")>("../embed.ts");
	return {
		...actual,
		embedText: vi.fn(async (text: string) => {
			const arr = new Array(1024).fill(0);
			for (let i = 0; i < text.length; i++) {
				arr[text.charCodeAt(i) % 1024] += 1;
			}
			const norm = Math.sqrt(arr.reduce((s, v) => s + v * v, 0));
			if (norm > 0) for (let i = 0; i < arr.length; i++) arr[i] /= norm;
			return arr;
		}),
	};
});

describe("recallAtoms", () => {
	let index: MemoryIndex;
	let tmpDir: string;
	let atomsDir: string;
	let dbPath: string;

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "search-test-"));
		atomsDir = path.join(tmpDir, "atoms");
		dbPath = path.join(tmpDir, "memory.db");
		await fs.mkdir(atomsDir, { recursive: true });
		index = new MemoryIndex(dbPath);
		await index.init();
		// Reset the mocked embedText between tests so per-test overrides do not
		// leak. vi.mocked(embedText) reaches the same vi.fn instance across tests.
		vi.mocked(embedText).mockReset();
		// Reinstall the default implementation after reset — vi.fn() carries its
		// implementation through, but mockReset clears call history and any
		// per-test mockResolvedValueOnce overrides.
		vi.mocked(embedText).mockImplementation(async (text: string) => {
			const arr = new Array(1024).fill(0);
			for (let i = 0; i < text.length; i++) {
				arr[text.charCodeAt(i) % 1024] += 1;
			}
			const norm = Math.sqrt(arr.reduce((s, v) => s + v * v, 0));
			if (norm > 0) for (let i = 0; i < arr.length; i++) arr[i] /= norm;
			return arr;
		});
	});

	afterEach(async () => {
		index.close();
		await fs.rm(tmpDir, { recursive: true, force: true });
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
		await writeAtomToFile(atom, atomsDir);
	};

	it("returns empty array when ollama is unreachable (no fallback)", async () => {
		// Force the recall-time embedText call to return null. Earlier calls
		// (none, since we don't insert any atoms here) still see the default.
		vi.mocked(embedText).mockResolvedValueOnce(null);

		const results = await recallAtoms(index, "test query", atomsDir);
		expect(results).toEqual([]);
	});

	it("returns top-K results sorted by cosine", async () => {
		const a1 = sampleAtom({
			title: "TypeScript strict",
			content: "TypeScript strict mode is preferred in this project",
		});
		const a2 = sampleAtom({
			title: "JavaScript loose",
			content: "JavaScript dynamic typing is fine for prototypes",
		});
		await insertAtom(a1);
		await insertAtom(a2);

		const results = await recallAtoms(index, "TypeScript strict mode", atomsDir, {
			topK: 5,
		});
		expect(results.length).toBeGreaterThan(0);
		expect(results[0]?.atom.id).toBe(a1.id); // query shares prefix with a1
	});

	it("respects topK limit", async () => {
		for (let i = 0; i < 5; i++) {
			await insertAtom(
				sampleAtom({
					content: `Distinct content number ${i} with unique words ${i * 100}`,
				}),
			);
		}
		const results = await recallAtoms(index, "any query", atomsDir, { topK: 3 });
		expect(results.length).toBeLessThanOrEqual(3);
	});

	it("filters by type", async () => {
		const rule = sampleAtom({ type: "rule", content: "Rule content unique alpha keyword" });
		const fact = sampleAtom({ type: "fact", content: "Fact content unique beta keyword" });
		await insertAtom(rule);
		await insertAtom(fact);

		const results = await recallAtoms(index, "alpha content keyword", atomsDir, {
			filter: { type: "rule" },
		});
		expect(results.length).toBeGreaterThan(0);
		expect(results.every((r: RecallResult) => r.atom.type === "rule")).toBe(true);
	});

	it("excludes archived atoms", async () => {
		const a = sampleAtom({ content: "Active content gamma signal unique" });
		const arch = sampleAtom({
			content: "Archived content delta signal unique",
			archived: 1,
		});
		await insertAtom(a);
		await insertAtom(arch);

		const results = await recallAtoms(index, "gamma signal unique", atomsDir);
		expect(results.find((r: RecallResult) => r.atom.id === arch.id)).toBeUndefined();
	});

	it("excludes superseded atoms (is_latest=0)", async () => {
		const a = sampleAtom({ content: "Latest content epsilon signal unique" });
		const sup = sampleAtom({
			content: "Superseded content zeta signal unique",
			is_latest: 0,
		});
		await insertAtom(a);
		await insertAtom(sup);

		const results = await recallAtoms(index, "epsilon signal unique", atomsDir);
		expect(results.find((r: RecallResult) => r.atom.id === sup.id)).toBeUndefined();
	});

	it("returns file_path pointing to atomsDir/<type>/<id>.md", async () => {
		const a = sampleAtom({ type: "process", content: "zeta signal unique" });
		await insertAtom(a);

		const results = await recallAtoms(index, "zeta signal unique", atomsDir);
		expect(results.length).toBeGreaterThan(0);
		const first = results[0] as RecallResult;
		expect(first.file_path).toBe(
			path.join(atomsDir, "process", `${a.id}.md`),
		);
	});

	it("returns every result regardless of position (search is discovery-only, no L1 tier)", async () => {
		const a1 = sampleAtom({ content: "First distinct theta keyword" });
		const a2 = sampleAtom({ content: "Second distinct iota keyword" });
		const a3 = sampleAtom({ content: "Third distinct kappa keyword" });
		const a4 = sampleAtom({ content: "Fourth distinct lambda keyword" });
		await insertAtom(a1);
		await insertAtom(a2);
		await insertAtom(a3);
		await insertAtom(a4);

		const results = await recallAtoms(index, "distinct theta keyword", atomsDir, {
			topK: 10,
		});
		// Search must return all 4 — none are filtered out by an L0/L1 tier
		// distinction (there is no such distinction anymore).
		expect(results.length).toBe(4);
	});

	it("returns the atom even when the .md file is missing on disk", async () => {
		const a = sampleAtom({ content: "No file content mu signal unique" });
		await insertAtom(a);
		// Delete the .md file to simulate a missing-on-disk scenario.
		const fp = path.join(atomsDir, a.type, `${a.id}.md`);
		await fs.rm(fp, { force: true });

		const results = await recallAtoms(index, "mu signal unique", atomsDir);
		expect(results.length).toBeGreaterThan(0);
		expect(results[0]?.atom.id).toBe(a.id);
		// file_path is still computed — caller decides whether to read it.
		expect(results[0]?.file_path).toBe(fp);
	});

	it("updates access_count on retrieved atoms", async () => {
		const a = sampleAtom({ content: "Access count test nu signal unique" });
		await insertAtom(a);

		await recallAtoms(index, "nu signal unique", atomsDir);
		const got = index.getAtom(a.id);
		expect(got?.access_count).toBe(1);
	});
});
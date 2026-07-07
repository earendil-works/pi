// .md-as-source-of-truth — recall reads .md body, falls back to DB.
//
// Contract under test:
//   - When atomsDir is supplied, recallAtoms overrides `atom.content`
//     with the .md body for each hit (so edits via write/edit tool or
//     bash are reflected in the LLM's recall output).
//   - When the .md is missing or malformed, the DB content column is
//     returned unchanged (graceful degradation).
//   - When the .md body matches the DB content (no drift), no
//     override happens (the new object allocation is skipped).
//   - Title, summary, tags still come from the DB row (the .md
//     frontmatter changes are out of scope for this change).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";

// Fixed atom id used by every test case. The mock below returns
// this id from hybridSearch so recallAtoms can find the row in
// the freshly-created DB.
const ATOM_ID = "11111111-2222-3333-4444-555555555555";

vi.mock("../hybrid-search.ts", async () => {
	const actual = await vi.importActual<typeof import("../hybrid-search.ts")>("../hybrid-search.ts");
	return {
		...actual,
		hybridSearch: vi.fn(async () => {
			return [
				{
					id: ATOM_ID,
					title: "Test Hit",
					type: "fact",
					rank: 0,
					rrf: 0.0164,
					dense_cos: 0.6,
					sparse_score: 0.0,
				},
			];
		}),
	};
});

// Mock embed.ts at module level (char-bag deterministic embedder).
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

// bge-reindex is dynamically imported by the tool_result hook (not by
// recallAtoms), so the test doesn't strictly need to mock it. Mocking
// it anyway for symmetry with memory-tool.test.ts and to keep the
// option open for future hook tests in this file.
vi.mock("../bge-reindex.ts", () => ({
	reindexOne: vi.fn(async (_id: string) => ({ ok: true })),
}));

// Imports below MUST come after the vi.mock calls so they pick up
// the mocked modules.
import { embedText } from "../embed.ts";
import { recallAtoms } from "../search.ts";
import { MemoryIndex } from "../storage.ts";
import { writeAtomToFile } from "../file-store.ts";
import type { MemoryAtom } from "../types.ts";

function makeAtom(overrides: Partial<MemoryAtom> = {}): MemoryAtom {
	return {
		id: ATOM_ID,
		type: "fact",
		title: "Test Atom",
		content: "DB content: original",
		summary: "Test summary",
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
		content_fingerprint: "fp-original",
		source_session: null,
		...overrides,
	};
}

describe("recallAtoms reads .md body for content (canonical source)", () => {
	let dbPath: string;
	let atomsDir: string;
	let tmpDir: string;

	beforeEach(async () => {
		const os = await import("node:os");
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "recall-md-content-test-"));
		process.env.HOME = tmpDir;
		dbPath = path.join(tmpDir, ".pi", "agent", "memory", "memory.db");
		atomsDir = path.join(tmpDir, ".pi", "agent", "memory", "atoms");
	});

	afterEach(async () => {
		await fs.rm(tmpDir, { recursive: true, force: true });
	});

	async function setupAtom(atom: MemoryAtom): Promise<MemoryIndex> {
		const idx = new MemoryIndex(dbPath);
		await idx.init();
		const text = `${atom.title}\n\n${atom.summary}\n\n${atom.content}\n\n${atom.tags.join(" ")}`;
		const emb = await embedText(text);
		if (!emb) throw new Error("mocked embedText returned null");
		await idx.insertAtom(atom, emb);
		return idx;
	}

	it("returns DB content when atomsDir is NOT supplied (no .md lookup)", async () => {
		const atom = makeAtom();
		const idx = await setupAtom(atom);

		try {
			const hits = await recallAtoms(idx, "test query", { topK: 5 });
			expect(hits).toHaveLength(1);
			expect(hits[0]?.atom.content).toBe("DB content: original");
		} finally {
			idx.close();
		}
	});

	it("returns DB content when .md body matches the DB content (no override needed)", async () => {
		const atom = makeAtom();
		await writeAtomToFile(atom, atomsDir);
		const idx = await setupAtom(atom);

		try {
			const hits = await recallAtoms(idx, "test query", {
				topK: 5,
				atomsDir,
			});
			expect(hits).toHaveLength(1);
			expect(hits[0]?.atom.content).toBe("DB content: original");
		} finally {
			idx.close();
		}
	});

	it("overrides atom.content with the .md body when they differ (drift detected)", async () => {
		const atom = makeAtom();
		await writeAtomToFile(atom, atomsDir);

		// Drift the .md body — simulating a bash / edit tool mutation
		// that bypassed the extraction pipeline. We keep the frontmatter
		// stale (content_fingerprint still says "fp-original") so this
		// also exercises the frontmatter-stale / body-fresh case.
		const filePath = path.join(atomsDir, atom.type, `${atom.id}.md`);
		const newBody = "FRESH .md body: this is the user's edit";
		const raw = await fs.readFile(filePath, "utf8");
		const drifted = raw.replace("DB content: original", newBody);
		await fs.writeFile(filePath, drifted, "utf8");

		const idx = await setupAtom(atom);
		try {
			const hits = await recallAtoms(idx, "test query", {
				topK: 5,
				atomsDir,
			});
			expect(hits).toHaveLength(1);
			// The LLM should see the fresh .md body, not the stale DB column.
			expect(hits[0]?.atom.content).toBe(newBody);
		} finally {
			idx.close();
		}
	});

	it("falls back to DB content when the .md file is missing", async () => {
		const atom = makeAtom();
		// Note: writeAtomToFile is intentionally NOT called.
		const idx = await setupAtom(atom);

		try {
			const hits = await recallAtoms(idx, "test query", {
				topK: 5,
				atomsDir,
			});
			expect(hits).toHaveLength(1);
			// .md missing → fall back to DB content. The LLM sees
			// the stale text, but at least recall still works.
			expect(hits[0]?.atom.content).toBe("DB content: original");
		} finally {
			idx.close();
		}
	});

	it("falls back to DB content when the .md is malformed (no frontmatter)", async () => {
		const atom = makeAtom();
		// Create a malformed .md (no frontmatter delimiter).
		const filePath = path.join(atomsDir, atom.type, `${atom.id}.md`);
		await fs.mkdir(path.dirname(filePath), { recursive: true });
		await fs.writeFile(filePath, "just plain text, no frontmatter\n", "utf8");

		const idx = await setupAtom(atom);
		try {
			const hits = await recallAtoms(idx, "test query", {
				topK: 5,
				atomsDir,
			});
			expect(hits).toHaveLength(1);
			expect(hits[0]?.atom.content).toBe("DB content: original");
		} finally {
			idx.close();
		}
	});

	it("preserves other atom fields (title, summary, tags) from the DB row", async () => {
		const atom = makeAtom({
			title: "Original Title",
			summary: "Original Summary",
			tags: ["alpha", "beta"],
		});
		await writeAtomToFile(atom, atomsDir);

		// Drift only the body.
		const filePath = path.join(atomsDir, atom.type, `${atom.id}.md`);
		const raw = await fs.readFile(filePath, "utf8");
		const drifted = raw.replace("DB content: original", "FRESH body");
		await fs.writeFile(filePath, drifted, "utf8");

		const idx = await setupAtom(atom);
		try {
			const hits = await recallAtoms(idx, "test query", {
				topK: 5,
				atomsDir,
			});
			expect(hits).toHaveLength(1);
			const got = hits[0]?.atom;
			expect(got?.content).toBe("FRESH body");
			expect(got?.title).toBe("Original Title");
			expect(got?.summary).toBe("Original Summary");
			expect(got?.tags).toEqual(["alpha", "beta"]);
		} finally {
			idx.close();
		}
	});
});

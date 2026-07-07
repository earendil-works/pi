// drift-sweep.test.ts — periodic .md ↔ DB drift detection.
//
// Contract under test:
//   - runDriftSweep walks atomsDir, parses each .md, compares the
//     body fingerprint to the DB's content_fingerprint.
//   - In-sync files are skipped silently.
//   - Drifted files (DB fingerprint != body fingerprint) trigger
//     reindexOne; the DB row itself is NOT modified (extraction
//     pipeline is the only writer of content_fingerprint).
//   - .md files with no DB row also trigger reindexOne (orphan
//     recovery — the bge-m3 service writes the vector so the file
//     becomes at least discoverable via recall).
//   - Malformed .md files (no frontmatter) are skipped silently.
//   - reindexOne failures are counted but don't abort the sweep.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import { MemoryIndex } from "../storage.ts";
import { writeAtomToFile } from "../file-store.ts";
import { computeFingerprint } from "../extraction.ts";
import { runDriftSweep } from "../drift-sweep.ts";
import type { MemoryAtom } from "../types.ts";

let mockReindex: ReturnType<typeof vi.fn>;

beforeEach(async () => {
	vi.resetModules();

	// Mock embed.ts at module level (char-bag deterministic embedder).
	vi.doMock("../embed.ts", async () => {
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

	mockReindex = vi.fn(async (_id: string) => ({ ok: true }));
	vi.doMock("../bge-reindex.ts", () => ({ reindexOne: mockReindex }));
});

afterEach(() => {
	vi.doUnmock("../bge-reindex.ts");
	vi.doUnmock("../embed.ts");
	vi.restoreAllMocks();
});

function makeAtom(overrides: Partial<MemoryAtom> = {}): MemoryAtom {
	return {
		id: crypto.randomUUID(),
		type: "fact",
		title: "Test Fact",
		content: "Test content here",
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
		content_fingerprint: computeFingerprint("Test content here"),
		source_session: null,
		...overrides,
	};
}

describe("drift-sweep", () => {
	let dbPath: string;
	let atomsDir: string;
	let tmpDir: string;

	beforeEach(async () => {
		const os = await import("node:os");
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "drift-sweep-test-"));
		process.env.HOME = tmpDir;
		dbPath = path.join(tmpDir, ".pi", "agent", "memory", "memory.db");
		atomsDir = path.join(tmpDir, ".pi", "agent", "memory", "atoms");
	});

	afterEach(async () => {
		await fs.rm(tmpDir, { recursive: true, force: true });
	});

	async function setupAtomInDb(atom: MemoryAtom): Promise<MemoryIndex> {
		const idx = new MemoryIndex(dbPath);
		await idx.init();
		const { embedText } = await import("../embed.ts");
		const text = `${atom.title}\n\n${atom.summary}\n\n${atom.content}\n\n${atom.tags.join(" ")}`;
		const emb = await embedText(text);
		if (!emb) throw new Error("mocked embedText returned null");
		await idx.insertAtom(atom, emb);
		return idx;
	}

	it("returns 0 / 0 / 0 when no .md files exist", async () => {
		const idx = new MemoryIndex(dbPath);
		await idx.init();
		try {
			const stats = await runDriftSweep(atomsDir, idx);
			expect(stats).toEqual({
				checked: 0,
				drifted: 0,
				reindexed: 0,
				failed: 0,
				errors: [],
			});
		} finally {
			idx.close();
		}
	});

	it("does NOT reindex when .md body matches DB content_fingerprint", async () => {
		const atom = makeAtom();
		await writeAtomToFile(atom, atomsDir);
		const idx = await setupAtomInDb(atom);
		try {
			const stats = await runDriftSweep(atomsDir, idx);
			expect(stats.checked).toBe(1);
			expect(stats.drifted).toBe(0);
			expect(stats.reindexed).toBe(0);
			expect(mockReindex).not.toHaveBeenCalled();
		} finally {
			idx.close();
		}
	});

	it("reindexes when .md body has been edited (DB content_fingerprint stale)", async () => {
		const atom = makeAtom();
		await writeAtomToFile(atom, atomsDir);

		// Now overwrite the .md with a new body — simulating the user
		// editing the file outside of extraction.ts.
		const filePath = path.join(atomsDir, atom.type, `${atom.id}.md`);
		const newBody = "This is a completely different content that the user typed by hand";
		const newFrontmatter = `id: "${atom.id}"
type: "fact"
title: "${atom.title}"
summary: "${atom.summary}"
content_fingerprint: "${atom.content_fingerprint}"  // STALE — not updated
`;
		await fs.writeFile(filePath, `---\n${newFrontmatter}---\n\n${newBody}\n`, "utf8");

		const idx = await setupAtomInDb(atom);
		try {
			const stats = await runDriftSweep(atomsDir, idx);
			expect(stats.checked).toBe(1);
			expect(stats.drifted).toBe(1);
			expect(stats.reindexed).toBe(1);
			expect(mockReindex).toHaveBeenCalledWith(atom.id);
		} finally {
			idx.close();
		}
	});

	it("reindexes orphan .md (no DB row) so the vector exists", async () => {
		const atom = makeAtom();
		// Only write the .md file, do NOT insert into DB.
		await writeAtomToFile(atom, atomsDir);

		const idx = new MemoryIndex(dbPath);
		await idx.init();
		try {
			const stats = await runDriftSweep(atomsDir, idx);
			expect(stats.checked).toBe(1);
			expect(stats.drifted).toBe(1);
			expect(stats.reindexed).toBe(1);
			expect(mockReindex).toHaveBeenCalledWith(atom.id);
		} finally {
			idx.close();
		}
	});

	it("silently skips malformed .md files (no frontmatter)", async () => {
		// No frontmatter at all — file should be skipped, not throw.
		const bad = path.join(atomsDir, "fact", "broken.md");
		await fs.mkdir(path.dirname(bad), { recursive: true });
		await fs.writeFile(bad, "just plain text, no frontmatter\n", "utf8");

		const idx = new MemoryIndex(dbPath);
		await idx.init();
		try {
			const stats = await runDriftSweep(atomsDir, idx);
			expect(stats.checked).toBe(1);
			expect(stats.drifted).toBe(0);
			expect(mockReindex).not.toHaveBeenCalled();
		} finally {
			idx.close();
		}
	});

	it("counts reindex failures without aborting the sweep", async () => {
		mockReindex.mockResolvedValue({ ok: false, error: "service down" });
		const a1 = makeAtom({ title: "A1" });
		const a2 = makeAtom({ title: "A2" });
		await writeAtomToFile(a1, atomsDir);
		await writeAtomToFile(a2, atomsDir);

		// Drift both by overwriting the .md bodies.
		for (const a of [a1, a2]) {
			const fp = path.join(atomsDir, a.type, `${a.id}.md`);
			await fs.writeFile(fp, `---\nid: "${a.id}"\n---\n\nnew body for ${a.title}\n`, "utf8");
		}

		const idx = new MemoryIndex(dbPath);
		await idx.init();
		try {
			const stats = await runDriftSweep(atomsDir, idx);
			expect(stats.checked).toBe(2);
			expect(stats.drifted).toBe(2);
			expect(stats.reindexed).toBe(0);
			expect(stats.failed).toBe(2);
		} finally {
			idx.close();
		}
	});

	it("does not modify the DB row when drift is detected (extraction owns the fingerprint)", async () => {
		const atom = makeAtom();
		await writeAtomToFile(atom, atomsDir);

		// Drift the body.
		const fp = path.join(atomsDir, atom.type, `${atom.id}.md`);
		await fs.writeFile(fp, `---\nid: "${atom.id}"\n---\n\nnew body\n`, "utf8");

		const idx = await setupAtomInDb(atom);
		try {
			await runDriftSweep(atomsDir, idx);
			const after = idx.getAtom(atom.id);
			// The DB content_fingerprint must still match the original
			// body — the sweep only triggers reindex, it does NOT
			// touch the DB row.
			expect(after?.content_fingerprint).toBe(atom.content_fingerprint);
		} finally {
			idx.close();
		}
	});
});

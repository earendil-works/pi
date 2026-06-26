// supersedeIfSimilar — extracted from extraction.ts:executeItem so the webui
// PATCH path can reuse the same cosine dedup gate without duplicating the
// algorithm. See design.md Decision 2 ("写入路径优先走已有 supersede 机制").
//
// Algorithm under test (mirrors extraction.ts:122-162, but accepts an
// externally-built atom + embedding instead of building from an item):
//   - embedding === null → return {status: "create", atom: newAtom} (graceful
//     degradation per search.ts Decision 7 — embedder is optional, write must
//     still happen).
//   - findMostSimilarEmbedding(embedding, threshold ?? 0.92)
//   - if hit: markSupersededTx + writeAtomToFile → {status: "supersede",
//     atom: finalNew}. Reuses storage.markSupersededTx so the same row +
//     vector + FTS5 swap semantics apply.
//   - else: {status: "create", atom: newAtom}. The CALLER does insertAtom /
//     updateAtom — this function is the dedup gate, not a write primitive.
//
// Why this is a separate file: extraction.ts:executeItem is buried inside the
// extraction pipeline (depends on ExtractionItem shape + computeFingerprint).
// The webui PATCH entry point (memory.ts) already has a fully-shaped
// MemoryAtom + the embedding from its own embed call — extracting a small,
// pure helper that takes both directly keeps the dedup logic DRY without
// coupling it to the extraction-item shape.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { embedText } from "../embed.ts";
import { MemoryIndex } from "../storage.ts";
import { supersedeIfSimilar } from "../dedup.ts";
import type { MemoryAtom } from "../types.ts";

// ---------------------------------------------------------------------------
// Test scaffolding — charBag mock (per task brief, mirroring
// hybrid-recall.test.ts:42-49) + controlled cosine vectors. Real MemoryIndex
// + real SQLite; the only mock is the embedder. For tests 1 and 2 we use the
// charBag mock with disjoint title/summary/tags so the natural charBag
// cosines are reliably below 0.92 — relying on the default "Sample summary"
// + "test" tags makes the dot product dominated by shared \n characters and
// pushes the cosine well above the threshold regardless of content. For
// tests 3, 4 and 5 we bypass the embedder with `index.insertAtom(a, vec)`
// directly so the cosine is precisely controlled.
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
const V_COS_07 = makeVec(0.7);
const V_COS_05 = makeVec(0.5);

vi.mock("../embed.ts", async () => {
	const actual = await vi.importActual<typeof import("../embed.ts")>("../embed.ts");
	return {
		...actual,
		embedText: vi.fn(async (text: string) => charBag(text)),
	};
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

const insertAtom = async (atom: MemoryAtom, index: MemoryIndex): Promise<void> => {
	const text = `${atom.title}\n\n${atom.summary}\n\n${atom.content}\n\n${atom.tags.join(" ")}`;
	const emb = await embedText(text);
	if (!emb) throw new Error("mocked embedText returned null in test setup");
	await index.insertAtom(atom, emb);
};

describe("supersedeIfSimilar", () => {
	let index: MemoryIndex;
	let tmpDir: string;
	let atomsDir: string;

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "dedup-test-"));
		atomsDir = path.join(tmpDir, "atoms");
		await fs.mkdir(atomsDir, { recursive: true });
		index = new MemoryIndex(":memory:");
		await index.init();
		vi.mocked(embedText).mockReset();
		vi.mocked(embedText).mockImplementation(async (text: string) => charBag(text));
	});

	afterEach(async () => {
		index.close();
		await fs.rm(tmpDir, { recursive: true, force: true });
	});

	// Test 1: charBag of disjoint title/summary/tags ("AAA" / "BBB" / "CCC")
	// yields low cosines (~0.31) — well below 0.92. The new atom's
	// embedding doesn't match either A or B, so the function returns
	// "create" without mutating the index.
	it("returns create when no similar atom exists (cosine < 0.92)", async () => {
		const a = sampleAtom({
			title: "AAA",
			summary: "AAA",
			content: "alpha content",
			tags: ["AAA"],
		});
		const b = sampleAtom({
			title: "BBB",
			summary: "BBB",
			content: "beta content",
			tags: ["BBB"],
		});
		await insertAtom(a, index);
		await insertAtom(b, index);

		const newAtom = sampleAtom({
			title: "CCC",
			summary: "CCC",
			content: "gamma content",
			tags: ["CCC"],
		});
		const text = `${newAtom.title}\n\n${newAtom.summary}\n\n${newAtom.content}\n\n${newAtom.tags.join(" ")}`;
		const newEmbedding = await embedText(text);
		if (!newEmbedding) throw new Error("test setup failed");

		const result = await supersedeIfSimilar(index, atomsDir, newAtom, newEmbedding);
		expect(result.status).toBe("create");
		// On the "create" path the function does NOT mutate the index —
		// the caller is responsible for insertAtom / updateAtom. Verify by
		// checking the returned atom is the caller's newAtom unchanged.
		expect(result.atom.id).toBe(newAtom.id);
		expect(result.atom.is_latest).toBe(1);
		// A and B remain active.
		expect(index.getAtom(a.id)?.is_latest).toBe(1);
		expect(index.getAtom(b.id)?.is_latest).toBe(1);
	});

	// Test 2: pass A's own embedding (computed deterministically by the
	// charBag mock) into `supersedeIfSimilar`. The cosine with the stored
	// row is exactly 1.0 → supersede path. The new atom has different
	// content (different fingerprint) so the active-fingerprint UNIQUE
	// constraint does not collide.
	it("supersedes when identical embedding matches A (cosine 1.0)", async () => {
		const a = sampleAtom({ content: "alpha content unique" });
		await insertAtom(a, index);

		const aCombinedText = `${a.title}\n\n${a.summary}\n\n${a.content}\n\n${a.tags.join(" ")}`;
		const aEmbedding = await embedText(aCombinedText);
		if (!aEmbedding) throw new Error("test setup failed");

		const newAtom = sampleAtom({ content: "alpha content unique v2" });
		const result = await supersedeIfSimilar(index, atomsDir, newAtom, aEmbedding);
		expect(result.status).toBe("supersede");

		// Old A row is marked superseded.
		const oldAfter = index.getAtom(a.id);
		expect(oldAfter?.is_latest).toBe(0);
		expect(oldAfter?.superseded_at).not.toBeNull();
		// New atom is the latest version.
		expect(result.atom.is_latest).toBe(1);
		expect(result.atom.id).toBe(newAtom.id);
		// parent_id points at the superseded atom (storage-side guarantee).
		expect(result.atom.parent_id).toBe(a.id);
	});

	// Test 3: embedding === null collapses to "create" without touching
	// the index. This is the graceful-degradation path required by
	// search.ts Decision 7 (embedder failure must not block writes).
	it("returns create when embedding is null (graceful degradation)", async () => {
		// Use direct vector for A so we don't depend on the embedder mock
		// state for this test.
		const a = sampleAtom({ title: "Atom A", content: "alpha content unique" });
		await index.insertAtom(a, V_UNIT);

		const newAtom = sampleAtom({ title: "New", content: "new content" });
		const result = await supersedeIfSimilar(index, atomsDir, newAtom, null);
		expect(result.status).toBe("create");
		expect(result.atom.id).toBe(newAtom.id);
		expect(result.atom.is_latest).toBe(1);
		// A is unchanged — the "create" path must not touch the existing
		// active atom.
		const aAfter = index.getAtom(a.id);
		expect(aAfter?.is_latest).toBe(1);
	});

	// Test 4: caller passes a low threshold (0.5). With cosine 0.7 vs A
	// the function should clear the threshold and supersede. Bypasses the
	// charBag path by inserting A with the controlled V_UNIT vector
	// directly (insertAtom's `embedding` argument is what storage stores —
	// it does not go through the embedder).
	it("supersedes with custom threshold (0.5) when cosine 0.7", async () => {
		const a = sampleAtom({ title: "Atom A", content: "alpha content unique" });
		await index.insertAtom(a, V_UNIT);

		const newAtom = sampleAtom({ title: "New", content: "different content here" });
		const result = await supersedeIfSimilar(index, atomsDir, newAtom, V_COS_07, 0.5);
		expect(result.status).toBe("supersede");
		expect(result.atom.is_latest).toBe(1);
	});

	// Test 5: default threshold is 0.92 (matches extraction.ts:147).
	// With cosine 0.5 the threshold is NOT cleared, so the function
	// returns "create" and leaves the existing atom untouched.
	it("returns create with default threshold (0.92) when cosine 0.5", async () => {
		const a = sampleAtom({ title: "Atom A", content: "alpha content unique" });
		await index.insertAtom(a, V_UNIT);

		const newAtom = sampleAtom({ title: "New", content: "different content here" });
		// No threshold argument → falls back to 0.92.
		const result = await supersedeIfSimilar(index, atomsDir, newAtom, V_COS_05);
		expect(result.status).toBe("create");
		expect(result.atom.id).toBe(newAtom.id);
		// A is still active and latest.
		const aAfter = index.getAtom(a.id);
		expect(aAfter?.is_latest).toBe(1);
	});

	// Test 6: PATCH path passes newAtom with id === most-similar atom's id.
	// The most similar match is the atom itself (cosine 1.0). Without a
	// self-match guard, markSupersededTx would UPDATE the row's is_latest=0
	// then INSERT a new row with the same id → UNIQUE PRIMARY KEY failure
	// → route 500s. The guard must return "create" so the caller can do
	// its own in-place updateAtom for the same atom id.
	it("returns create when most similar atom is self (same id)", async () => {
		const a = sampleAtom({ id: "A1", title: "Atom A", content: "alpha content unique" });
		await index.insertAtom(a, V_UNIT);

		const updatedA: MemoryAtom = { ...a, content: "alpha content unique v2" };
		const result = await supersedeIfSimilar(index, atomsDir, updatedA, V_UNIT);
		expect(result.status).toBe("create");
		expect(result.atom.id).toBe(updatedA.id);
		// A is unchanged: still active and latest.
		const aAfter = index.getAtom(a.id);
		expect(aAfter?.is_latest).toBe(1);
		expect(aAfter?.content).toBe(a.content);
		// No new atom file was written — "create" leaves file writes to the caller.
		const files = await fs.readdir(atomsDir);
		expect(files).toHaveLength(0);
	});
});

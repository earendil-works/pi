import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { MemoryIndex } from "../storage.ts";
import { loadTagVocabulary, normalizeTag, conceptTagCount } from "../tag-vocab.ts";
import type { MemoryAtom } from "../types.ts";

const EMBED_DIM = 1024;
const ZERO_VEC = new Array(EMBED_DIM).fill(0);

let tmpDir: string;
let index: MemoryIndex;

beforeEach(async () => {
	tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "tag-vocab-test-"));
	index = new MemoryIndex(path.join(tmpDir, "test.db"));
	await index.init();
});

afterEach(async () => {
	index.close();
	await fs.rm(tmpDir, { recursive: true, force: true });
});

function makeAtom(tags: string[]): MemoryAtom {
	const id = randomUUID();
	const fp = id.replace(/-/g, "").slice(0, 16);
	return {
		id,
		type: "fact",
		title: "test " + id,
		content: "test content for " + id,
		summary: "test",
		tags,
		importance: 0.5,
		strength: 1.0,
		access_count: 0,
		version: 1,
		is_latest: 1,
		parent_id: null,
		superseded_at: null,
		archived: 0,
		created_at: Date.now(),
		updated_at: Date.now(),
		last_access: null,
		content_fingerprint: fp,
		source_session: null,
	};
}

async function seed(tags: string[], count: number): Promise<void> {
	for (let i = 0; i < count; i++) {
		await index.insertAtom(makeAtom(tags), ZERO_VEC);
	}
}

describe("loadTagVocabulary", () => {
	it("(a) returns [] when corpus is empty", () => {
		expect(loadTagVocabulary(index)).toEqual([]);
	});

	it("(b) ranks tags by frequency DESC and returns top K", async () => {
		// 5 atoms with ["amplicon", "16S"]  → amplicon += 5, 16S += 5
		await seed(["amplicon", "16S"], 5);
		// 2 atoms with ["amplicon", "修复"] → amplicon += 2, 修复 += 2
		await seed(["amplicon", "修复"], 2);
		// Totals: amplicon=7, 16S=5, 修复=2

		const top2 = loadTagVocabulary(index, 2);
		expect(top2).toEqual(["amplicon", "16S"]);

		// Sanity: full vocabulary (topK=50 default) is in count-DESC order
		const full = loadTagVocabulary(index);
		expect(full[0]).toBe("amplicon");
		expect(full[1]).toBe("16S");
		expect(full[2]).toBe("修复");
		expect(full).toHaveLength(3);
	});
});

describe("normalizeTag", () => {
	it("(c) lowercases via dictionary lowercase match", () => {
		const dict = new Set(["amplicon"]);
		expect(normalizeTag("Amplicon", dict)).toBe("amplicon");
	});

	it("(d) preserves canonical casing when dictionary has the exact form", () => {
		const dict = new Set(["MGM"]);
		// Input matches dict exactly → return as-is (don't force lowercase).
		expect(normalizeTag("MGM", dict)).toBe("MGM");
	});

	it("(e) passes through when no dictionary and already lowercase", () => {
		expect(normalizeTag("amplicon")).toBe("amplicon");
	});

	it("(f) preserves Chinese tags verbatim (CJK has no case concept)", () => {
		expect(normalizeTag("扩增子")).toBe("扩增子");
	});

	it("(g) returns empty string for empty input", () => {
		expect(normalizeTag("")).toBe("");
		expect(normalizeTag("   ")).toBe("");
	});

	it("(h) trims leading and trailing whitespace", () => {
		expect(normalizeTag("  amplicon  ")).toBe("amplicon");
		// Trim applies even when dictionary exact match is on the trimmed form
		const dict = new Set(["amplicon"]);
		expect(normalizeTag("  Amplicon  ", dict)).toBe("amplicon");
	});
});

describe("conceptTagCount", () => {
	it("(i) counts a single concept/ tag", () => {
		expect(conceptTagCount(["concept/fix", "amplicon"])).toBe(1);
	});

	it("(j) returns 0 when no concept/ tags are present", () => {
		expect(conceptTagCount(["amplicon", "16S"])).toBe(0);
	});

	it("(k) returns 0 for empty input", () => {
		expect(conceptTagCount([])).toBe(0);
	});

	it("(S20) 1000-atom loadTagVocabulary completes in < 100ms", async () => {
		const tags = ["mcp", "memory", "atom", "rule", "fact", "process", "concept/mcp", "concept/memory"];
		await seed(tags, 1000);
		const t0 = performance.now();
		const result = loadTagVocabulary(index, 50);
		const elapsed = performance.now() - t0;
		expect(result.length).toBeGreaterThan(0);
		expect(elapsed).toBeLessThan(100);
	});

	it("counts multiple concept/ tags but ignores 'concept' (no slash)", () => {
		// Regression: must use startsWith("concept/"), not includes("concept").
		expect(conceptTagCount(["concept/fix", "concept/location", "concept"])).toBe(2);
	});
});
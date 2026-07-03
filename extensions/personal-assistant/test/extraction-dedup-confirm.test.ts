import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { confirmDedupAction } from "../extraction-dedup-confirm.ts";
import { __testing_executeItem } from "../extraction.ts";
import { MemoryIndex } from "../storage.ts";
import { embedText } from "../embed.ts";
import type { MemoryAtom, ExtractionItem } from "../types.ts";

// ---------------------------------------------------------------------------
// Module-level mock: embed.ts
// ---------------------------------------------------------------------------
//
// Task 3.10 tests drive `executeItem` directly with controlled cosine
// vectors, so the real `embedText` would (a) try to hit bge-m3 and (b)
// return char-bag noise that defeats our controlled-cosine assertions.
// We mock only `embedText` and let `buildEmbeddableText` keep its real
// implementation (it's a pure string helper).
//
// `vi.mock` is hoisted to the top of the file, so the import of
// `embedText` above resolves to the mocked function.

vi.mock("../embed.ts", async () => {
	const actual = await vi.importActual<typeof import("../embed.ts")>("../embed.ts");
	return {
		...actual,
		embedText: vi.fn(),
	};
});

// ---------------------------------------------------------------------------
// Controlled-cosine vector helpers
// ---------------------------------------------------------------------------
//
// `executeItem` calls `embedText(buildEmbeddableText(newAtom))` then
// `findMostSimilarEmbedding(embedding, 0.65)`. The threshold check uses
// `1 - distance²/2` which is exact only for L2-normalised vectors, so we
// generate unit vectors deterministically:
//
//   V_UNIT      = [1, 0, 0, ...]          (atom A's stored vector)
//   V_COS_X     = [cos(x), sin(x), 0, ...] (item I's mocked embedding)
//
// cos(θ) for V_UNIT · V_COS_X = cos(x), so embedding lookup returns
// cosine x against A. Used to flip the cosine ≥ 0.65 branch on or off
// without relying on string overlap heuristics.

const DIM = 1024;

function makeUnitVector(): number[] {
	const arr = new Array(DIM).fill(0);
	arr[0] = 1;
	return arr;
}

function makeVecWithCosine(cosine: number): number[] {
	const theta = Math.acos(Math.min(1, Math.max(-1, cosine)));
	const arr = new Array(DIM).fill(0);
	arr[0] = Math.cos(theta);
	arr[1] = Math.sin(theta);
	return arr;
}

const V_UNIT = makeUnitVector();
const V_COS_077 = makeVecWithCosine(0.77);

// Fixture builders — keep tests focused on the function under test, not on
// constructing realistic atoms from scratch. The shape mirrors what
// types.ts guarantees; only the fields that the prompt / schema reference
// are populated.
function makeHitAtom(overrides: Partial<MemoryAtom> = {}): MemoryAtom {
	return {
		id: "hit-atom-1",
		type: "fact",
		title: "PDF extraction library",
		summary: "PDF 提取用 pymupdf",
		content: "PDF 提取用 pymupdf 而不是 pdfplumber, 因为 layout 保留更好",
		tags: ["pdf", "image extraction"],
		importance: 0.6,
		strength: 0.6,
		access_count: 0,
		version: 1,
		is_latest: 1,
		parent_id: null,
		superseded_at: null,
		archived: 0,
		created_at: 1719000000000,
		updated_at: 1719000000000,
		last_access: null,
		content_fingerprint: "fp-hit-1",
		source_session: null,
		...overrides,
	};
}

function makeNewItem(overrides: Partial<ExtractionItem> = {}): ExtractionItem {
	return {
		type: "fact",
		title: "PDF extraction library v2",
		summary: "PDF 提取改用 pymupdf + 新的 layout 模式",
		content: "PDF 提取改用 pymupdf 的新 layout 模式, 默认 dpi=200",
		tags: ["pdf", "pymupdf"],
		importance: 0.65,
		...overrides,
	};
}

// callLlm helper: returns a stub that yields the supplied response verbatim.
// The function under test must pass `prompt` to callLlm exactly once; we
// assert this with vi.fn() in the prompt-shape case.
function makeCallLlm(response: string | (() => string)): (prompt: string) => Promise<string> {
	const fn = vi.fn(async () => (typeof response === "string" ? response : response()));
	return fn as unknown as (prompt: string) => Promise<string>;
}

describe("confirmDedupAction — LLM 输出解析", () => {
	it("(l) valid JSON {action: 'update', merged: {...}} → 解析成功, 返回 action + merged", async () => {
		const llmResponse = JSON.stringify({
			action: "update",
			merged: {
				title: "PDF extraction library (updated)",
				summary: "PDF 提取用 pymupdf 新 layout 模式",
				content: "PDF 提取用 pymupdf 而不是 pdfplumber, 因为 layout 保留更好。\n2026-07 新增 dpi=200 默认值",
				tags: ["pdf", "image extraction", "pymupdf"],
			},
		});
		const callLlm = makeCallLlm(llmResponse);

		const result = await confirmDedupAction(callLlm, makeHitAtom(), makeNewItem(), 0.82);

		expect(result.action).toBe("update");
		expect(result.merged).toBeDefined();
		expect(result.merged?.title).toContain("PDF extraction library");
		expect(result.merged?.tags).toEqual(["pdf", "image extraction", "pymupdf"]);
		// callLlm was invoked exactly once with a non-empty prompt.
		expect(callLlm).toHaveBeenCalledTimes(1);
		const promptArg = (callLlm as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]?.[0] as string;
		expect(promptArg.length).toBeGreaterThan(0);
	});

	it("(l2) valid JSON {action: 'supersede'} (no merged field) → 解析成功, merged undefined", async () => {
		const llmResponse = JSON.stringify({ action: "supersede" });
		const callLlm = makeCallLlm(llmResponse);

		const result = await confirmDedupAction(callLlm, makeHitAtom(), makeNewItem(), 0.91);

		expect(result.action).toBe("supersede");
		expect(result.merged).toBeUndefined();
	});

	it("(l3) valid JSON {action: 'create'} → action='create', merged undefined", async () => {
		const llmResponse = JSON.stringify({ action: "create" });
		const callLlm = makeCallLlm(llmResponse);

		const result = await confirmDedupAction(callLlm, makeHitAtom(), makeNewItem(), 0.66);

		expect(result.action).toBe("create");
		expect(result.merged).toBeUndefined();
	});

	it("(l4) valid JSON {action: 'skip'} → action='skip'", async () => {
		const llmResponse = JSON.stringify({ action: "skip" });
		const callLlm = makeCallLlm(llmResponse);

		const result = await confirmDedupAction(callLlm, makeHitAtom(), makeNewItem(), 0.99);

		expect(result.action).toBe("skip");
		expect(result.merged).toBeUndefined();
	});

	it("(m) invalid JSON → throw 含 'non-JSON'", async () => {
		const callLlm = makeCallLlm("this is not JSON at all");

		await expect(
			confirmDedupAction(callLlm, makeHitAtom(), makeNewItem(), 0.8),
		).rejects.toThrow(/non-JSON/);
	});

	it("(m2) empty string response → throw 'non-JSON'", async () => {
		const callLlm = makeCallLlm("");

		await expect(
			confirmDedupAction(callLlm, makeHitAtom(), makeNewItem(), 0.8),
		).rejects.toThrow(/non-JSON/);
	});

	it("(n) valid JSON but wrong schema (action not in 4 枚举) → throw 'validation' or 'schema'", async () => {
		const llmResponse = JSON.stringify({ action: "merge" }); // not in [update, supersede, create, skip]
		const callLlm = makeCallLlm(llmResponse);

		await expect(
			confirmDedupAction(callLlm, makeHitAtom(), makeNewItem(), 0.8),
		).rejects.toThrow(/validation|schema/i);
	});

	it("(n2) valid JSON, action='update' 但 merged.title 太长 (>200) → throw validation", async () => {
		const llmResponse = JSON.stringify({
			action: "update",
			merged: {
				title: "x".repeat(201),
				summary: "long enough summary text here",
				content: "long enough content text here for validation",
				tags: ["pdf"],
			},
		});
		const callLlm = makeCallLlm(llmResponse);

		await expect(
			confirmDedupAction(callLlm, makeHitAtom(), makeNewItem(), 0.8),
		).rejects.toThrow(/validation|schema/i);
	});

	it("(n3) valid JSON, action='update' 但 merged.tags 超过 10 个 → throw validation", async () => {
		const llmResponse = JSON.stringify({
			action: "update",
			merged: {
				title: "ok title",
				summary: "long enough summary text here",
				content: "long enough content text here for validation",
				tags: new Array(11).fill("tag"),
			},
		});
		const callLlm = makeCallLlm(llmResponse);

		await expect(
			confirmDedupAction(callLlm, makeHitAtom(), makeNewItem(), 0.8),
		).rejects.toThrow(/validation|schema/i);
	});

	it("prompt injects hitAtom + newItem 字段 + cosine", async () => {
		const llmResponse = JSON.stringify({ action: "skip" });
		const callLlm = makeCallLlm(llmResponse);

		const hitAtom = makeHitAtom({ title: "HIT_TITLE_X", tags: ["hit-tag-1", "hit-tag-2"] });
		const newItem = makeNewItem({ title: "NEW_TITLE_Y", tags: ["new-tag-1"] });

		await confirmDedupAction(callLlm, hitAtom, newItem, 0.777);

		const promptArg = (callLlm as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]?.[0] as string;
		expect(promptArg).toContain("HIT_TITLE_X");
		expect(promptArg).toContain("NEW_TITLE_Y");
		expect(promptArg).toContain("hit-tag-1, hit-tag-2");
		expect(promptArg).toContain("new-tag-1");
		expect(promptArg).toContain("0.777");
		// No raw placeholders left behind (would mean .replace() missed one).
		expect(promptArg).not.toContain("{hitAtom.title}");
		expect(promptArg).not.toContain("{newItem.title}");
		expect(promptArg).not.toContain("{cosine}");
	});
});

// ===========================================================================
// Task 3.10: executeItem integration tests
// ===========================================================================
//
// These cases exercise `executeItem` directly (via __testing_executeItem) so
// we can:
//   - control the cosine via `embedText` mock + a controlled V_UNIT atom
//     pre-seeded in the index
//   - spy on `index.insertAtom` / `index.updateAtom` / `markSupersededTx` to
//     assert which write path was taken
//   - inspect the result.atom to verify version bumps, field rewrites, and
//     tag normalisation end-to-end
//
// Storage is the real `MemoryIndex` against an in-memory SQLite, so the
// cosine path (sqlite-vec KNN + L2→cosine conversion) and the supersede
// transaction (`markSupersededTx`) run exactly as production does.

/**
 * Seed atom A in the index with a controlled vector. The atom's
 * `content_fingerprint` is set to a value distinct from anything we plan
 * to executeItem against so the fingerprint dedup branch doesn't fire
 * first.
 *
 * Returns the atom + a closure that performs the insert — call sites await
 * the closure so the cosine lookup in executeItem sees the seed atom.
 */
function seedHitAtom(
	index: MemoryIndex,
	overrides: Partial<MemoryAtom> = {},
	vector: number[] = V_UNIT,
): { atom: MemoryAtom; insert: () => Promise<void> } {
	const atom: MemoryAtom = {
		id: crypto.randomUUID(),
		type: "fact",
		title: "Seeded hit atom",
		summary: "summary for seeded atom A",
		content: "seeded hit atom A content for cosine test",
		tags: ["pdf"],
		importance: 0.6,
		strength: 0.6,
		access_count: 0,
		version: 1,
		is_latest: 1,
		parent_id: null,
		superseded_at: null,
		archived: 0,
		created_at: Date.now(),
		updated_at: Date.now(),
		last_access: null,
		content_fingerprint: "fp-seed-A",
		source_session: null,
		...overrides,
	};
	return { atom, insert: async () => index.insertAtom(atom, vector) };
}

describe("executeItem — cosine ≥ 0.65 命中 + LLM 二次确认", () => {
	let index: MemoryIndex;
	let tmpDir: string;
	let atomsDir: string;
	// Type-inferred spies — vi.spyOn returns a MockInstance specialised to
	// the spied method's signature, which gives us typed `.mock.calls`.
	let insertSpy: ReturnType<MemoryIndex["insertAtom"] extends (...a: never[]) => unknown ? never : never>;
	let updateSpy: ReturnType<MemoryIndex["updateAtom"] extends (...a: never[]) => unknown ? never : never>;
	let markSupersededSpy: ReturnType<MemoryIndex["markSupersededTx"] extends (...a: never[]) => unknown
		? never
		: never>;

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "exec-item-test-"));
		atomsDir = path.join(tmpDir, "atoms");
		await fs.mkdir(atomsDir, { recursive: true });
		index = new MemoryIndex(":memory:");
		await index.init();
		// Spies are installed here but cleared after each seed so they
		// only observe writes performed by executeItem — not the seed
		// insert itself.
		insertSpy = vi.spyOn(index, "insertAtom") as never;
		updateSpy = vi.spyOn(index, "updateAtom") as never;
		markSupersededSpy = vi.spyOn(index, "markSupersededTx") as never;
	});

	afterEach(async () => {
		index.close();
		await fs.rm(tmpDir, { recursive: true, force: true });
	});

	// Helper: seed an atom and then clear all spy state so subsequent
	// `expect(spy).toHaveBeenCalledTimes(...)` checks count only the
	// writes executeItem performs.
	const seedAndClearSpies = async (overrides: Partial<MemoryAtom> = {}): Promise<MemoryAtom> => {
		const seed = seedHitAtom(index, overrides);
		await seed.insert();
		(insertSpy as unknown as { mockClear: () => void }).mockClear();
		(updateSpy as unknown as { mockClear: () => void }).mockClear();
		(markSupersededSpy as unknown as { mockClear: () => void }).mockClear();
		return seed.atom;
	};

	// (a) — LLM 二次确认 action=update
	it("(a) cosine 0.77 + LLM action='update' + merged → in-place update, version+1, status='update'", async () => {
		await seedAndClearSpies({
			id: "hit-A",
			title: "PDF extraction library",
			summary: "PDF 提取用 pymupdf",
			content: "PDF 提取用 pymupdf 而不是 pdfplumber, 因为 layout 保留更好",
			tags: ["pdf", "image extraction"],
			version: 1,
			content_fingerprint: "fp-A-old",
		});

		// Item embedding cosine 0.77 vs V_UNIT → findMostSimilarEmbedding returns A.
		vi.mocked(embedText).mockResolvedValue(V_COS_077);

		const mergedContent =
			"PDF 提取用 pymupdf 而不是 pdfplumber, 因为 layout 保留更好。\n2026-07 新增 dpi=200 默认值";
		const callLlm = vi.fn(async () =>
			JSON.stringify({
				action: "update",
				merged: {
					title: "PDF extraction library (updated)",
					summary: "PDF 提取用 pymupdf 新 layout 模式",
					content: mergedContent,
					tags: ["pdf", "image extraction", "pymupdf"],
				},
			}),
		);

		const item = makeNewItem({
			title: "PDF extraction library v2",
			summary: "PDF 提取改用 pymupdf + 新的 layout 模式",
			content: "PDF 提取改用 pymupdf 的新 layout 模式, 默认 dpi=200 — different fingerprint",
			tags: ["pdf", "pymupdf"],
		});

		const result = await __testing_executeItem(index, atomsDir, item, callLlm);

		// Status + returned atom match the update semantics. The returned
		// atom reflects the post-update fields (title/summary/content/tags)
		// but its `version` field is the pre-update value because
		// `updateAtom` does `version = version + 1` in SQL — verify the
		// bumped version via the DB row instead.
		expect(result.status).toBe("update");
		expect(result.atom).toBeDefined();
		expect(result.atom?.id).toBe("hit-A");
		expect(result.atom?.title).toBe("PDF extraction library (updated)");
		expect(result.atom?.summary).toBe("PDF 提取用 pymupdf 新 layout 模式");
		expect(result.atom?.content).toBe(mergedContent);
		expect(result.atom?.tags).toEqual(["pdf", "image extraction", "pymupdf"]);
		// Fingerprint recomputed from the new content.
		expect(result.atom?.content_fingerprint).not.toBe("fp-A-old");
		expect(result.atom?.content_fingerprint).toMatch(/^[0-9a-f]{16}$/);
		// DB row carries the version+1 bump from updateAtom's SQL.
		const stored = index.getAtom("hit-A");
		expect(stored?.version).toBe(2);
		expect(stored?.content).toBe(mergedContent);
		expect(stored?.tags).toEqual(["pdf", "image extraction", "pymupdf"]);

		// Write-path spies: updateAtom called, the other two NOT called.
		expect(updateSpy).toHaveBeenCalledTimes(1);
		expect(insertSpy).not.toHaveBeenCalled();
		expect(markSupersededSpy).not.toHaveBeenCalled();

		// callLlm fired exactly once (the LLM dedup-confirm pass).
		expect(callLlm).toHaveBeenCalledTimes(1);
	});

	// (b) — LLM 二次确认 action=supersede
	it("(b) cosine 0.77 + LLM action='supersede' → markSupersededTx, hit archived, status='supersede'", async () => {
		await seedAndClearSpies({
			id: "hit-A",
			title: "扩增子物种注释结果文件路径",
			content: "扩增子物种注释结果文件路径是 /share/data/result.tsv",
			tags: ["扩增子"],
			content_fingerprint: "fp-A-b",
		});

		vi.mocked(embedText).mockResolvedValue(V_COS_077);

		const callLlm = vi.fn(async () => JSON.stringify({ action: "supersede" }));

		const item = makeNewItem({
			title: "扩增子物种注释结果文件",
			summary: "扩增子物种注释结果文件",
			content: "扩增子物种注释结果文件 (vs 路径) — totally different content for fp",
			tags: ["扩增子"],
		});

		const result = await __testing_executeItem(index, atomsDir, item, callLlm);

		expect(result.status).toBe("supersede");
		expect(result.atom).toBeDefined();
		// New atom has its own id (different from A) and parent_id points at A.
		expect(result.atom?.id).not.toBe("hit-A");
		expect(result.atom?.parent_id).toBe("hit-A");
		expect(result.atom?.is_latest).toBe(1);

		// Old atom A was marked superseded.
		const oldAfter = index.getAtom("hit-A");
		expect(oldAfter?.is_latest).toBe(0);
		expect(oldAfter?.superseded_at).not.toBeNull();

		// Write-path spies: only markSupersededTx fired.
		expect(markSupersededSpy).toHaveBeenCalledTimes(1);
		expect(insertSpy).not.toHaveBeenCalled();
		expect(updateSpy).not.toHaveBeenCalled();
	});

	// (c) — LLM 二次确认 action=create
	it("(c) cosine 0.77 + LLM action='create' → hit untouched, new atom inserted, status='create'", async () => {
		await seedAndClearSpies({
			id: "hit-A",
			title: "iCAMP 分组顺序 Skill 注册信息",
			content: "iCAMP 分组顺序 Skill 注册信息 — Skill registration text",
			tags: ["icamp"],
			content_fingerprint: "fp-A-c",
		});

		vi.mocked(embedText).mockResolvedValue(V_COS_077);

		const callLlm = vi.fn(async () => JSON.stringify({ action: "create" }));

		const item = makeNewItem({
			title: "iCAMP 分组柱状图顺序修复",
			summary: "iCAMP 分组柱状图顺序修复",
			content: "iCAMP 分组柱状图顺序修复 — bar chart fix text, different fp",
			tags: ["icamp", "chart"],
		});

		const result = await __testing_executeItem(index, atomsDir, item, callLlm);

		expect(result.status).toBe("create");
		expect(result.atom).toBeDefined();
		// New atom independent of A.
		expect(result.atom?.id).not.toBe("hit-A");
		expect(result.atom?.parent_id).toBeNull();
		expect(result.atom?.is_latest).toBe(1);

		// Hit atom A is untouched (still latest, no superseded_at).
		const oldAfter = index.getAtom("hit-A");
		expect(oldAfter?.is_latest).toBe(1);
		expect(oldAfter?.superseded_at).toBeNull();

		// Write-path spies: only insertAtom fired (for the new atom).
		expect(insertSpy).toHaveBeenCalledTimes(1);
		expect(updateSpy).not.toHaveBeenCalled();
		expect(markSupersededSpy).not.toHaveBeenCalled();
	});

	// (d) — LLM 二次确认 action=skip
	it("(d) cosine 0.77 + LLM action='skip' → 0 inserts, 0 updates, 0 markSuperseded, status='skip'", async () => {
		await seedAndClearSpies({
			id: "hit-A",
			content_fingerprint: "fp-A-d",
		});

		vi.mocked(embedText).mockResolvedValue(V_COS_077);

		const callLlm = vi.fn(async () => JSON.stringify({ action: "skip" }));

		const item = makeNewItem({ content: "different content for fingerprint skip test" });

		const result = await __testing_executeItem(index, atomsDir, item, callLlm);

		expect(result.status).toBe("skip");
		expect(result.atom).toBeDefined();
		// The returned atom on skip is the existing hit.
		expect(result.atom?.id).toBe("hit-A");

		// Hit atom A unchanged.
		const oldAfter = index.getAtom("hit-A");
		expect(oldAfter?.is_latest).toBe(1);
		expect(oldAfter?.superseded_at).toBeNull();
		expect(oldAfter?.version).toBe(1);

		// NONE of the write primitives fired — skip is a pure no-op.
		expect(insertSpy).not.toHaveBeenCalled();
		expect(updateSpy).not.toHaveBeenCalled();
		expect(markSupersededSpy).not.toHaveBeenCalled();
	});

	// (e) — LLM call failure (timeout / non-JSON) → fallback to supersede
	it("(e) cosine 0.77 + LLM call throws AbortError → fallback supersede + console.warn 'fell back to supersede'", async () => {
		await seedAndClearSpies({
			id: "hit-A",
			content_fingerprint: "fp-A-e",
		});

		vi.mocked(embedText).mockResolvedValue(V_COS_077);

		// Simulate an LLM timeout — the LLM closure throws AbortError on every call.
		const abortErr = Object.assign(new Error("timeout"), { name: "AbortError" });
		const callLlm = vi.fn(async () => {
			throw abortErr;
		});

		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

		const item = makeNewItem({ content: "fallback test content different fingerprint" });

		const result = await __testing_executeItem(index, atomsDir, item, callLlm);

		// Conservative fallback: supersede.
		expect(result.status).toBe("supersede");
		expect(result.atom).toBeDefined();
		expect(result.atom?.parent_id).toBe("hit-A");

		// Old atom A marked superseded.
		const oldAfter = index.getAtom("hit-A");
		expect(oldAfter?.is_latest).toBe(0);
		expect(oldAfter?.superseded_at).not.toBeNull();

		// markSupersededTx fired; insert/update did not.
		expect(markSupersededSpy).toHaveBeenCalledTimes(1);
		expect(insertSpy).not.toHaveBeenCalled();
		expect(updateSpy).not.toHaveBeenCalled();

		// Warning surfaces the conservative fallback to the operator.
		const warnMessages = warnSpy.mock.calls.map((c) => String(c[0]));
		expect(warnMessages.some((m) => m.includes("fell back to supersede"))).toBe(true);

		warnSpy.mockRestore();
	});
});

describe("executeItem — cosine < 0.65 不命中", () => {
	let index: MemoryIndex;
	let tmpDir: string;
	let atomsDir: string;
	// Type-inferred spies — vi.spyOn returns a MockInstance specialised to
	// the spied method's signature, which gives us typed `.mock.calls`.
	let insertSpy: ReturnType<MemoryIndex["insertAtom"] extends (...a: never[]) => unknown ? never : never>;
	let updateSpy: ReturnType<MemoryIndex["updateAtom"] extends (...a: never[]) => unknown ? never : never>;
	let markSupersededSpy: ReturnType<MemoryIndex["markSupersededTx"] extends (...a: never[]) => unknown
		? never
		: never>;

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "exec-item-coslow-"));
		atomsDir = path.join(tmpDir, "atoms");
		await fs.mkdir(atomsDir, { recursive: true });
		index = new MemoryIndex(":memory:");
		await index.init();
		insertSpy = vi.spyOn(index, "insertAtom") as never;
		updateSpy = vi.spyOn(index, "updateAtom") as never;
		markSupersededSpy = vi.spyOn(index, "markSupersededTx") as never;
	});

	afterEach(async () => {
		index.close();
		await fs.rm(tmpDir, { recursive: true, force: true });
	});

	// (f) — cosine < 0.65 → no LLM dedup confirm
	it("(f) cosine < 0.65 (no hit) → status='create', callLlm NOT called, only insertAtom fires", async () => {
		// Empty DB so findMostSimilarEmbedding returns null even if we
		// passed a high-cosine embedding.
		vi.mocked(embedText).mockResolvedValue(V_COS_077);

		const callLlm = vi.fn(async () => JSON.stringify({ action: "skip" }));

		const item = makeNewItem({ content: "fresh content, no similar atom in empty DB" });

		const result = await __testing_executeItem(index, atomsDir, item, callLlm);

		expect(result.status).toBe("create");
		expect(result.atom).toBeDefined();
		expect(result.atom?.parent_id).toBeNull();
		expect(result.atom?.is_latest).toBe(1);

		// No cosine hit → no LLM dedup confirm pass.
		expect(callLlm).not.toHaveBeenCalled();

		// Only insertAtom fired; no update / supersede.
		expect(insertSpy).toHaveBeenCalledTimes(1);
		expect(updateSpy).not.toHaveBeenCalled();
		expect(markSupersededSpy).not.toHaveBeenCalled();
	});
});

describe("executeItem — tag normalization", () => {
	let index: MemoryIndex;
	let tmpDir: string;
	let atomsDir: string;
	let warnSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "exec-item-tags-"));
		atomsDir = path.join(tmpDir, "atoms");
		await fs.mkdir(atomsDir, { recursive: true });
		index = new MemoryIndex(":memory:");
		await index.init();
		// Silence the bge-m3 reindex warning (the bge-m3 service isn't
		// running in tests; reindexOneOrWarn logs a warning per write).
		warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
	});

	afterEach(async () => {
		index.close();
		await fs.rm(tmpDir, { recursive: true, force: true });
		warnSpy.mockRestore();
	});

	// (g) — Mixed-case tags → normalised to lowercase ASCII
	it("(g) tags=['Amplicon','16S'] → stored atom has tags=['amplicon','16s'] (lowercased)", async () => {
		// No atom in DB → create path. embedText returns null so we skip
		// the cosine branch entirely and the atom is inserted with zero
		// vector. Tag normalization runs before embed.
		vi.mocked(embedText).mockResolvedValue(null);

		const item = makeNewItem({
			content: "tag normalization test content (g)",
			tags: ["Amplicon", "16S"],
		});

		const result = await __testing_executeItem(index, atomsDir, item);

		expect(result.status).toBe("create");
		expect(result.atom).toBeDefined();
		// normalizeTag without a dictionary does lowercase for ASCII.
		expect(result.atom?.tags).toEqual(["amplicon", "16s"]);

		// Persisted row matches the returned atom.
		const stored = index.getAtom(result.atom!.id);
		expect(stored?.tags).toEqual(["amplicon", "16s"]);
	});

	// (h) — All-proper-noun tags (no concept/*) → warn but still insert
	it("(h) tags=['Amplicon','X101SC'] (no concept/*) → console.warn with 'lacks concept tag', atom stored with normalised tags", async () => {
		vi.mocked(embedText).mockResolvedValue(null);

		const item = makeNewItem({
			content: "tag normalization warn test content (h)",
			tags: ["Amplicon", "X101SC"],
		});

		const result = await __testing_executeItem(index, atomsDir, item);

		expect(result.status).toBe("create");
		expect(result.atom).toBeDefined();
		// Tags still persisted (lowercased) — warn, not reject.
		expect(result.atom?.tags).toEqual(["amplicon", "x101sc"]);

		// console.warn surfaced the "lacks concept tag" diagnostic.
		const warnMessages = warnSpy.mock.calls.map((c) => String(c[0]));
		expect(
			warnMessages.some(
				(m) => m.includes("lacks concept tag") && m.includes("0/2 tags are concept/*"),
			),
		).toBe(true);

		// Persisted row matches.
		const stored = index.getAtom(result.atom!.id);
		expect(stored?.tags).toEqual(["amplicon", "x101sc"]);
	});

	// (i) — Tags include concept/* → no warn, both tags persisted
	it("(i) tags=['amplicon','concept/fix'] → 0 'lacks concept tag' warns, both tags persisted", async () => {
		vi.mocked(embedText).mockResolvedValue(null);

		const item = makeNewItem({
			content: "tag normalization concept tag test content (i)",
			tags: ["amplicon", "concept/fix"],
		});

		const result = await __testing_executeItem(index, atomsDir, item);

		expect(result.status).toBe("create");
		expect(result.atom).toBeDefined();
		expect(result.atom?.tags).toEqual(["amplicon", "concept/fix"]);

		// No "lacks concept tag" diagnostic — conceptTagCount=1.
		const warnMessages = warnSpy.mock.calls.map((c) => String(c[0]));
		expect(warnMessages.some((m) => m.includes("lacks concept tag"))).toBe(false);

		// Persisted row matches.
		const stored = index.getAtom(result.atom!.id);
		expect(stored?.tags).toEqual(["amplicon", "concept/fix"]);
	});
});

describe("buildExtractionPrompt — tagVocabulary injection (executeItem context)", () => {
	// These two cases mirror extraction-prompt.test.ts (a)/(b) for symmetry
	// with the executeItem-focused file — they pin the prompt shape that
	// executeItem's extraction LLM sees when a cosine hit fires and the
	// caller has loaded a tag dictionary. Tag dictionary injection is a
	// precondition for the "LLM emit reuse" downstream of (g)/(h)/(i).

	it("(j) opts.tagVocabulary=['amplicon','16S'] → prompt contains '## 现有 tag 字典' + dict entries joined with comma", async () => {
		// Import here to keep the prompt-builder cases colocated with the
		// executeItem tests without forcing the import to load before the
		// embed mock factory hoists.
		const { buildExtractionPrompt } = await import("../extraction.ts");
		const messages = [{ role: "user", content: "16S amplicon 测序流程" }];
		const prompt = buildExtractionPrompt(messages, { tagVocabulary: ["amplicon", "16S"] });

		expect(prompt).toContain("## 现有 tag 字典");
		expect(prompt).toContain("amplicon, 16S");
	});

	it("(k) opts.tagVocabulary=[] (empty) → prompt does NOT contain '## 现有 tag 字典'", async () => {
		const { buildExtractionPrompt } = await import("../extraction.ts");
		const messages = [{ role: "user", content: "今天天气不错" }];
		const prompt = buildExtractionPrompt(messages, { tagVocabulary: [] });

		expect(prompt).not.toContain("## 现有 tag 字典");
	});
});
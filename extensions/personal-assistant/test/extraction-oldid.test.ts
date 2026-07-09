import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import {
	buildExtractionPrompt,
	executePlan,
	extractionPlanSchema,
	parseExtractionJson,
	EXTRACT_PROMPT_V2,
} from "../extraction.ts";
import { MemoryIndex } from "../storage.ts";
import { embedText } from "../embed.ts";
import type { ExtractionItem, ExtractionPlan } from "../types.ts";

// char-bag mock: gives deterministic vectors so tests don't need a live embedder.
// Hoisted by vitest — applies to every test in this file.
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
			if (norm > 0) {
				for (let i = 0; i < 1024; i++) arr[i] /= norm;
			}
			return arr;
		}),
	};
});

// ---------------------------------------------------------------------------
// Schema: extractionPlanSchema accepts oldId on item rows
// ---------------------------------------------------------------------------

describe("extractionPlanSchema — oldId field", () => {
	it("accepts an item without oldId (create semantics)", () => {
		const r = extractionPlanSchema.safeParse({
			items: [
				{
					type: "rule",
					title: "Create me",
					content: "long enough content body for validation",
					summary: "long enough summary text",
					tags: ["x"],
					importance: 0.5,
				},
			],
		});
		expect(r.success).toBe(true);
	});

	it("accepts an item with oldId (update semantics)", () => {
		const r = extractionPlanSchema.safeParse({
			items: [
				{
					oldId: "00000000-0000-0000-0000-000000000001",
					type: "rule",
					title: "Updated rule",
					content: "long enough content body for validation",
					summary: "long enough summary text",
					tags: ["x"],
					importance: 0.7,
				},
			],
		});
		expect(r.success).toBe(true);
	});

	it("rejects malformed oldId (not a UUID)", () => {
		const r = extractionPlanSchema.safeParse({
			items: [
				{
					oldId: "not-a-uuid",
					type: "rule",
					title: "Bad",
					content: "long enough content body for validation",
					summary: "long enough summary text",
					tags: ["x"],
					importance: 0.5,
				},
			],
		});
		expect(r.success).toBe(false);
	});

	it("EXTRACT_PROMPT_V2 documents oldId in the schema sample", () => {
		// Output Schema section must mention oldId so the LLM knows the field exists.
		expect(EXTRACT_PROMPT_V2).toMatch(/"oldId"/);
	});

	it("EXTRACT_PROMPT_V2 explains update vs create behaviour with oldId", () => {
		// 主动更新 section must reference oldId for the LLM to know which field
		// to set when merging into an existing atom.
		expect(EXTRACT_PROMPT_V2).toMatch(/oldId/);
	});
});

// ---------------------------------------------------------------------------
// buildExtractionPrompt — recalledAtoms rendering with id
// ---------------------------------------------------------------------------

describe("buildExtractionPrompt — recalledAtoms rendering", () => {
	const sampleAtom = (overrides: Partial<{
		id: string;
		type: "rule" | "fact" | "process";
		title: string;
		summary: string;
		content: string;
		path: string;
	}> = {}) => ({
		id: "11111111-1111-1111-1111-111111111111",
		type: "fact" as const,
		title: "Sample Atom",
		summary: "Sample summary",
		content: "Sample content body",
		path: "/home/u/.pi/agent/memory/fact/11111111-1111-1111-1111-111111111111.md",
		...overrides,
	});

	it("rendered corpus includes each atom's id for update targeting", () => {
		const prompt = buildExtractionPrompt(
			[{ role: "user", content: "test message" }],
			{
				recalledAtoms: [
					sampleAtom(),
					sampleAtom({
						id: "22222222-2222-2222-2222-222222222222",
						title: "Second atom",
						summary: "second summary",
					}),
				],
			},
		);
		expect(prompt).toContain("11111111-1111-1111-1111-111111111111");
		expect(prompt).toContain("22222222-2222-2222-2222-222222222222");
	});

	it("rendered corpus includes type + title + summary + content + path per atom", () => {
		const prompt = buildExtractionPrompt(
			[],
			{
				recalledAtoms: [
					sampleAtom({
						title: "PDF library",
						summary: "uses pymupdf",
						path: "/home/u/.pi/agent/memory/fact/<uuid>.md",
					}),
				],
			},
		);
		expect(prompt).toContain("PDF library");
		expect(prompt).toContain("uses pymupdf");
		expect(prompt).toContain("pymupdf");
		expect(prompt).toContain("Sample content body");
		expect(prompt).toContain("/home/u/.pi/agent/memory/fact/<uuid>.md");
	});

	it("content is truncated at CONTENT_PREVIEW_CHARS with a marker", () => {
		const long = "x".repeat(1000);
		const prompt = buildExtractionPrompt(
			[],
			{ recalledAtoms: [sampleAtom({ content: long })] },
		);
		// Long content must end with the "截断" marker (NOT full 1000-char string).
		expect(prompt).toMatch(/\[\u2026\(截断.{0,40}\)\]/);
		expect(prompt).not.toContain(long);
	});

	it("omits corpus section when recalledAtoms is empty/undefined", () => {
		const prompt = buildExtractionPrompt([{ role: "user", content: "hi" }]);
		// The prompt instruction text "## 已有知识库 (重要! 不要重复提取已有知识)"
		// lives in EXTRACT_PROMPT_V2 (always present). What we assert here
		// is the absence of the rendered corpus section header
		// "## 高相关已有知识库 (recall top-K, ...)".
		expect(prompt).not.toMatch(/## 高相关已有知识库/);
	});
});

// ---------------------------------------------------------------------------
// executePlan — update-by-oldId path
// ---------------------------------------------------------------------------

describe("executePlan — LLM-driven update by oldId", () => {
	let index: MemoryIndex;
	let tmpDir: string;
	let atomsDir: string;
	let dbPath: string;

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "extract-oldid-"));
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

	const seed = async (item: ExtractionItem): Promise<string> => {
		const r = await executePlan(index, atomsDir, {
			items: [{ item, status: "create" }],
			modelUsed: "test",
			generatedAt: Date.now(),
		});
		expect(r.created).toHaveLength(1);
		return r.created[0].id;
	};

	it("LLM item with oldId -> merges into existing atom (no cosine gate)", async () => {
		// Seed an atom.
		const oldId = await seed({
			type: "rule",
			title: "TS strict",
			content: "User prefers TypeScript strict mode in all projects.",
			summary: "TS strict 偏好",
			tags: ["typescript"],
			importance: 0.7,
		});
		expect(index.getAtom(oldId)?.title).toBe("TS strict");

		// Plan with an LLM item that:
		//   - has a totally DIFFERENT content (so cosine would NOT fire)
		//   - but has oldId pointing at the seed atom
		const itemWithOldId: ExtractionItem & { oldId?: string } = {
			type: "rule",
			title: "TS strict + ESLint",
			content:
				"User prefers TypeScript strict mode in all projects.\n2026-07 新增 ESLint 强制",
			summary: "TS strict 偏好 + ESLint",
			tags: ["typescript", "eslint"],
			importance: 0.8,
			oldId,
		};

		// Use a plan-shape wrapper that lets us pass the extended item.
		const plan = {
			items: [{ item: itemWithOldId, status: "create" as const }],
			modelUsed: "test",
			generatedAt: Date.now(),
		};

		const result = await executePlan(index, atomsDir, plan);
		// Should route to "update" bucket, NOT create a new atom.
		expect(result.created).toHaveLength(0);
		expect(result.updated).toHaveLength(1);
		// `updated` may or may not exist on the current type — check the DB
		// state instead: the seed atom should now carry the merged content.
		const after = index.getAtom(oldId);
		expect(after).not.toBeNull();
		expect(after?.title).toBe("TS strict + ESLint");
		expect(after?.content).toContain("ESLint 强制");
		expect(after?.tags).toEqual(["typescript", "eslint"]);
		// id preserved (in-place update, not a new atom).
		expect(after?.id).toBe(oldId);
	});

	it("LLM item with unknown oldId -> warn log + fallback to create", async () => {
		const bogusId = "00000000-0000-0000-0000-deadbeefcafe";
		const itemWithBogusId: ExtractionItem & { oldId?: string } = {
			type: "rule",
			title: "Brand new",
			content: "Entirely new content for a brand new atom body.",
			summary: "new",
			tags: ["newconcept"],
			importance: 0.5,
			oldId: bogusId,
		};
		const plan = {
			items: [{ item: itemWithBogusId, status: "create" as const }],
			modelUsed: "test",
			generatedAt: Date.now(),
		};
		const result = await executePlan(index, atomsDir, plan);
		// Falls through to create since oldId wasn't found.
		expect(result.created).toHaveLength(1);
		expect(result.created[0].id).not.toBe(bogusId);
	});

	it("item without oldId still goes through create path (no behaviour change)", async () => {
		const item: ExtractionItem = {
			type: "rule",
			title: "Plain new",
			content: "No oldId field set, should be created from scratch body.",
			summary: "plain",
			tags: ["newconcept"],
			importance: 0.5,
		};
		const result = await executePlan(index, atomsDir, {
			items: [{ item, status: "create" }],
			modelUsed: "test",
			generatedAt: Date.now(),
		});
		expect(result.created).toHaveLength(1);
		expect(result.created[0].title).toBe("Plain new");
	});

	it("fingerprint exact dedup still works for create (no oldId)", async () => {
		const sharedContent = "Exact same body for fingerprint dedup coverage test path one.";
		const a = await executePlan(index, atomsDir, {
			items: [
				{
					item: {
						type: "rule",
						title: "A1",
						content: sharedContent,
						summary: "first attempt",
						tags: ["fc"],
						importance: 0.5,
					},
					status: "create",
				},
			],
			modelUsed: "test",
			generatedAt: Date.now(),
		});
		expect(a.created).toHaveLength(1);

		const b = await executePlan(index, atomsDir, {
			items: [
				{
					item: {
						type: "rule",
						title: "A2",
						content: sharedContent,
						summary: "second attempt",
						tags: ["fc"],
						importance: 0.5,
					},
					status: "create",
				},
			],
			modelUsed: "test",
			generatedAt: Date.now(),
		});
		expect(b.skipped).toHaveLength(1);
		expect(b.created).toHaveLength(0);
	});
});

// ---------------------------------------------------------------------------
// parseExtractionJson — round-trip through new schema
// ---------------------------------------------------------------------------

describe("parseExtractionJson — oldId round-trip", () => {
	it("returns a result with oldId preserved when present", () => {
		const json = JSON.stringify({
			items: [
				{
					oldId: "00000000-0000-0000-0000-000000000001",
					type: "rule",
					title: "T",
					content: "long enough content body for parse round-trip",
					summary: "long enough summary",
					tags: ["x"],
					importance: 0.5,
				},
			],
		});
		const r = parseExtractionJson(json);
		expect(r).not.toBeNull();
		// The extraction schema passthrough keeps oldId on the parsed object —
		// confirms the LLM-emitted id survives parse and reaches executeItem.
		const item = (r!.items[0] as { oldId?: string });
		expect(item.oldId).toBe("00000000-0000-0000-0000-000000000001");
	});
});

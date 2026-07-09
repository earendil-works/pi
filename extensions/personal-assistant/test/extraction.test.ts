import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { executePlan, parseExtractionJson } from "../extraction.ts";
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

describe("executePlan — create / skip / fingerprint dedup", () => {
	let index: MemoryIndex;
	let tmpDir: string;
	let atomsDir: string;
	let dbPath: string;

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "extraction-test-"));
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

	const makeItem = (overrides: Partial<ExtractionItem> = {}): ExtractionItem => ({
		type: "rule",
		title: "Test Rule",
		content: "User prefers TypeScript strict mode in all projects.",
		summary: "TS strict preference",
		tags: ["typescript"],
		importance: 0.7,
		...overrides,
	});

	const makePlan = (items: ExtractionItem[]): ExtractionPlan => ({
		items: items.map((item) => ({ item, status: "create" })),
		modelUsed: "test-model",
		generatedAt: Date.now(),
	});

	it("creates a new atom when no existing atom has matching fingerprint", async () => {
		const plan = makePlan([makeItem({ title: "New Rule" })]);
		const result = await executePlan(index, atomsDir, plan);
		expect(result.created).toHaveLength(1);
		expect(result.updated).toHaveLength(0);
		expect(result.skipped).toHaveLength(0);
	});

	it("persists the created atom in memory_index", async () => {
		const plan = makePlan([makeItem({ title: "Persisted", content: "Unique persisted content for verification" })]);
		const result = await executePlan(index, atomsDir, plan);
		expect(result.created).toHaveLength(1);
		const atom = result.created[0];
		const got = index.getAtom(atom.id);
		expect(got).not.toBeNull();
		expect(got?.title).toBe("Persisted");
		expect(got?.is_latest).toBe(1);
	});

	it("writes .md file for created atom", async () => {
		const plan = makePlan([makeItem({ title: "New", content: "New content here for file write" })]);
		const result = await executePlan(index, atomsDir, plan);
		const atom = result.created[0];
		const filePath = path.join(atomsDir, atom.type, `${atom.id}.md`);
		const exists = await fs.stat(filePath).then(() => true).catch(() => false);
		expect(exists).toBe(true);
	});

	it("skips when exact fingerprint match exists", async () => {
		const existing = makeItem({ content: "Identical content for fingerprint test", title: "T1" });
		const plan1 = makePlan([existing]);
		await executePlan(index, atomsDir, plan1);

		// Same content, different title — fingerprint should match and skip.
		const plan2 = makePlan([makeItem({ content: "Identical content for fingerprint test", title: "T2" })]);
		const result = await executePlan(index, atomsDir, plan2);
		expect(result.skipped).toHaveLength(1);
		expect(result.created).toHaveLength(0);
	});

	it("similar content does NOT auto-supersede (no cosine gate)", async () => {
		// Insert first atom.
		await executePlan(
			index,
			atomsDir,
			makePlan([makeItem({ content: "User prefers TypeScript strict mode in all projects", title: "Old" })]),
		);

		// Even with near-identical content the new plan must NOT trigger any
		// superseded bucket (it doesn't exist). Without oldId the second item
		// becomes a fresh create, not an in-place update — relying on the LLM
		// to emit oldId for true merges.
		const result = await executePlan(
			index,
			atomsDir,
			makePlan([makeItem({ content: "User prefers TypeScript strict mode in all project", title: "New" })]),
		);
		expect(result.created).toHaveLength(1);
		expect(result.updated).toHaveLength(0);
		expect(result.skipped).toHaveLength(0);
	});

	it("processes multiple items in a single plan", async () => {
		const plan = makePlan([
			makeItem({ title: "Item A", content: "First item content for multi-test" }),
			makeItem({ title: "Item B", content: "Second item content for multi-test" }),
			makeItem({ title: "Item C", content: "Third item content for multi-test" }),
		]);
		const result = await executePlan(index, atomsDir, plan);
		expect(result.created.length + result.updated.length + result.skipped.length).toBe(3);
	});

	it("handles empty plan gracefully", async () => {
		const plan = makePlan([]);
		const result = await executePlan(index, atomsDir, plan);
		expect(result.created).toHaveLength(0);
		expect(result.updated).toHaveLength(0);
		expect(result.skipped).toHaveLength(0);
	});

	it("tolerates embedding failure: still writes .md file", async () => {
		vi.mocked(embedText).mockResolvedValueOnce(null);

		const plan = makePlan([makeItem({ title: "NoEmbed", content: "Content when embedder is down" })]);
		const result = await executePlan(index, atomsDir, plan);
		expect(result.created.length).toBeGreaterThanOrEqual(1);
		const atom = result.created[0];
		expect(atom).toBeDefined();
		const filePath = path.join(atomsDir, atom.type, `${atom.id}.md`);
		const exists = await fs.stat(filePath).then(() => true).catch(() => false);
		expect(exists).toBe(true);
	});
});

describe("parseExtractionJson", () => {
	it("returns null on invalid JSON", () => {
		expect(parseExtractionJson("not json")).toBeNull();
	});

	it("returns null on empty object (missing required items)", () => {
		expect(parseExtractionJson("{}")).toBeNull();
	});

	it("returns null on schema violation (invalid type)", () => {
		expect(parseExtractionJson(JSON.stringify({ items: [{ type: "invalid" }] }))).toBeNull();
	});

	it("returns null on items failing field validators (content too short)", () => {
		const bad = {
			items: [{ type: "rule", title: "T", content: "x", summary: "abcde", tags: ["x"], importance: 0.5 }],
		};
		expect(parseExtractionJson(JSON.stringify(bad))).toBeNull();
	});

	it("parses valid extraction JSON", () => {
		const valid = {
			items: [
				{
					type: "rule",
					title: "T",
					content: "long enough content here for validation",
					summary: "long enough summary",
					tags: ["x"],
					importance: 0.5,
				},
			],
		};
		const result = parseExtractionJson(JSON.stringify(valid));
		expect(result).not.toBeNull();
		expect(result!.items).toHaveLength(1);
		expect(result!.items[0].type).toBe("rule");
	});

	it("returns null on completely malformed input", () => {
		expect(parseExtractionJson("")).toBeNull();
		expect(parseExtractionJson("{")).toBeNull();
	});
});

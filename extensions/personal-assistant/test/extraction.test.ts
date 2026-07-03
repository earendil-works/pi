import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { executePlan, parseExtractionJson } from "../extraction.ts";
import { MemoryIndex } from "../storage.ts";
import { embedText } from "../embed.ts";
import type { ExtractionItem, ExtractionPlan } from "../types.ts";

// Mock embed.ts so tests don't require a live ollama. The mock factory must be
// hoisted (vitest hoists vi.mock calls to the top of the file), so it applies
// to every test in this file.
//
// Why char-bag instead of a position-based hash: storage.findMostSimilarEmbedding
// converts sqlite-vec's L2 distance to cosine via `1 - distance/2`. That formula
// is exact only when the true cosine is close to 1 (which it isn't, in general).
// To make the supersede threshold (0.92) reachable in tests without standing up
// a real embedder, the mock needs to produce vectors whose true cosine is in the
// 0.99+ range for "similar" texts — and that requires aggregating by character
// (so lexical overlap dominates the comparison) plus L2 normalization (so the
// formula maps back to a usable cosine value).
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

describe("executePlan", () => {
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

	it("creates a new atom when no existing similar atom", async () => {
		const plan = makePlan([makeItem({ title: "New Rule" })]);
		const result = await executePlan(index, atomsDir, plan);
		expect(result.created).toHaveLength(1);
		expect(result.superseded).toHaveLength(0);
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

	it("supersedes when similar atom found above threshold", async () => {
		// Insert first atom.
		await executePlan(
			index,
			atomsDir,
			makePlan([makeItem({ content: "User prefers TypeScript strict mode in all projects", title: "Old" })]),
		);

		// Very similar content (single-char drop at end) clears the threshold
		// in the char-bag mock and triggers the supersede path.
		const result = await executePlan(
			index,
			atomsDir,
			makePlan([makeItem({ content: "User prefers TypeScript strict mode in all project", title: "New" })]),
		);
		expect(result.superseded.length).toBeGreaterThanOrEqual(1);
		expect(result.created).toHaveLength(0);
	});

	it("transfers signals when superseding (new atom inherits access_count etc.)", async () => {
		// Insert first atom, bump its access_count, then supersede.
		const first = makeItem({ content: "Database uses PostgreSQL with connection pooling", title: "v1" });
		const r1 = await executePlan(index, atomsDir, makePlan([first]));
		const oldId = r1.created[0].id;
		index.updateAccess(oldId);
		index.updateAccess(oldId);
		expect(index.getAtom(oldId)?.access_count).toBe(2);

		// Similar content triggers supersede.
		const result = await executePlan(
			index,
			atomsDir,
			makePlan([makeItem({ content: "Database uses PostgreSQL with connection pool", title: "v2" })]),
		);
		expect(result.superseded.length).toBeGreaterThanOrEqual(1);
		const sup = result.superseded[0];
		expect(sup).toBeDefined();
		const newAtom = sup.newAtom;
		expect(newAtom.access_count).toBe(2);
	});

	it("processes multiple items in a single plan", async () => {
		const plan = makePlan([
			makeItem({ title: "Item A", content: "First item content for multi-test" }),
			makeItem({ title: "Item B", content: "Second item content for multi-test" }),
			makeItem({ title: "Item C", content: "Third item content for multi-test" }),
		]);
		const result = await executePlan(index, atomsDir, plan);
		expect(result.created.length + result.superseded.length + result.skipped.length).toBe(3);
	});

	it("handles empty plan gracefully", async () => {
		const plan = makePlan([]);
		const result = await executePlan(index, atomsDir, plan);
		expect(result.created).toHaveLength(0);
		expect(result.superseded).toHaveLength(0);
		expect(result.skipped).toHaveLength(0);
	});

	it("returns superseded entry with newAtom populated", async () => {
		await executePlan(
			index,
			atomsDir,
			makePlan([makeItem({ content: "Initial fact about Python type hints", title: "v1" })]),
		);
		const result = await executePlan(
			index,
			atomsDir,
			makePlan([makeItem({ content: "Initial fact about Python type hint.", title: "v2" })]),
		);
		expect(result.superseded.length).toBeGreaterThanOrEqual(1);
		const entry = result.superseded[0];
		expect(entry.newAtom.id).toBeTruthy();
		expect(entry.newAtom.is_latest).toBe(1);
		// oldId must point at the SUPERSEDED atom (the one being replaced),
		// not at the new item's title. The superseded atom is the one in
		// `index.getActiveAtoms()` BEFORE this second executePlan ran.
		expect(entry.oldId).toBeTruthy();
		expect(entry.oldId).not.toBe(entry.newAtom.id);
		expect(entry.oldId).not.toBe("v2");
	});

	it("tolerates embedding failure: still writes .md file", async () => {
		// Force embedText to return null for this single call (simulates ollama down).
		vi.mocked(embedText).mockResolvedValueOnce(null);

		const plan = makePlan([makeItem({ title: "NoEmbed", content: "Content when embedder is down" })]);
		const result = await executePlan(index, atomsDir, plan);
		// Should still create (just without vector).
		expect(result.created.length).toBeGreaterThanOrEqual(1);
		const atom = result.created[0];
		expect(atom).toBeDefined();
		const filePath = path.join(atomsDir, atom.type, `${atom.id}.md`);
		const exists = await fs.stat(filePath).then(() => true).catch(() => false);
		expect(exists).toBe(true);
	});

	// -------------------------------------------------------------------------
	// Task 3.7: LLM 二次确认 dedup path (callLlm signature forwarding)
	// -------------------------------------------------------------------------
	// When callLlm is provided AND a cosine ≥ 0.65 hit exists, executeItem must
	// defer to confirmDedupAction(callLlm, hit, newItem, cosine) and route the
	// returned action into the correct result bucket. This pair of tests
	// exercises the "update" and "skip" actions end-to-end through executePlan.
	//
	// Setup: pre-seed an atom via executePlan (no callLlm, so legacy supersede
	// path runs and creates the atom cleanly), then add a similar-content item
	// with callLlm provided. The charBag mock produces a near-identical vector
	// for the second item so the cosine gate fires.

	it("LLM 二次确认 action=update — updates existing atom fields", async () => {
		// Seed: similar content so cosine ≥ 0.65 in the charBag mock.
		await executePlan(
			index,
			atomsDir,
			makePlan([makeItem({ content: "User prefers TypeScript strict mode in all projects", title: "Old TS" })]),
		);

		const callLlm = vi.fn(async (_prompt: string) =>
			JSON.stringify({
				action: "update",
				merged: {
					title: "TS strict preference (updated)",
					summary: "TS strict 偏好, 配合 ESLint 强制",
					content: "User prefers TypeScript strict mode in all projects.\n2026-07 新增 ESLint 强制",
					tags: ["typescript", "eslint"],
				},
			}),
		);

		// Cast executePlan — Task 3.7 extends the signature with a 4th callLlm
		// arg + an `updated` bucket; this test exercises the new shape.
		// The cast is a future-compat guard — once the implementation lands
		// the cast is a no-op, but it keeps the test self-documenting.
		const execPlanWithLlm = executePlan as unknown as (
			i: typeof index,
			d: string,
			p: ExtractionPlan,
			c?: typeof callLlm,
		) => Promise<{
			created: unknown[];
			superseded: unknown[];
			updated: Array<{ oldId: string; newAtom: { id: string; title: string; content: string; tags: string[] } }>;
			skipped: unknown[];
		}>;
		const result = await execPlanWithLlm(
			index,
			atomsDir,
			makePlan([makeItem({ content: "User prefers TypeScript strict mode in all project", title: "New TS" })]),
			callLlm,
		);

		// Forwarded: callLlm was invoked exactly once (proves the parameter
		// reaches the cosine-hit branch in executeItem).
		expect(callLlm).toHaveBeenCalledTimes(1);
		// Update routed to the `updated` bucket; nothing created/skipped/superseded.
		expect(result.updated).toHaveLength(1);
		expect(result.created).toHaveLength(0);
		expect(result.skipped).toHaveLength(0);
		expect(result.superseded).toHaveLength(0);
		// Merged atom carries the LLM-supplied content.
		const updated = result.updated[0]?.newAtom;
		expect(updated).toBeDefined();
		expect(updated?.title).toBe("TS strict preference (updated)");
		expect(updated?.content).toContain("ESLint 强制");
		expect(updated?.tags).toEqual(["typescript", "eslint"]);
		// oldId must equal the updated atom's id (in-place rewrite keeps the id).
		expect(result.updated[0]?.oldId).toBe(updated?.id);
	});

	it("LLM 二次确认 action=skip — drops the new item, no new row written", async () => {
		// Seed: create the atom that will be hit.
		const seeded = await executePlan(
			index,
			atomsDir,
			makePlan([makeItem({ content: "Database uses PostgreSQL with connection pooling", title: "DB Old" })]),
		);
		const seededId = seeded.created[0]!.id;

		const callLlm = vi.fn(async () => JSON.stringify({ action: "skip" }));

		const execPlanWithLlm = executePlan as unknown as (
			a: typeof index,
			b: string,
			c: ExtractionPlan,
			d?: typeof callLlm,
		) => Promise<{
			created: unknown[];
			superseded: unknown[];
			updated: unknown[];
			skipped: Array<{ id: string }>;
		}>;
		const result = await execPlanWithLlm(
			index,
			atomsDir,
			makePlan([makeItem({ content: "Database uses PostgreSQL with connection pool", title: "DB New" })]),
			callLlm,
		);

		expect(callLlm).toHaveBeenCalledTimes(1);
		// Skip routed to the `skipped` bucket; nothing created/superseded/updated.
		expect(result.skipped).toHaveLength(1);
		expect(result.created).toHaveLength(0);
		expect(result.superseded).toHaveLength(0);
		expect(result.updated).toHaveLength(0);
		// The skipped atom is the seeded one (its id is what we return).
		expect(result.skipped[0]?.id).toBe(seededId);
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
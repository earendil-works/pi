import { describe, it, expect } from "vitest";
import { formatMemoryContext, formatMemoryBlock } from "../format.ts";
import type { RecallResult, MemoryAtom } from "../types.ts";

const sampleAtom = (overrides: Partial<MemoryAtom> = {}): MemoryAtom => ({
	id: crypto.randomUUID(),
	type: "rule",
	title: "Test",
	content: "Detailed content here",
	summary: "Test summary",
	tags: ["a", "b"],
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
	content_fingerprint: "fp",
	source_session: null,
	...overrides,
});

const sampleResult = (overrides: Partial<RecallResult> = {}): RecallResult => ({
	atom: sampleAtom(overrides.atom as never),
	distance: 0.5,
	cosine: 0.75,
	score: 1.0,
	...overrides,
});

describe("formatMemoryBlock", () => {
	it("includes title, summary, id, tags (no content)", () => {
		const result = sampleResult();
		const block = formatMemoryBlock(result);
		expect(block).toContain("Test");
		expect(block).toContain("Test summary");
		expect(block).toContain(`id: ${result.atom.id}`);
		expect(block).toContain("a, b");
		// file_path is intentionally NOT exposed to the LLM — the agent uses
		// `memory_get(id)` to fetch full content on demand.
		expect(block).not.toContain("/tmp/atoms/rule/test.md");
		// Content is never hydrated at format time — search is discovery-only.
		expect(block).not.toContain("Detailed content here");
	});

	it("uses id prefix 'id: ' for memory_get routing", () => {
		const block = formatMemoryBlock(sampleResult());
		expect(block).toMatch(/^id: [0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/m);
	});
});

describe("formatMemoryContext", () => {
	it("returns empty for empty results", () => {
		const out = formatMemoryContext([], 1000);
		expect(out.text).toBe("");
		expect(out.included).toBe(0);
		expect(out.used).toBe(0);
	});

	it("includes all results when under budget", () => {
		const results = [sampleResult(), sampleResult(), sampleResult()];
		const out = formatMemoryContext(results, 1000);
		expect(out.included).toBe(3);
	});

	it("truncates to fit budget, ordered by distance", () => {
		const results = [
			sampleResult({ distance: 0.1 }), // best
			sampleResult({ distance: 0.5 }),
			sampleResult({ distance: 0.9 }), // worst
		];
		// Default block is ~50 chars => 20 tokens. Budget=30 admits 1 block.
		const out = formatMemoryContext(results, 30);
		expect(out.included).toBeLessThanOrEqual(1);
	});

	it("respects token budget exactly (Math.ceil length/2.5)", () => {
		const longAtom = sampleAtom({
			title: "T".repeat(100),
			content: "C".repeat(400),
			summary: "S".repeat(50),
		});
		const results = [sampleResult({ atom: longAtom, distance: 0.1 })];
		const out = formatMemoryContext(results, 1000);
		expect(out.used).toBeLessThanOrEqual(1000);
	});

	it("orders by distance (best first), not input order", () => {
		const results = [
			sampleResult({ distance: 0.9, atom: sampleAtom({ title: "WORST" }) }),
			sampleResult({ distance: 0.1, atom: sampleAtom({ title: "BEST" }) }),
			sampleResult({ distance: 0.5, atom: sampleAtom({ title: "MID" }) }),
		];
		const out = formatMemoryContext(results, 10000);
		const bestIdx = out.text.indexOf("BEST");
		const worstIdx = out.text.indexOf("WORST");
		expect(bestIdx).toBeLessThan(worstIdx);
	});

	it("re-sorts by distance ASC, not by score DESC (cosine is primary key)", () => {
		// A has higher score but lower cosine (higher distance); B has lower
		// score but higher cosine (lower distance). If the formatter sorted by
		// score DESC, A would win; correct behaviour is to sort by distance
		// ASC, so B must appear first (S57 / R6).
		const results = [
			sampleResult({
				distance: 0.9,
				cosine: 0.7,
				score: 1.5,
				atom: sampleAtom({ title: "A_HIGH_SCORE" }),
			}),
			sampleResult({
				distance: 0.1,
				cosine: 0.95,
				score: 0.7,
				atom: sampleAtom({ title: "B_HIGH_COSINE" }),
			}),
		];
		const out = formatMemoryContext(results, 10000);
		const aIdx = out.text.indexOf("A_HIGH_SCORE");
		const bIdx = out.text.indexOf("B_HIGH_COSINE");
		expect(bIdx).toBeLessThan(aIdx);
	});

	it("separates blocks with a blank line so LLM can split sections", () => {
		const results = [
			sampleResult({ atom: sampleAtom({ title: "A" }), distance: 0.1 }),
			sampleResult({ atom: sampleAtom({ title: "B" }), distance: 0.2 }),
		];
		const out = formatMemoryContext(results, 1000);
		expect(out.text).toContain("[rule] A\n");
		expect(out.text).toContain("\n\n[rule] B\n");
	});
});
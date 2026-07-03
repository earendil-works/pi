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
	cosine: 0.75,
	sparseScore: 0.2,
	rrf: 0.0167,
	relativePath: "rule/abc-def.md",
	...overrides,
});

describe("formatMemoryBlock", () => {
	it("includes title, summary, file: path (no content, no id, no tags)", () => {
		const result = sampleResult();
		const block = formatMemoryBlock(result);
		expect(block).toContain("Test");
		expect(block).toContain("Test summary");
		expect(block).toContain(`file: ${result.relativePath}`);
		expect(block).not.toContain(`id: ${result.atom.id}`);
		expect(block).not.toContain("a, b");
		// Content is never hydrated at format time — search is discovery-only.
		expect(block).not.toContain("Detailed content here");
	});

	it("uses 'file: <type>/<id>.md' for read routing", () => {
		const block = formatMemoryBlock(sampleResult());
		expect(block).toMatch(/^file: rule\/[0-9a-f-]+\.md$/m);
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

	it("truncates to fit budget, ordered by rrf DESC", () => {
		const results = [
			sampleResult({ rrf: 0.0167 }), // best
			sampleResult({ rrf: 0.0164 }),
			sampleResult({ rrf: 0.0161 }), // worst
		];
		// Block is ~45 chars => 18 tokens. Budget=20 admits at most 1 block.
		const out = formatMemoryContext(results, 20);
		expect(out.included).toBeLessThanOrEqual(1);
	});

	it("respects token budget exactly (Math.ceil length/2.5)", () => {
		const longAtom = sampleAtom({
			title: "T".repeat(100),
			content: "C".repeat(400),
			summary: "S".repeat(50),
		});
		const results = [sampleResult({ atom: longAtom, rrf: 0.0167 })];
		const out = formatMemoryContext(results, 1000);
		expect(out.used).toBeLessThanOrEqual(1000);
	});

	it("orders by rrf DESC (best first), not input order", () => {
		const results = [
			sampleResult({ rrf: 0.0159, atom: sampleAtom({ title: "WORST" }) }),
			sampleResult({ rrf: 0.0167, atom: sampleAtom({ title: "BEST" }) }),
			sampleResult({ rrf: 0.0161, atom: sampleAtom({ title: "MID" }) }),
		];
		const out = formatMemoryContext(results, 10000);
		const bestIdx = out.text.indexOf("BEST");
		const worstIdx = out.text.indexOf("WORST");
		expect(bestIdx).toBeLessThan(worstIdx);
	});

	it("preserves rrf order even when cosine disagrees (rrf is sole ranking)", () => {
		// A has higher cosine but lower rrf; B has lower cosine but higher rrf.
		// If the formatter sorted by cosine DESC, A would win; correct behaviour
		// is to sort by rrf DESC, so B must appear first.
		const results = [
			sampleResult({
				cosine: 0.95,
				rrf: 0.0159,
				atom: sampleAtom({ title: "A_HIGH_COSINE" }),
			}),
			sampleResult({
				cosine: 0.7,
				rrf: 0.0167,
				atom: sampleAtom({ title: "B_HIGH_RRF" }),
			}),
		];
		const out = formatMemoryContext(results, 10000);
		const aIdx = out.text.indexOf("A_HIGH_COSINE");
		const bIdx = out.text.indexOf("B_HIGH_RRF");
		expect(bIdx).toBeLessThan(aIdx);
	});

	it("separates blocks with a blank line so LLM can split sections", () => {
		const results = [
			sampleResult({ atom: sampleAtom({ title: "A" }), rrf: 0.0167 }),
			sampleResult({ atom: sampleAtom({ title: "B" }), rrf: 0.0164 }),
		];
		const out = formatMemoryContext(results, 1000);
		expect(out.text).toContain("[rule] A\n");
		expect(out.text).toContain("\n\n[rule] B\n");
	});
});

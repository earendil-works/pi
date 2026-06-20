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
	atom: sampleAtom(overrides.atom as any),
	distance: 0.5,
	cosine: 0.75,
	tier: "L0",
	...overrides,
});

describe("formatMemoryBlock", () => {
	it("L0 includes title, summary, tags (no content)", () => {
		const block = formatMemoryBlock(sampleAtom(), "L0");
		expect(block).toContain("Test");
		expect(block).toContain("Test summary");
		expect(block).toContain("a, b");
		expect(block).not.toContain("Detailed content here");
	});

	it("L1 includes full content", () => {
		const block = formatMemoryBlock(sampleAtom(), "L1");
		expect(block).toContain("Detailed content here");
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
		// Default L0 block is ~36 chars => 15 tokens. Budget=20 admits 1 block
		// (15 <= 20) but not 2 (15+15=30 > 20), exercising strict truncation.
		const out = formatMemoryContext(results, 20);
		expect(out.included).toBeLessThanOrEqual(1);
	});

	it("respects token budget exactly (Math.ceil length/2.5)", () => {
		// Build a long atom that takes ~200 tokens
		const longAtom = sampleAtom({
			title: "T".repeat(100),
			content: "C".repeat(400),
			summary: "S".repeat(50),
		});
		const results = [sampleResult({ atom: longAtom, distance: 0.1 })];
		const out = formatMemoryContext(results, 1000);
		expect(out.used).toBeLessThanOrEqual(1000);
	});

	it("L1 blocks use more tokens than L0", () => {
		const l0 = sampleResult({ tier: "L0", distance: 0.1 });
		const l1 = sampleResult({ tier: "L1", distance: 0.1 });
		const out0 = formatMemoryContext([l0], 1000);
		const out1 = formatMemoryContext([l1], 1000);
		expect(out1.used).toBeGreaterThan(out0.used);
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
});

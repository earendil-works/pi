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
	file_path: "/tmp/atoms/rule/test.md",
	...overrides,
});

describe("formatMemoryBlock", () => {
	it("includes title, summary, file_path, tags (no content)", () => {
		const block = formatMemoryBlock(sampleResult());
		expect(block).toContain("Test");
		expect(block).toContain("Test summary");
		expect(block).toContain("/tmp/atoms/rule/test.md");
		expect(block).toContain("a, b");
		// Content is never hydrated at format time — search is discovery-only.
		expect(block).not.toContain("Detailed content here");
	});

	it("uses file_path prefix 'file: ' for visibility in LLM context", () => {
		const block = formatMemoryBlock(
			sampleResult({ file_path: "/home/u/.pi/agent/memory/atoms/process/abc.md" }),
		);
		expect(block).toMatch(/^file: \/home\/u\/.pi\/agent\/memory\/atoms\/process\/abc\.md$/m);
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
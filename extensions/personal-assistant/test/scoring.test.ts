import { describe, it, expect } from "vitest";
import { computeTagOverlap, computeFreshness } from "../scoring.ts";

describe("computeTagOverlap", () => {
	it("partial overlap: 1 of 2 query tokens hits a tag", () => {
		expect(computeTagOverlap("code-style eslint", ["code-style", "test"])).toBe(0.5);
	});

	it("full overlap: single query token matches single tag", () => {
		expect(computeTagOverlap("code-style", ["code-style"])).toBe(1.0);
	});

	it("no tag set: returns 0", () => {
		expect(computeTagOverlap("code-style", [])).toBe(0);
	});

	it("empty query: returns 0", () => {
		expect(computeTagOverlap("", ["x"])).toBe(0);
	});

	it("all query tokens match subset of tags: returns 1.0", () => {
		expect(computeTagOverlap("foo bar", ["foo", "bar", "baz"])).toBe(1.0);
	});

	it("bi-directional alias fold: query value → key, matches aliased tag", () => {
		const aliases = { "code-style": "style" };
		expect(computeTagOverlap("style", ["code-style"], aliases)).toBe(1.0);
	});

	it("case-insensitive match: uppercase query token matches lowercase tag", () => {
		expect(computeTagOverlap("CODE-STYLE", ["code-style"])).toBe(1.0);
	});

	it("forward alias fold: query key matches the aliased value tag", () => {
		const aliases = { a: "b" };
		expect(computeTagOverlap("a", ["b"], aliases)).toBe(1.0);
	});

	it("chain detection: forward chain (a→b→c) resolves to the terminal node", () => {
		const aliases = { a: "b", b: "c" };
		expect(computeTagOverlap("a", ["c"], aliases)).toBe(1.0);
	});

	it("caps alias chain depth at 10 and returns the 10th node", () => {
		const aliases = {
			a: "b", b: "c", c: "d", d: "e", e: "f", f: "g", g: "h", h: "i", i: "j", j: "k", k: "l",
		};
		expect(computeTagOverlap("a", ["k"], aliases)).toBe(1.0);
		expect(computeTagOverlap("a", ["l"], aliases)).toBe(0.0);
	});

	it("null aliases: skips folding, treats as no-alias path", () => {
		expect(computeTagOverlap("code-style", ["code-style"], null)).toBe(1.0);
	});

	it("query token absent from alias map: returned unchanged (no fold match)", () => {
		const aliases = { a: "b" };
		expect(computeTagOverlap("c", ["b"], aliases)).toBe(0.0);
		expect(computeTagOverlap("c", ["c"], aliases)).toBe(1.0);
	});
});

describe("computeFreshness", () => {
	const DAY_MS = 1000 * 60 * 60 * 24;

	it("updatedAt == now → exp(0) = 1.0", () => {
		const now = 1_700_000_000_000;
		expect(computeFreshness(now, now)).toBe(1.0);
	});

	it("30 days old → exp(-1) ≈ 0.3679", () => {
		const now = 1_700_000_000_000;
		expect(computeFreshness(now - 30 * DAY_MS, now)).toBeCloseTo(Math.exp(-1), 4);
	});

	it("90 days old → exp(-3) ≈ 0.0498", () => {
		const now = 1_700_000_000_000;
		expect(computeFreshness(now - 90 * DAY_MS, now)).toBeCloseTo(Math.exp(-3), 4);
	});

	it("1 year (365 days) old → exp(-365/30) ≈ 0.0000051", () => {
		const now = 1_700_000_000_000;
		expect(computeFreshness(now - 365 * DAY_MS, now)).toBeCloseTo(Math.exp(-365 / 30), 10);
	});

	it("1 hour old → exp(-1/720) ≈ 0.9986", () => {
		const now = 1_700_000_000_000;
		const oneHour = 60 * 60 * 1000;
		expect(computeFreshness(now - oneHour, now)).toBeCloseTo(Math.exp(-1 / 720), 4);
	});
});

import { stripVTControlCharacters } from "node:util";
import { describe, expect, it } from "vitest";
import {
	formatHarnessComparisonReport,
	type HarnessObservation,
	summarizeHarnessComparisons,
} from "../../src/vitest-evals/summary.ts";

type ObservationResult = "passed" | "failed" | Exclude<HarnessObservation["outcome"], "scored">;

function observation(
	harness: string,
	testName: string,
	result: ObservationResult,
	metrics: Pick<HarnessObservation, "totalTokens" | "totalMs" | "estimatedCostUsd"> = {},
	baseline = "without-tools",
	candidates: string[] = ["with-tools"],
): HarnessObservation {
	const base = {
		evalSet: "tool access",
		groupKey: JSON.stringify([testName, 1]),
		testName,
		file: "src/tool-access.eval.ts",
		harness,
		baseline,
		candidates,
		repetition: 1,
		...metrics,
	};
	if (result === "passed" || result === "failed") {
		return { ...base, outcome: "scored", score: result === "passed" ? 1 : 0 };
	}
	return { ...base, outcome: result };
}

describe("summarizeHarnessComparisons", () => {
	it("computes paired correctness lift separately from efficiency deltas", () => {
		const report = summarizeHarnessComparisons([
			observation("without-tools", "create", "failed", {
				totalTokens: 100,
				totalMs: 1000,
				estimatedCostUsd: 0.01,
			}),
			observation("with-tools", "create", "passed", {
				totalTokens: 120,
				totalMs: 800,
				estimatedCostUsd: 0.02,
			}),
			observation("without-tools", "inspect", "passed", { totalTokens: 200 }),
			observation("with-tools", "inspect", "passed", { totalTokens: 180 }),
		]);

		expect(report.evalSets).toHaveLength(1);
		expect(report.evalSets[0]?.comparisons).toEqual([
			expect.objectContaining({
				baseline: "without-tools",
				candidate: "with-tools",
				correctness: {
					totalPairs: 2,
					eligiblePairs: 2,
					baselinePassRate: 0.5,
					candidatePassRate: 1,
					lift: 0.5,
					baselineWins: 0,
					candidateWins: 1,
					ties: 1,
				},
				totalTokens: {
					totalPairs: 2,
					eligiblePairs: 2,
					baselineMean: 150,
					candidateMean: 150,
					meanDelta: 0,
				},
				totalMs: {
					totalPairs: 2,
					eligiblePairs: 1,
					baselineMean: 1000,
					candidateMean: 800,
					meanDelta: -200,
				},
				estimatedCostUsd: {
					totalPairs: 2,
					eligiblePairs: 1,
					baselineMean: 0.01,
					candidateMean: 0.02,
					meanDelta: 0.01,
				},
			}),
		]);
		expect(report.diagnostics).toEqual([]);
	});

	it("reports missing observations without coercing them to failures or zero telemetry", () => {
		const report = summarizeHarnessComparisons([
			observation("without-tools", "create", "failed"),
			observation("with-tools", "create", "passed"),
			observation("without-tools", "inspect", "passed"),
		]);
		const comparison = report.evalSets[0]?.comparisons[0];

		expect(comparison?.correctness).toEqual({
			totalPairs: 2,
			eligiblePairs: 1,
			baselinePassRate: 0,
			candidatePassRate: 1,
			lift: 1,
			baselineWins: 0,
			candidateWins: 1,
			ties: 0,
		});
		expect(comparison?.totalTokens).toEqual({
			totalPairs: 2,
			eligiblePairs: 0,
			baselineMean: null,
			candidateMean: null,
			meanDelta: null,
		});
		expect(report.diagnostics).toContainEqual(
			expect.objectContaining({
				testName: "inspect",
				harness: "with-tools",
				reason: "missing-observation",
			}),
		);
	});

	it("keeps identical inputs in different test files separate", () => {
		const report = summarizeHarnessComparisons([
			observation("without-tools", "shared", "failed"),
			observation("with-tools", "shared", "passed"),
			{ ...observation("without-tools", "shared", "passed"), file: "src/other.eval.ts" },
			{ ...observation("with-tools", "shared", "passed"), file: "src/other.eval.ts" },
		]);

		expect(report.evalSets[0]?.comparisons[0]?.correctness).toEqual(
			expect.objectContaining({ totalPairs: 2, eligiblePairs: 2 }),
		);
		expect(report.diagnostics).toEqual([]);
	});

	it("does not score harness errors as correctness failures", () => {
		const report = summarizeHarnessComparisons([
			observation("without-tools", "create", "errored", { totalTokens: 100 }),
			observation("with-tools", "create", "passed", { totalTokens: 100 }),
		]);

		expect(report.evalSets[0]?.comparisons[0]?.correctness).toEqual(
			expect.objectContaining({ totalPairs: 1, eligiblePairs: 0 }),
		);
		expect(report.evalSets[0]?.comparisons[0]?.totalTokens.eligiblePairs).toBe(0);
		expect(report.diagnostics).toContainEqual(
			expect.objectContaining({ harness: "without-tools", reason: "harness-error" }),
		);
	});

	it("does not derive correctness from completed Vitest tests without judge scores", () => {
		const withoutScore = observation("without-tools", "create", "unscored");
		const withScore = observation("with-tools", "create", "unscored");

		const report = summarizeHarnessComparisons([withoutScore, withScore]);

		expect(report.evalSets[0]?.comparisons[0]?.correctness.eligiblePairs).toBe(0);
		expect(report.diagnostics).toEqual([
			expect.objectContaining({ harness: "with-tools", reason: "missing-score" }),
			expect.objectContaining({ harness: "without-tools", reason: "missing-score" }),
		]);
	});

	it("compares each candidate with the declared baseline", () => {
		const candidates = ["second", "third"];
		const report = summarizeHarnessComparisons([
			observation("first", "input", "passed", {}, "first", candidates),
			observation("second", "input", "passed", {}, "first", candidates),
			observation("third", "input", "passed", {}, "first", candidates),
		]);

		expect(report.evalSets[0]?.comparisons.map(({ baseline, candidate }) => [baseline, candidate])).toEqual([
			["first", "second"],
			["first", "third"],
		]);
	});

	it("retains a declared harness with no completed observations", () => {
		const report = summarizeHarnessComparisons([observation("without-tools", "create", "failed")]);

		expect(report.evalSets[0]?.comparisons).toHaveLength(1);
		expect(report.evalSets[0]?.comparisons[0]?.correctness.eligiblePairs).toBe(0);
		expect(report.diagnostics).toContainEqual(
			expect.objectContaining({
				testName: "create",
				harness: "with-tools",
				reason: "missing-observation",
			}),
		);
	});

	it("reports duplicate and unscorable observations once across multiple harness pairs", () => {
		const candidates = ["second", "third"];
		const report = summarizeHarnessComparisons([
			observation("first", "duplicate", "passed", {}, "first", candidates),
			observation("first", "duplicate", "failed", {}, "first", candidates),
			observation("second", "duplicate", "passed", {}, "first", candidates),
			observation("third", "duplicate", "passed", {}, "first", candidates),
			observation("first", "skipped", "skipped", {}, "first", candidates),
			observation("second", "skipped", "passed", {}, "first", candidates),
			observation("third", "skipped", "passed", {}, "first", candidates),
		]);

		expect(report.diagnostics.filter(({ reason }) => reason === "duplicate-observation")).toEqual([
			expect.objectContaining({ testName: "duplicate", harness: "first" }),
		]);
		expect(report.diagnostics.filter(({ reason }) => reason === "unscorable-outcome")).toEqual([
			expect.objectContaining({ testName: "skipped", harness: "first" }),
		]);
	});

	it("formats lift and telemetry availability for the terminal report", () => {
		const report = summarizeHarnessComparisons([
			observation("without-tools", "create", "failed", { totalMs: 34853.7 }),
			observation("with-tools", "create", "passed", { totalMs: 30694.2 }),
		]);

		const formatted = stripVTControlCharacters(formatHarnessComparisonReport(report));
		expect(formatted).toContain("Eval Comparisons");
		expect(formatted).toContain(" Baseline  without-tools");
		expect(formatted).toContain("Candidate  with-tools (1/1 pairs)");
		expect(formatted).toContain("Pass rate  +100.0 pp (candidate 100.0%, baseline 0.0%)");
		expect(formatted).toContain("   Tokens  unavailable");
		expect(formatted).toContain("  Latency  -4159.5ms (candidate 30694.2ms, baseline 34853.7ms)");
	});
});

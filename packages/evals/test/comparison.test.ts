import { stripVTControlCharacters } from "node:util";
import { describe, expect, it } from "vitest";
import {
	type EvalObservation,
	type ExpectedEvalRun,
	formatEvalComparisonReport,
	summarizeEvalObservations,
} from "../src/report.ts";

function scored(
	variant: EvalObservation["variant"],
	runNumber: number,
	score: number,
	metrics: Partial<{
		totalTokens: number;
		toolCalls: number;
		totalMs: number;
		estimatedCostUsd: number;
	}> = {},
): EvalObservation {
	return {
		evalSet: "tool access",
		caseId: "create",
		variant,
		model: "fixture/model",
		runNumber,
		outcome: "scored",
		score,
		totalTokens: 100,
		toolCalls: 2,
		totalMs: 1000,
		estimatedCostUsd: 0.01,
		...metrics,
	};
}

function errored(variant: EvalObservation["variant"], runNumber: number, totalTokens?: number): EvalObservation {
	return {
		evalSet: "tool access",
		caseId: "create",
		variant,
		model: "fixture/model",
		runNumber,
		outcome: "errored",
		totalTokens,
	};
}

function expectedFor(runNumbers: readonly number[]): ExpectedEvalRun[] {
	return runNumbers.flatMap((runNumber) =>
		(["without_docs", "with_docs"] as const).map((variant) => ({
			evalSet: "tool access",
			caseId: "create",
			variant,
			model: "fixture/model",
			runNumber,
		})),
	);
}

describe("summarizeEvalObservations", () => {
	it("computes paired lift and efficiency deltas", () => {
		const observations = [
			scored("without_docs", 1, 0, { totalTokens: 100, toolCalls: 3, totalMs: 1000 }),
			scored("with_docs", 1, 1, { totalTokens: 120, toolCalls: 2, totalMs: 800 }),
			scored("without_docs", 2, 1, { totalTokens: 200 }),
			scored("with_docs", 2, 1, { totalTokens: 180 }),
		];
		const report = summarizeEvalObservations("digest", expectedFor([1, 2]), observations);
		expect(report.comparisons).toEqual([
			expect.objectContaining({
				evalSet: "tool access",
				totalPairs: 2,
				eligiblePairs: 2,
				blockedPairs: 0,
				controlPassRate: 0.5,
				treatmentPassRate: 1,
				lift: 0.5,
				totalTokens: { eligiblePairs: 2, controlMean: 150, treatmentMean: 150, meanDelta: 0 },
				toolCalls: { eligiblePairs: 2, controlMean: 2.5, treatmentMean: 2, meanDelta: -0.5 },
			}),
		]);
	});

	it("fails closed for incomplete and errored pairs while retaining totals", () => {
		const observations: EvalObservation[] = [
			scored("without_docs", 1, 0),
			errored("with_docs", 1, 120),
			scored("without_docs", 2, 1, { totalTokens: 200 }),
		];
		const report = summarizeEvalObservations("digest", expectedFor([1, 2]), observations);
		expect(report.comparisons[0]).toEqual(
			expect.objectContaining({ totalPairs: 2, eligiblePairs: 0, blockedPairs: 2, lift: null }),
		);
		expect(report.blockedPairs).toEqual([
			expect.objectContaining({ runNumber: 1, reasons: ["with_docs: errored"] }),
			expect.objectContaining({ runNumber: 2, reasons: ["with_docs: expected 1 observation, found 0"] }),
		]);
		expect(report.operationalTotals[0].totalTokens).toEqual({ availableRuns: 2, total: 300 });
	});

	it("blocks duplicate observations and keeps missing metrics distinct from zero", () => {
		const withoutTokens = scored("without_docs", 1, 1);
		delete withoutTokens.totalTokens;
		const report = summarizeEvalObservations("digest", expectedFor([1]), [
			withoutTokens,
			withoutTokens,
			scored("with_docs", 1, 1, { totalTokens: 0 }),
		]);
		expect(report.blockedPairs[0].reasons).toEqual(["without_docs: expected 1 observation, found 2"]);
		expect(report.operationalTotals[0].totalTokens).toEqual({ availableRuns: 0, total: null });
		expect(report.operationalTotals[1].totalTokens).toEqual({ availableRuns: 1, total: 0 });
	});

	it("formats blocked comparisons and operational totals", () => {
		const report = summarizeEvalObservations("digest", expectedFor([1, 2]), [
			scored("without_docs", 1, 1),
			scored("with_docs", 1, 1),
		]);
		const formatted = stripVTControlCharacters(formatEvalComparisonReport(report));
		expect(formatted).toContain("Documentation Eval Comparisons");
		expect(formatted).toContain("Pass rate  withheld because pairs are blocked");
		expect(formatted).toContain("without_docs: 1 runs");
	});
});

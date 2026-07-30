import { styleText } from "node:util";

type HarnessObservationOutcome = "scored" | "unscored" | "skipped" | "pending" | "errored";

type HarnessObservationBase = {
	evalSet: string;
	groupKey: string;
	testName: string;
	file: string;
	harness: string;
	baseline: string;
	candidates: string[];
	repetition: number;
	totalTokens?: number;
	totalMs?: number;
	estimatedCostUsd?: number;
};

export type HarnessObservation = HarnessObservationBase &
	({ outcome: "scored"; score: number } | { outcome: Exclude<HarnessObservationOutcome, "scored">; score?: never });

export type PairedMetricSummary = {
	totalPairs: number;
	eligiblePairs: number;
	baselineMean: number | null;
	candidateMean: number | null;
	meanDelta: number | null;
};

export type CorrectnessLiftSummary = {
	totalPairs: number;
	eligiblePairs: number;
	baselinePassRate: number | null;
	candidatePassRate: number | null;
	lift: number | null;
	baselineWins: number;
	candidateWins: number;
	ties: number;
};

export type HarnessPairComparison = {
	baseline: string;
	candidate: string;
	correctness: CorrectnessLiftSummary;
	totalTokens: PairedMetricSummary;
	totalMs: PairedMetricSummary;
	estimatedCostUsd: PairedMetricSummary;
};

export type HarnessComparisonDiagnostic = {
	evalSet: string;
	groupKey: string;
	testName: string;
	file: string;
	repetition: number;
	harness: string;
	reason: "missing-observation" | "duplicate-observation" | "harness-error" | "missing-score" | "unscorable-outcome";
};

export type HarnessEvalSetReport = {
	evalSet: string;
	comparisons: HarnessPairComparison[];
};

export type HarnessComparisonReport = {
	schemaVersion: 1;
	evalSets: HarnessEvalSetReport[];
	diagnostics: HarnessComparisonDiagnostic[];
};

type HarnessDescriptor = {
	name: string;
	index: number;
};

type ObservationGroup = {
	evalSet: string;
	groupKey: string;
	testName: string;
	file: string;
	repetition: number;
	observationsByHarness: Map<string, HarnessObservation[]>;
};

type EvalSetData = {
	baseline: HarnessDescriptor;
	candidatesByName: Map<string, HarnessDescriptor>;
	groupsByKey: Map<string, ObservationGroup>;
};

type ObservationPair = {
	baseline: HarnessObservation;
	candidate: HarnessObservation;
};

function getOrCreate<K, V extends object>(map: Map<K, V>, key: K, create: () => V): V {
	const existing = map.get(key);
	if (existing !== undefined) return existing;
	const value = create();
	map.set(key, value);
	return value;
}

function mean(values: readonly number[]): number | null {
	return values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function preciseDifference(left: number, right: number): number {
	return Number((left - right).toPrecision(15));
}

function groupObservations(observations: readonly HarnessObservation[]): Map<string, EvalSetData> {
	const evalSets = new Map<string, EvalSetData>();
	for (const observation of observations) {
		const evalSet = getOrCreate(evalSets, observation.evalSet, () => ({
			baseline: { name: observation.baseline, index: 0 },
			candidatesByName: new Map(),
			groupsByKey: new Map(),
		}));

		for (const [index, name] of observation.candidates.entries()) {
			const existing = evalSet.candidatesByName.get(name);
			if (!existing || index < existing.index) evalSet.candidatesByName.set(name, { name, index });
		}

		const group = getOrCreate(
			evalSet.groupsByKey,
			JSON.stringify([observation.file, observation.testName, observation.groupKey]),
			() => ({
				evalSet: observation.evalSet,
				groupKey: observation.groupKey,
				testName: observation.testName,
				file: observation.file,
				repetition: observation.repetition,
				observationsByHarness: new Map(),
			}),
		);
		getOrCreate(group.observationsByHarness, observation.harness, (): HarnessObservation[] => []).push(observation);
	}
	return evalSets;
}

function orderedHarnesses(evalSet: EvalSetData): HarnessDescriptor[] {
	return [
		evalSet.baseline,
		...[...evalSet.candidatesByName.values()].sort(
			(left, right) => left.index - right.index || left.name.localeCompare(right.name),
		),
	];
}

function orderedCandidates(evalSet: EvalSetData): HarnessDescriptor[] {
	return [...evalSet.candidatesByName.values()].sort(
		(left, right) => left.index - right.index || left.name.localeCompare(right.name),
	);
}

function orderedGroups(evalSet: EvalSetData): ObservationGroup[] {
	return [...evalSet.groupsByKey.values()].sort(
		(left, right) => left.groupKey.localeCompare(right.groupKey) || left.repetition - right.repetition,
	);
}

function collectDiagnostics(
	harnesses: readonly HarnessDescriptor[],
	groups: readonly ObservationGroup[],
): HarnessComparisonDiagnostic[] {
	const diagnostics: HarnessComparisonDiagnostic[] = [];
	for (const group of groups) {
		for (const { name: harness } of harnesses) {
			const observations = group.observationsByHarness.get(harness) ?? [];
			let reason: HarnessComparisonDiagnostic["reason"] | undefined;
			if (observations.length === 0) reason = "missing-observation";
			else if (observations.length > 1) reason = "duplicate-observation";
			else if (observations[0].outcome === "errored") reason = "harness-error";
			else if (observations[0].outcome === "unscored") {
				reason = "missing-score";
			} else if (observations[0].outcome !== "scored") {
				reason = "unscorable-outcome";
			}
			if (!reason) continue;
			diagnostics.push({
				evalSet: group.evalSet,
				groupKey: group.groupKey,
				testName: group.testName,
				file: group.file,
				repetition: group.repetition,
				harness,
				reason,
			});
		}
	}
	return diagnostics;
}

function pairObservations(
	groups: readonly ObservationGroup[],
	baselineHarness: string,
	candidateHarness: string,
): ObservationPair[] {
	const pairs: ObservationPair[] = [];
	for (const group of groups) {
		const baseline = group.observationsByHarness.get(baselineHarness) ?? [];
		const candidate = group.observationsByHarness.get(candidateHarness) ?? [];
		if (baseline.length === 1 && candidate.length === 1) {
			pairs.push({ baseline: baseline[0], candidate: candidate[0] });
		}
	}
	return pairs;
}

function summarizeMetric(
	pairs: readonly ObservationPair[],
	select: (observation: HarnessObservation) => number | undefined,
	totalPairs: number,
): PairedMetricSummary {
	const baselineValues: number[] = [];
	const candidateValues: number[] = [];
	for (const { baseline, candidate } of pairs) {
		if (baseline.outcome !== "scored" || candidate.outcome !== "scored") continue;
		const baselineValue = select(baseline);
		const candidateValue = select(candidate);
		if (
			baselineValue === undefined ||
			candidateValue === undefined ||
			!Number.isFinite(baselineValue) ||
			!Number.isFinite(candidateValue)
		) {
			continue;
		}
		baselineValues.push(baselineValue);
		candidateValues.push(candidateValue);
	}

	const baselineMean = mean(baselineValues);
	const candidateMean = mean(candidateValues);
	return {
		totalPairs,
		eligiblePairs: baselineValues.length,
		baselineMean,
		candidateMean,
		meanDelta:
			baselineMean === null || candidateMean === null ? null : preciseDifference(candidateMean, baselineMean),
	};
}

function summarizeCorrectness(pairs: readonly ObservationPair[], totalPairs: number): CorrectnessLiftSummary {
	let eligiblePairs = 0;
	let baselinePasses = 0;
	let candidatePasses = 0;
	let baselineWins = 0;
	let candidateWins = 0;
	let ties = 0;

	for (const { baseline, candidate } of pairs) {
		if (baseline.outcome !== "scored" || candidate.outcome !== "scored") continue;
		eligiblePairs += 1;
		const baselinePassed = baseline.score >= 1;
		const candidatePassed = candidate.score >= 1;
		if (baselinePassed) baselinePasses += 1;
		if (candidatePassed) candidatePasses += 1;
		if (baselinePassed === candidatePassed) ties += 1;
		else if (baselinePassed) baselineWins += 1;
		else candidateWins += 1;
	}

	const baselinePassRate = eligiblePairs === 0 ? null : baselinePasses / eligiblePairs;
	const candidatePassRate = eligiblePairs === 0 ? null : candidatePasses / eligiblePairs;
	return {
		totalPairs,
		eligiblePairs,
		baselinePassRate,
		candidatePassRate,
		lift:
			baselinePassRate === null || candidatePassRate === null
				? null
				: preciseDifference(candidatePassRate, baselinePassRate),
		baselineWins,
		candidateWins,
		ties,
	};
}

function compareHarnesses(
	baseline: HarnessDescriptor,
	candidate: HarnessDescriptor,
	groups: readonly ObservationGroup[],
): HarnessPairComparison {
	const pairs = pairObservations(groups, baseline.name, candidate.name);
	return {
		baseline: baseline.name,
		candidate: candidate.name,
		correctness: summarizeCorrectness(pairs, groups.length),
		totalTokens: summarizeMetric(pairs, ({ totalTokens }) => totalTokens, groups.length),
		totalMs: summarizeMetric(pairs, ({ totalMs }) => totalMs, groups.length),
		estimatedCostUsd: summarizeMetric(pairs, ({ estimatedCostUsd }) => estimatedCostUsd, groups.length),
	};
}

export function summarizeHarnessComparisons(observations: readonly HarnessObservation[]): HarnessComparisonReport {
	const evalSets: HarnessEvalSetReport[] = [];
	const diagnostics: HarnessComparisonDiagnostic[] = [];
	for (const [evalSet, data] of [...groupObservations(observations)].sort(([left], [right]) =>
		left.localeCompare(right),
	)) {
		const harnesses = orderedHarnesses(data);
		const candidates = orderedCandidates(data);
		const groups = orderedGroups(data);
		evalSets.push({
			evalSet,
			comparisons: candidates.map((candidate) => compareHarnesses(data.baseline, candidate, groups)),
		});
		diagnostics.push(...collectDiagnostics(harnesses, groups));
	}

	return {
		schemaVersion: 1,
		evalSets,
		diagnostics: diagnostics.sort(
			(left, right) =>
				left.evalSet.localeCompare(right.evalSet) ||
				left.file.localeCompare(right.file) ||
				left.groupKey.localeCompare(right.groupKey) ||
				left.repetition - right.repetition ||
				left.harness.localeCompare(right.harness),
		),
	};
}

function formatPercentage(value: number | null): string {
	return value === null ? "unavailable" : `${(value * 100).toFixed(1)}%`;
}

function formatSigned(value: number, fractionDigits: number): string {
	return `${value >= 0 ? "+" : ""}${value.toFixed(fractionDigits)}`;
}

function formatCoverage(eligiblePairs: number, totalPairs: number): string {
	return styleText("gray", `(${eligiblePairs}/${totalPairs} pairs)`);
}

function formatReportLine(label: string, value: string): string {
	return `    ${styleText("gray", label.padStart(9))}  ${value}`;
}

function colorDelta(value: number, formatted: string, positiveIsBetter: boolean): string {
	if (value === 0) return styleText("gray", formatted);
	const improved = positiveIsBetter ? value > 0 : value < 0;
	return styleText(improved ? "green" : "red", formatted);
}

function formatMetric(
	label: string,
	metric: PairedMetricSummary,
	formatValue: (value: number) => string,
	formatDelta: (value: number) => string,
	comparisonPairs: number,
): string {
	const coverage =
		metric.eligiblePairs === 0 || metric.eligiblePairs === comparisonPairs
			? ""
			: ` ${formatCoverage(metric.eligiblePairs, metric.totalPairs)}`;
	if (metric.baselineMean === null || metric.candidateMean === null || metric.meanDelta === null) {
		return formatReportLine(label, `${styleText("yellow", "unavailable")}${coverage}`);
	}
	const delta = colorDelta(metric.meanDelta, formatDelta(metric.meanDelta), false);
	const values = styleText(
		"gray",
		`(candidate ${formatValue(metric.candidateMean)}, baseline ${formatValue(metric.baselineMean)})`,
	);
	return formatReportLine(label, `${delta} ${values}${coverage}`);
}

export function formatHarnessComparisonReport(report: HarnessComparisonReport): string {
	if (report.evalSets.every(({ comparisons }) => comparisons.length === 0)) return "";
	const lines = [styleText("bold", "Eval Comparisons")];
	for (const evalSet of report.evalSets) {
		lines.push(`  ${evalSet.evalSet}`);
		for (const [index, comparison] of evalSet.comparisons.entries()) {
			if (index > 0) lines.push("");
			const { correctness } = comparison;
			lines.push(formatReportLine("Baseline", comparison.baseline));
			lines.push(
				formatReportLine(
					"Candidate",
					`${comparison.candidate} ${formatCoverage(correctness.eligiblePairs, correctness.totalPairs)}`,
				),
			);
			if (correctness.lift === null) {
				lines.push(formatReportLine("Pass rate", styleText("yellow", "unavailable")));
			} else {
				const lift = correctness.lift * 100;
				const delta = colorDelta(lift, `${formatSigned(lift, 1)} pp`, true);
				const values = styleText(
					"gray",
					`(candidate ${formatPercentage(correctness.candidatePassRate)}, baseline ${formatPercentage(correctness.baselinePassRate)})`,
				);
				lines.push(formatReportLine("Pass rate", `${delta} ${values}`));
			}
			lines.push(
				formatMetric(
					"Tokens",
					comparison.totalTokens,
					(value) => value.toFixed(1),
					(value) => formatSigned(value, 1),
					correctness.eligiblePairs,
				),
			);
			lines.push(
				formatMetric(
					"Latency",
					comparison.totalMs,
					(value) => `${value.toFixed(1)}ms`,
					(value) => `${formatSigned(value, 1)}ms`,
					correctness.eligiblePairs,
				),
			);
			lines.push(
				formatMetric(
					"Est. cost",
					comparison.estimatedCostUsd,
					(value) => `$${value.toFixed(4)}`,
					(value) => `${value >= 0 ? "+" : "-"}$${Math.abs(value).toFixed(4)}`,
					correctness.eligiblePairs,
				),
			);
		}
	}
	if (report.diagnostics.length > 0) {
		lines.push(`  ${styleText("yellow", "Incomplete observations")}`);
		for (const diagnostic of report.diagnostics) {
			lines.push(
				`    ${diagnostic.reason}: ${diagnostic.file}/${diagnostic.testName} repetition ${diagnostic.repetition}, harness ${diagnostic.harness}`,
			);
		}
	}
	return lines.join("\n");
}

import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { styleText } from "node:util";
import type { ReportCase } from "@vitest-evals/core";
import { readReportWorkspace, readVitestJsonReportFile } from "@vitest-evals/core/node";
import type { DocumentationVariant, EvalTask } from "./plan.ts";

export const PI_SESSION_SNAPSHOT_ARTIFACT = "piSessionJsonl";

export type EvalRunIdentity = {
	evalSet: string;
	caseId: string;
	variant: DocumentationVariant;
	model: string;
	runNumber: number;
};

export type ExpectedEvalRun = EvalRunIdentity;

type EvalMetrics = {
	inputTokens?: number;
	outputTokens?: number;
	cacheReadTokens?: number;
	cacheWriteTokens?: number;
	totalTokens?: number;
	toolCalls?: number;
	totalMs?: number;
	estimatedCostUsd?: number;
};

export type EvalObservation = EvalRunIdentity &
	EvalMetrics &
	({ outcome: "scored"; score: number } | { outcome: "unscored" | "skipped" | "pending" | "errored" });

export type PairedMetricSummary = {
	eligiblePairs: number;
	controlMean: number | null;
	treatmentMean: number | null;
	meanDelta: number | null;
};

export type EvalSetComparison = {
	evalSet: string;
	totalPairs: number;
	eligiblePairs: number;
	blockedPairs: number;
	controlPassRate: number | null;
	treatmentPassRate: number | null;
	lift: number | null;
	flags: Array<"no-lift" | "negative-delta" | "control-saturated" | "treatment-saturated" | "flaky">;
	totalTokens: PairedMetricSummary;
	toolCalls: PairedMetricSummary;
	totalMs: PairedMetricSummary;
	estimatedCostUsd: PairedMetricSummary;
};

export type BlockedPair = Omit<EvalRunIdentity, "variant"> & { reasons: string[] };

export type OperationalMetricTotal = { availableRuns: number; total: number | null };

export type VariantTotals = {
	variant: DocumentationVariant;
	runs: number;
	inputTokens: OperationalMetricTotal;
	outputTokens: OperationalMetricTotal;
	cacheReadTokens: OperationalMetricTotal;
	cacheWriteTokens: OperationalMetricTotal;
	totalTokens: OperationalMetricTotal;
	toolCalls: OperationalMetricTotal;
	totalMs: OperationalMetricTotal;
	estimatedCostUsd: OperationalMetricTotal;
};

export type EvalComparisonReport = {
	schemaVersion: 3;
	protocolDigest: string;
	control: "without_docs";
	treatment: "with_docs";
	comparisons: EvalSetComparison[];
	blockedPairs: BlockedPair[];
	operationalTotals: VariantTotals[];
};

function optionalMetric(value: unknown, name: string): number | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
		throw new TypeError(`${name} must be a finite non-negative number.`);
	}
	return value;
}

function validateScore(value: unknown): number | undefined {
	if (value === null || value === undefined) return undefined;
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
		throw new TypeError("Eval score must be between 0 and 1.");
	}
	return value;
}

export function classifyCaseStatus(status: ReportCase["status"]): "errored" | "skipped" | "pending" | undefined {
	if (status === "failed") return "errored";
	if (status === "skipped" || status === "todo" || status === "disabled") return "skipped";
	if (status === "pending") return "pending";
	return undefined;
}

function taskIdentity(task: EvalTask): EvalRunIdentity {
	return {
		evalSet: task.evalSet,
		caseId: task.caseId,
		variant: task.variant,
		model: task.model,
		runNumber: task.runNumber,
	};
}

export function erroredObservation(task: EvalTask): EvalObservation {
	return { ...taskIdentity(task), outcome: "errored" };
}

async function persistSession(caseResult: ReportCase, task: EvalTask, artifactDirectory: string): Promise<void> {
	const session = caseResult.harness?.run?.artifacts?.[PI_SESSION_SNAPSHOT_ARTIFACT];
	if (typeof session !== "string") return;
	const identity = JSON.stringify([task.evalSet, task.caseId, task.variant, task.model, task.runNumber]);
	const directory = join(
		artifactDirectory,
		task.variant,
		"sessions",
		createHash("sha256").update(identity).digest("hex"),
	);
	await mkdir(directory, { recursive: true, mode: 0o700 });
	await writeFile(join(directory, "session.jsonl"), session, { mode: 0o600 });
}

export async function readTaskObservation(
	task: EvalTask,
	reportPath: string,
	artifactDirectory: string,
): Promise<EvalObservation> {
	const identity = taskIdentity(task);
	const loaded = await Promise.all([readReportWorkspace([reportPath]), readVitestJsonReportFile(reportPath)]).catch(
		() => undefined,
	);
	if (!loaded) return { ...identity, outcome: "errored" };
	const [{ workspace }, rawReport] = loaded;
	const reportedFullName = `${task.evalSet} ${task.caseId}`;
	const assertions = rawReport.testResults.flatMap(({ assertionResults }) => assertionResults);
	if (assertions.length !== 1) return { ...identity, outcome: "errored" };
	const assertion = assertions[0];
	if (assertion.fullName !== reportedFullName) return { ...identity, outcome: "errored" };
	const statusOutcome = classifyCaseStatus(assertion.status);
	if (statusOutcome) return { ...identity, outcome: statusOutcome };
	if (workspace.cases.length !== 1) return { ...identity, outcome: "errored" };
	const caseResult = workspace.cases[0];
	if (caseResult.fullName !== reportedFullName) return { ...identity, outcome: "errored" };
	if (caseResult.status !== assertion.status) return { ...identity, outcome: "errored" };
	const run = caseResult.harness?.run;
	if (!run) return { ...identity, outcome: "errored" };
	await persistSession(caseResult, task, artifactDirectory);
	const actualModel = run.usage.provider && run.usage.model ? `${run.usage.provider}/${run.usage.model}` : undefined;
	if (actualModel !== task.model) return { ...identity, outcome: "errored" };
	let metrics: EvalMetrics = {};
	try {
		metrics = {
			inputTokens: optionalMetric(run.usage.inputTokens, "inputTokens"),
			outputTokens: optionalMetric(run.usage.outputTokens, "outputTokens"),
			cacheReadTokens: optionalMetric(run.usage.metadata?.cacheReadTokens, "cacheReadTokens"),
			cacheWriteTokens: optionalMetric(run.usage.metadata?.cacheWriteTokens, "cacheWriteTokens"),
			totalTokens: optionalMetric(run.usage.totalTokens, "totalTokens"),
			toolCalls: optionalMetric(run.usage.toolCalls, "toolCalls"),
			totalMs: optionalMetric(run.timings?.totalMs, "totalMs"),
			estimatedCostUsd: optionalMetric(run.usage.metadata?.estimatedCostUsd, "estimatedCostUsd"),
		};
	} catch {
		return { ...identity, outcome: "errored" };
	}
	if (run.errors.length > 0) return { ...identity, ...metrics, outcome: "errored" };
	let score: number | undefined;
	try {
		score = validateScore(caseResult.eval?.avgScore);
	} catch {
		return { ...identity, ...metrics, outcome: "errored" };
	}
	if (score === undefined) return { ...identity, ...metrics, outcome: "unscored" };
	return { ...identity, ...metrics, outcome: "scored", score };
}

const CONTROL = "without_docs";
const TREATMENT = "with_docs";
const VARIANTS = [CONTROL, TREATMENT] as const;

type Pair = { control: EvalObservation & { outcome: "scored" }; treatment: EvalObservation & { outcome: "scored" } };
type PairGroup = Omit<EvalRunIdentity, "variant"> & {
	expected: Map<DocumentationVariant, number>;
	observations: Map<DocumentationVariant, EvalObservation[]>;
};

function mean(values: readonly number[]): number | null {
	return values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function difference(treatment: number, control: number): number {
	return Number((treatment - control).toPrecision(15));
}

function pairKey(identity: Omit<EvalRunIdentity, "variant">): string {
	return JSON.stringify([identity.evalSet, identity.caseId, identity.model, identity.runNumber]);
}

function groupPairs(expectedRuns: readonly ExpectedEvalRun[], observations: readonly EvalObservation[]): PairGroup[] {
	const groups = new Map<string, PairGroup>();
	const getGroup = (identity: EvalRunIdentity): PairGroup => {
		const key = pairKey(identity);
		const existing = groups.get(key);
		if (existing) return existing;
		const group = {
			evalSet: identity.evalSet,
			caseId: identity.caseId,
			model: identity.model,
			runNumber: identity.runNumber,
			expected: new Map<DocumentationVariant, number>(),
			observations: new Map<DocumentationVariant, EvalObservation[]>(),
		};
		groups.set(key, group);
		return group;
	};
	for (const expected of expectedRuns) {
		const group = getGroup(expected);
		group.expected.set(expected.variant, (group.expected.get(expected.variant) ?? 0) + 1);
	}
	for (const observation of observations) {
		const group = getGroup(observation);
		const runs = group.observations.get(observation.variant) ?? [];
		runs.push(observation);
		group.observations.set(observation.variant, runs);
	}
	return [...groups.values()].sort(
		(left, right) =>
			left.evalSet.localeCompare(right.evalSet) ||
			left.caseId.localeCompare(right.caseId) ||
			left.model.localeCompare(right.model) ||
			left.runNumber - right.runNumber,
	);
}

function resolvePair(group: PairGroup): { pair?: Pair; blocked?: BlockedPair } {
	const reasons: string[] = [];
	for (const variant of VARIANTS) {
		const expected = group.expected.get(variant) ?? 0;
		const observed = group.observations.get(variant) ?? [];
		if (expected !== 1) reasons.push(`${variant}: design expected 1 run, found ${expected}`);
		if (observed.length !== expected) {
			reasons.push(
				`${variant}: expected ${expected} observation${expected === 1 ? "" : "s"}, found ${observed.length}`,
			);
		}
		if (expected === 1 && observed.length === 1 && observed[0].outcome !== "scored") {
			reasons.push(`${variant}: ${observed[0].outcome}`);
		}
	}
	if (reasons.length > 0) {
		return {
			blocked: {
				evalSet: group.evalSet,
				caseId: group.caseId,
				model: group.model,
				runNumber: group.runNumber,
				reasons,
			},
		};
	}
	return {
		pair: {
			control: group.observations.get(CONTROL)![0] as EvalObservation & { outcome: "scored" },
			treatment: group.observations.get(TREATMENT)![0] as EvalObservation & { outcome: "scored" },
		},
	};
}

function summarizeMetric(
	pairs: readonly Pair[],
	select: (observation: EvalObservation) => number | undefined,
): PairedMetricSummary {
	const control: number[] = [];
	const treatment: number[] = [];
	for (const pair of pairs) {
		const controlValue = select(pair.control);
		const treatmentValue = select(pair.treatment);
		if (controlValue === undefined || treatmentValue === undefined) continue;
		control.push(controlValue);
		treatment.push(treatmentValue);
	}
	const controlMean = mean(control);
	const treatmentMean = mean(treatment);
	return {
		eligiblePairs: control.length,
		controlMean,
		treatmentMean,
		meanDelta: controlMean === null || treatmentMean === null ? null : difference(treatmentMean, controlMean),
	};
}

function operationalTotal(
	runs: readonly EvalObservation[],
	select: (observation: EvalObservation) => number | undefined,
): OperationalMetricTotal {
	const values = runs.flatMap((run) => {
		const value = select(run);
		return value === undefined ? [] : [value];
	});
	return {
		availableRuns: values.length,
		total: values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0),
	};
}

function variantTotals(observations: readonly EvalObservation[], variant: DocumentationVariant): VariantTotals {
	const runs = observations.filter((observation) => observation.variant === variant);
	return {
		variant,
		runs: runs.length,
		inputTokens: operationalTotal(runs, ({ inputTokens }) => inputTokens),
		outputTokens: operationalTotal(runs, ({ outputTokens }) => outputTokens),
		cacheReadTokens: operationalTotal(runs, ({ cacheReadTokens }) => cacheReadTokens),
		cacheWriteTokens: operationalTotal(runs, ({ cacheWriteTokens }) => cacheWriteTokens),
		totalTokens: operationalTotal(runs, ({ totalTokens }) => totalTokens),
		toolCalls: operationalTotal(runs, ({ toolCalls }) => toolCalls),
		totalMs: operationalTotal(runs, ({ totalMs }) => totalMs),
		estimatedCostUsd: operationalTotal(runs, ({ estimatedCostUsd }) => estimatedCostUsd),
	};
}

function comparisonFlags(pairs: readonly Pair[], controlPassRate: number | null, treatmentPassRate: number | null) {
	const flags: Array<"no-lift" | "negative-delta" | "control-saturated" | "treatment-saturated" | "flaky"> = [];
	if (controlPassRate !== null && treatmentPassRate !== null) {
		if (controlPassRate === treatmentPassRate) flags.push("no-lift");
		if (treatmentPassRate < controlPassRate) flags.push("negative-delta");
		if (controlPassRate === 1) flags.push("control-saturated");
		if (treatmentPassRate === 1) flags.push("treatment-saturated");
	}
	const outcomes = new Map<string, Set<string>>();
	for (const pair of pairs) {
		const key = JSON.stringify([pair.control.caseId, pair.control.variant]);
		const control = outcomes.get(key) ?? new Set<string>();
		control.add(String(pair.control.score >= 1));
		outcomes.set(key, control);
		const treatmentKey = JSON.stringify([pair.treatment.caseId, pair.treatment.variant]);
		const treatment = outcomes.get(treatmentKey) ?? new Set<string>();
		treatment.add(String(pair.treatment.score >= 1));
		outcomes.set(treatmentKey, treatment);
	}
	if ([...outcomes.values()].some((values) => values.size > 1)) flags.push("flaky");
	return flags;
}

export function summarizeEvalObservations(
	protocolDigest: string,
	expectedRuns: readonly ExpectedEvalRun[],
	observations: readonly EvalObservation[],
): EvalComparisonReport {
	const groups = groupPairs(expectedRuns, observations);
	const blockedPairs: BlockedPair[] = [];
	const pairsByEvalSet = new Map<string, Pair[]>();
	const totalsByEvalSet = new Map<string, number>();
	for (const group of groups) {
		totalsByEvalSet.set(group.evalSet, (totalsByEvalSet.get(group.evalSet) ?? 0) + 1);
		const { pair, blocked } = resolvePair(group);
		if (blocked) blockedPairs.push(blocked);
		if (pair) pairsByEvalSet.set(group.evalSet, [...(pairsByEvalSet.get(group.evalSet) ?? []), pair]);
	}
	const comparisons = [...totalsByEvalSet]
		.sort(([left], [right]) => left.localeCompare(right))
		.map(([evalSet, totalPairs]) => {
			const pairs = pairsByEvalSet.get(evalSet) ?? [];
			const blockedPairCount = totalPairs - pairs.length;
			const publishHeadline = blockedPairCount === 0 && pairs.length > 0;
			const controlPassRate = publishHeadline
				? pairs.filter(({ control }) => control.score >= 1).length / pairs.length
				: null;
			const treatmentPassRate = publishHeadline
				? pairs.filter(({ treatment }) => treatment.score >= 1).length / pairs.length
				: null;
			return {
				evalSet,
				totalPairs,
				eligiblePairs: pairs.length,
				blockedPairs: blockedPairCount,
				controlPassRate,
				treatmentPassRate,
				lift:
					controlPassRate === null || treatmentPassRate === null
						? null
						: difference(treatmentPassRate, controlPassRate),
				flags: comparisonFlags(pairs, controlPassRate, treatmentPassRate),
				totalTokens: summarizeMetric(pairs, ({ totalTokens }) => totalTokens),
				toolCalls: summarizeMetric(pairs, ({ toolCalls }) => toolCalls),
				totalMs: summarizeMetric(pairs, ({ totalMs }) => totalMs),
				estimatedCostUsd: summarizeMetric(pairs, ({ estimatedCostUsd }) => estimatedCostUsd),
			};
		});
	return {
		schemaVersion: 3,
		protocolDigest,
		control: CONTROL,
		treatment: TREATMENT,
		comparisons,
		blockedPairs,
		operationalTotals: [variantTotals(observations, CONTROL), variantTotals(observations, TREATMENT)],
	};
}

function percentage(value: number | null): string {
	return value === null ? "unavailable" : `${(value * 100).toFixed(1)}%`;
}

function signed(value: number, digits: number): string {
	return `${value >= 0 ? "+" : ""}${value.toFixed(digits)}`;
}

function pairedMetric(label: string, metric: PairedMetricSummary, unit = ""): string {
	if (metric.meanDelta === null || metric.controlMean === null || metric.treatmentMean === null) {
		return `    ${label.padStart(10)}  unavailable`;
	}
	return `    ${label.padStart(10)}  ${signed(metric.meanDelta, 1)}${unit} (with ${metric.treatmentMean.toFixed(1)}${unit}, without ${metric.controlMean.toFixed(1)}${unit}, ${metric.eligiblePairs} pairs)`;
}

function operationalMetric(metric: OperationalMetricTotal, runs: number, format: (total: number) => string): string {
	if (metric.total === null) return `unavailable (0/${runs} measured)`;
	const coverage = metric.availableRuns === runs ? "" : ` (${metric.availableRuns}/${runs} measured)`;
	return `${format(metric.total)}${coverage}`;
}

export function formatEvalComparisonReport(report: EvalComparisonReport): string {
	if (report.comparisons.length === 0) return "";
	const lines = [styleText("bold", "Documentation Eval Comparisons")];
	for (const comparison of report.comparisons) {
		lines.push(`  ${comparison.evalSet}`);
		lines.push(`         Pairs  ${comparison.eligiblePairs}/${comparison.totalPairs} eligible`);
		if (comparison.lift === null) {
			lines.push(
				comparison.blockedPairs > 0
					? "     Pass rate  withheld because pairs are blocked"
					: "     Pass rate  unavailable",
			);
		} else {
			lines.push(
				`     Pass rate  ${signed(comparison.lift * 100, 1)} pp (with ${percentage(comparison.treatmentPassRate)}, without ${percentage(comparison.controlPassRate)})`,
			);
		}
		if (comparison.flags.length > 0) lines.push(`         Flags  ${comparison.flags.join(", ")}`);
		lines.push(pairedMetric("Tokens", comparison.totalTokens));
		lines.push(pairedMetric("Tools", comparison.toolCalls));
		lines.push(pairedMetric("Latency", comparison.totalMs, "ms"));
		const cost = comparison.estimatedCostUsd;
		if (cost.meanDelta === null || cost.controlMean === null || cost.treatmentMean === null) {
			lines.push("     Est. cost  unavailable");
		} else {
			lines.push(
				`     Est. cost  ${cost.meanDelta >= 0 ? "+" : "-"}$${Math.abs(cost.meanDelta).toFixed(4)} (with $${cost.treatmentMean.toFixed(4)}, without $${cost.controlMean.toFixed(4)}, ${cost.eligiblePairs} pairs)`,
			);
		}
	}
	lines.push("  Operational totals");
	for (const totals of report.operationalTotals) {
		const tokens = operationalMetric(totals.totalTokens, totals.runs, (total) => `${total} tokens`);
		const tools = operationalMetric(totals.toolCalls, totals.runs, (total) => `${total} tools`);
		const latency = operationalMetric(totals.totalMs, totals.runs, (total) => `${(total / 1000).toFixed(2)}s`);
		const cost = operationalMetric(totals.estimatedCostUsd, totals.runs, (total) => `$${total.toFixed(4)} cost`);
		lines.push(`    ${totals.variant}: ${totals.runs} runs, ${tokens}, ${tools}, ${latency}, ${cost}`);
	}
	if (report.blockedPairs.length > 0) {
		lines.push("  Blocked pairs");
		for (const blocked of report.blockedPairs) {
			lines.push(
				`    ${blocked.evalSet}/${blocked.caseId}/${blocked.model}/run-${blocked.runNumber}: ${blocked.reasons.join("; ")}`,
			);
		}
	}
	return lines.join("\n");
}

import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// Provisional Pico5 benchmark schemas. Results are architecture experiments,
// not compatibility commitments for public or persisted ConversationView data.
const PROVISIONAL_SCHEMA = "pico5.conversation-view.provisional.v0";

type Mode = "tracker";
type Scenario =
	| "projection-control"
	| "normal"
	| "fanout"
	| "delayed-start-lag"
	| "churn-reconnect"
	| "overflow-reset"
	| "branch-head-replacement";
type Distribution = {
	count: number;
	totalMs: number;
	medianMs: number;
	p95Ms: number;
	p99Ms: number;
	minMs: number;
	maxMs: number;
};
type PhaseName =
	| "mutation"
	| "prepare"
	| "adopt"
	| "synthesize"
	| "projectApply"
	| "project"
	| "enqueue"
	| "sessionLine"
	| "delivery"
	| "opSerialize"
	| "resetSerialize"
	| "conversationAcquire"
	| "documentAcquire"
	| "conversationSerialize"
	| "documentSerialize"
	| "resetClone";
type Result = {
	mode: Mode;
	scenario: Scenario;
	trial: number;
	provisionalSchema: string;
	headlineEntries: number;
	commitTarget: number;
	initialAggregateBytes: number;
	conversationWatchCount: number;
	documentWatchCount: number;
	queueCapacity: number | null;
	queueCapacityUnit: "pending-operations";
	deliveryModel: "async-serialized-ops-only-no-consumer-apply";
	conversationSequence: number;
	documentSequences: Record<string, number>;
	publishedAggregateBatches: number;
	publishedDocumentBatches: number;
	conversationRegistrations: number;
	documentRegistrations: number;
	conversationBaseBytes: number;
	documentBaseBytes: number;
	noOpCommitCount: number;
	unmountedCommitCount: number;
	resetCount: number;
	resetBytes: number;
	deliveryFrameReferences: number;
	deliveryOperationReferences: number;
	aggregateOperationCount: number;
	aggregateOperationBytes: number;
	documentOperationCount: number;
	documentOperationBytes: number;
	peakQueueReferences: number;
	peakQueuedOperationReferences: number;
	peakPendingOperationsPerWatch: number;
	peakUniqueQueuedBatches: number;
	finalQueueReferences: number;
	finalQueuedOperationReferences: number;
	finalUniqueQueuedBatches: number;
	phaseDistributions: Record<PhaseName, Distribution>;
	authorityReadyMiB: number;
	postAcquireRetainedMiB: number;
	postWorkRetainedMiB: number;
	postVerificationRetainedMiB: number;
	releaseHeapMiB: number;
	releaseTotalMiB: number;
	peakHeapMiB: number;
	peakTotalHeapMiB: number;
	maxRssMiB: number;
	checksum: number;
};
type Failure = { mode: Mode; scenario: Scenario; trial: number; stderr: string };
type NumericResultKey =
	| "initialAggregateBytes"
	| "conversationSequence"
	| "publishedAggregateBatches"
	| "publishedDocumentBatches"
	| "conversationRegistrations"
	| "documentRegistrations"
	| "conversationBaseBytes"
	| "documentBaseBytes"
	| "noOpCommitCount"
	| "unmountedCommitCount"
	| "resetCount"
	| "resetBytes"
	| "deliveryFrameReferences"
	| "deliveryOperationReferences"
	| "aggregateOperationCount"
	| "aggregateOperationBytes"
	| "documentOperationCount"
	| "documentOperationBytes"
	| "peakQueueReferences"
	| "peakQueuedOperationReferences"
	| "peakPendingOperationsPerWatch"
	| "peakUniqueQueuedBatches"
	| "finalQueueReferences"
	| "finalQueuedOperationReferences"
	| "finalUniqueQueuedBatches"
	| "authorityReadyMiB"
	| "postAcquireRetainedMiB"
	| "postWorkRetainedMiB"
	| "postVerificationRetainedMiB"
	| "releaseHeapMiB"
	| "releaseTotalMiB"
	| "peakHeapMiB"
	| "peakTotalHeapMiB"
	| "maxRssMiB";

type SummaryValue = { median: number | null; range: readonly [number, number] | null };

const modes: readonly Mode[] = ["tracker"];
const scenarios: readonly Scenario[] = [
	"projection-control",
	"normal",
	"fanout",
	"delayed-start-lag",
	"churn-reconnect",
	"overflow-reset",
	"branch-head-replacement",
];
const phaseNames: readonly PhaseName[] = [
	"mutation",
	"prepare",
	"adopt",
	"synthesize",
	"projectApply",
	"project",
	"enqueue",
	"sessionLine",
	"delivery",
	"opSerialize",
	"resetSerialize",
	"conversationAcquire",
	"documentAcquire",
	"conversationSerialize",
	"documentSerialize",
	"resetClone",
];
const numericMetrics: readonly NumericResultKey[] = [
	"initialAggregateBytes",
	"conversationSequence",
	"publishedAggregateBatches",
	"publishedDocumentBatches",
	"conversationRegistrations",
	"documentRegistrations",
	"conversationBaseBytes",
	"documentBaseBytes",
	"noOpCommitCount",
	"unmountedCommitCount",
	"resetCount",
	"resetBytes",
	"deliveryFrameReferences",
	"deliveryOperationReferences",
	"aggregateOperationCount",
	"aggregateOperationBytes",
	"documentOperationCount",
	"documentOperationBytes",
	"peakQueueReferences",
	"peakQueuedOperationReferences",
	"peakPendingOperationsPerWatch",
	"peakUniqueQueuedBatches",
	"finalQueueReferences",
	"finalQueuedOperationReferences",
	"finalUniqueQueuedBatches",
	"authorityReadyMiB",
	"postAcquireRetainedMiB",
	"postWorkRetainedMiB",
	"postVerificationRetainedMiB",
	"releaseHeapMiB",
	"releaseTotalMiB",
	"peakHeapMiB",
	"peakTotalHeapMiB",
	"maxRssMiB",
];

function optionNumber(name: string, fallback: number): number {
	const prefix = `--${name}=`;
	const raw = process.argv.find((argument) => argument.startsWith(prefix))?.slice(prefix.length);
	if (raw === undefined) return fallback;
	const value = Number(raw);
	if (!Number.isSafeInteger(value) || value < 1) throw new RangeError(`Invalid --${name}`);
	return value;
}

function median(values: readonly number[]): number | null {
	if (values.length === 0) return null;
	const ordered = [...values].sort((left, right) => left - right);
	return ordered[Math.floor(ordered.length / 2)]!;
}

function range(values: readonly number[]): readonly [number, number] | null {
	return values.length === 0 ? null : [Math.min(...values), Math.max(...values)];
}

function summarize(values: readonly number[]): SummaryValue {
	return { median: median(values), range: range(values) };
}

const quick = process.argv.includes("--quick");
const selectedScenario = process.argv
	.find((argument) => argument.startsWith("--scenario="))
	?.slice("--scenario=".length);
if (selectedScenario !== undefined && !(scenarios as readonly string[]).includes(selectedScenario)) {
	throw new Error(`Unknown scenario ${selectedScenario}`);
}
const selectedScenarios = selectedScenario === undefined ? scenarios : [selectedScenario as Scenario];
const headlineEntries = optionNumber("entries", quick ? 128 : 512);
const commits = optionNumber("commits", quick ? 120 : 1_000);
const trials = optionNumber("trials", quick ? 1 : 3);
const queueOperationCapacity = quick ? 64 : 256;
const root = fileURLToPath(new URL("../../../..", import.meta.url));
const worker = fileURLToPath(new URL("./conversation-view-benchmark.worker.ts", import.meta.url));
const results: Result[] = [];
const failures: Failure[] = [];

for (let trial = 0; trial < trials; trial++) {
	for (const scenario of selectedScenarios) {
		const offset = trial % modes.length;
		const trialModes = [...modes.slice(offset), ...modes.slice(0, offset)];
		for (const mode of trialModes) {
			const child = spawnSync(
				process.execPath,
				[
					"--expose-gc",
					"--max-old-space-size=4096",
					worker,
					mode,
					scenario,
					String(headlineEntries),
					String(commits),
					String(trial),
					String(queueOperationCapacity),
				],
				{ cwd: root, encoding: "utf8", timeout: 300_000, maxBuffer: 20 * 1024 * 1024 },
			);
			if (child.status !== 0) {
				const failure = { mode, scenario, trial, stderr: child.stderr } satisfies Failure;
				failures.push(failure);
				console.log(JSON.stringify(failure));
				continue;
			}
			const result = JSON.parse(child.stdout) as Result;
			results.push(result);
			console.log(JSON.stringify(result));
		}
	}
}

const summary = selectedScenarios.flatMap((scenario) =>
	modes.map((mode) => {
		const selected = results.filter((result) => result.scenario === scenario && result.mode === mode);
		const metrics: Record<string, SummaryValue> = {};
		for (const metric of numericMetrics) metrics[metric] = summarize(selected.map((result) => result[metric]));
		const phases: Record<
			string,
			{ medianMs: SummaryValue; p95Ms: SummaryValue; p99Ms: SummaryValue; totalMs: SummaryValue }
		> = {};
		for (const phase of phaseNames) {
			phases[phase] = {
				medianMs: summarize(selected.map((result) => result.phaseDistributions[phase].medianMs)),
				p95Ms: summarize(selected.map((result) => result.phaseDistributions[phase].p95Ms)),
				p99Ms: summarize(selected.map((result) => result.phaseDistributions[phase].p99Ms)),
				totalMs: summarize(selected.map((result) => result.phaseDistributions[phase].totalMs)),
			};
		}
		return {
			mode,
			scenario,
			provisionalSchema: PROVISIONAL_SCHEMA,
			conversationWatchCount: selected[0]?.conversationWatchCount ?? 0,
			documentWatchCount: selected[0]?.documentWatchCount ?? 0,
			queueCapacity: selected[0]?.queueCapacity ?? null,
			queueCapacityUnit: "pending-operations",
			deliveryModel: "async-serialized-ops-only-no-consumer-apply",
			metrics,
			phases,
		};
	}),
);

const output = join(tmpdir(), "chord-conversation-view-benchmark.json");
writeFileSync(
	output,
	JSON.stringify(
		{
			node: process.version,
			provisionalSchema: PROVISIONAL_SCHEMA,
			profile: "local-pico5-provisional-conversation-view",
			headlineEntries,
			commits,
			trials,
			queueOperationCapacity,
			results,
			failures,
			summary,
		},
		null,
		2,
	),
);
console.log(
	JSON.stringify({
		output,
		node: process.version,
		provisionalSchema: PROVISIONAL_SCHEMA,
		headlineEntries,
		commits,
		trials,
		queueOperationCapacity,
		failures: failures.length,
		summary,
	}),
);

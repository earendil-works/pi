import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

type Mode = "tracker";
type Scenario =
	| "import"
	| "committed-read"
	| "draft-read"
	| "sparse"
	| "queue"
	| "sort"
	| "dense"
	| "unshift"
	| "watch-authority-control"
	| "watch-live-borrowed"
	| "watch-acquire-shared"
	| "watch-acquire-detached"
	| "watch-acquire-staggered"
	| "watch-lag"
	| "watch-catch-up"
	| "watch-catch-up-coalesced"
	| "watch-live-immutable";
type Result = {
	mode: Mode;
	scenario: Scenario;
	size: number;
	trial: number;
	queueOperations: number;
	watchProfile: string | null;
	watchCount: number;
	watchUpdates: number;
	queuedBatchReferences: number;
	importMs: number;
	mutateMs: number;
	prepareMs: number;
	serializeMs: number;
	adoptMs: number;
	acquireMs: number;
	enqueueMs: number;
	deliveryMs: number;
	scenarioWorkMs: number;
	opBytes: number;
	operationCount: number;
	checksum: number;
	readyMiB: number;
	sampledAcquireMiB: number;
	sampledTransientMiB: number;
	retainedMiB: number;
	retainedOverReadyMiB: number;
	postAcquireRetainedMiB: number;
	postLagRetainedMiB: number;
	postDeliveryRetainedMiB: number;
	releasedRetainedMiB: number;
	maxRssMiB: number;
};

type Failure = { mode: Mode; scenario: Scenario; trial: number; stderr: string };

const ordinaryScenarios: readonly Scenario[] = [
	"import",
	"committed-read",
	"draft-read",
	"sparse",
	"queue",
	"sort",
	"dense",
	"unshift",
];
const watchScenarios: readonly Scenario[] = [
	"watch-authority-control",
	"watch-live-borrowed",
	"watch-acquire-shared",
	"watch-acquire-detached",
	"watch-acquire-staggered",
	"watch-lag",
	"watch-catch-up",
	"watch-catch-up-coalesced",
	"watch-live-immutable",
];
const modes: readonly Mode[] = ["tracker"];
const quick = process.argv.includes("--quick");
const watchOnly = process.argv.includes("--watch-only");
const ordinaryOnly = process.argv.includes("--ordinary-only");
if (watchOnly && ordinaryOnly) throw new Error("Choose at most one scenario filter");
const scenarios = watchOnly
	? watchScenarios
	: ordinaryOnly
		? ordinaryScenarios
		: [...ordinaryScenarios, ...watchScenarios];
const size = quick ? 10_000 : 100_000;
const trials = quick ? 1 : 3;
const watchCount = quick ? 4 : 8;
const watchUpdates = quick ? 20 : 100;
const root = fileURLToPath(new URL("../../../..", import.meta.url));
const worker = fileURLToPath(new URL("./benchmark.worker.ts", import.meta.url));
const results: Result[] = [];
const failures: Failure[] = [];

for (let trial = 0; trial < trials; trial++) {
	for (const scenario of scenarios) {
		for (const mode of modes) {
			const child = spawnSync(
				process.execPath,
				[
					"--expose-gc",
					"--max-old-space-size=4096",
					worker,
					mode,
					scenario,
					String(size),
					String(trial),
					String(watchCount),
					String(watchUpdates),
				],
				{ cwd: root, encoding: "utf8", timeout: 300_000, maxBuffer: 10 * 1024 * 1024 },
			);
			if (child.status !== 0) {
				const failure = { mode, scenario, trial, stderr: child.stderr } satisfies Failure;
				failures.push(failure);
				console.log(JSON.stringify(failure));
			} else {
				const result = JSON.parse(child.stdout) as Result;
				results.push(result);
				console.log(JSON.stringify(result));
			}
		}
	}
}

const average = (values: readonly number[]): number | null =>
	values.length === 0 ? null : values.reduce((total, value) => total + value, 0) / values.length;
const median = (values: readonly number[]): number | null => {
	if (values.length === 0) return null;
	const ordered = [...values].sort((left, right) => left - right);
	return ordered[Math.floor(ordered.length / 2)]!;
};
const range = (values: readonly number[]): readonly [number, number] | null =>
	values.length === 0 ? null : [Math.min(...values), Math.max(...values)];
const metricNames = [
	"importMs",
	"mutateMs",
	"prepareMs",
	"serializeMs",
	"adoptMs",
	"acquireMs",
	"enqueueMs",
	"deliveryMs",
	"scenarioWorkMs",
	"opBytes",
	"operationCount",
	"readyMiB",
	"sampledAcquireMiB",
	"sampledTransientMiB",
	"retainedMiB",
	"retainedOverReadyMiB",
	"postAcquireRetainedMiB",
	"postLagRetainedMiB",
	"postDeliveryRetainedMiB",
	"releasedRetainedMiB",
	"maxRssMiB",
] as const satisfies readonly (keyof Result)[];

const summary = scenarios.flatMap((scenario) =>
	modes.map((mode) => {
		const selected = results.filter((result) => result.mode === mode && result.scenario === scenario);
		const averages: Record<string, number | null> = {};
		const medians: Record<string, number | null> = {};
		const ranges: Record<string, readonly [number, number] | null> = {};
		for (const metric of metricNames) {
			const values = selected.map((result) => result[metric]);
			averages[metric] = average(values);
			medians[metric] = median(values);
			ranges[metric] = range(values);
		}
		return {
			mode,
			scenario,
			watchProfile: selected[0]?.watchProfile ?? null,
			watchCount: selected[0]?.watchCount ?? 0,
			watchUpdates: selected[0]?.watchUpdates ?? 0,
			averages,
			medians,
			ranges,
		};
	}),
);
const output = join(tmpdir(), "chord-delta-benchmark.json");
writeFileSync(
	output,
	JSON.stringify(
		{ node: process.version, size, trials, watchCount, watchUpdates, results, failures, summary },
		null,
		2,
	),
);
console.log(
	JSON.stringify({
		output,
		node: process.version,
		size,
		trials,
		watchCount,
		watchUpdates,
		failures: failures.length,
		summary,
	}),
);

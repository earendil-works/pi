import { randomUUID } from "node:crypto";
import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Reporter, SerializedError, TestCase, TestModule, TestRunEndReason, Vitest } from "vitest/node";
import { isHarnessRun } from "vitest-evals/harness";
import { PI_SESSION_SNAPSHOT_ARTIFACT, persistEvalArtifactReferences } from "./artifacts.ts";
import { EVAL_HARNESS_ITERATION_ARTIFACT, parseEvalHarnessIterationArtifact } from "./harness-table.ts";
import { formatHarnessComparisonReport, type HarnessObservation, summarizeHarnessComparisons } from "./summary.ts";

function readFiniteNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

async function appendHarnessRunReport(test: TestCase): Promise<void> {
	const artifactDirectory = process.env.PI_EVAL_ARTIFACT_DIR?.trim();
	if (!artifactDirectory) return;
	const harness = test.meta().harness;
	if (!harness || !isHarnessRun(harness.run)) return;

	const run = harness.run;
	const artifactRunId = run.artifacts?.runId;
	const runId = typeof artifactRunId === "string" ? artifactRunId : randomUUID();
	const metadata = Object.fromEntries(
		Object.entries(run.artifacts ?? {}).filter(([name]) => name !== "runId" && name !== PI_SESSION_SNAPSHOT_ARTIFACT),
	);
	const record = {
		schemaVersion: 1,
		runId,
		test: {
			id: test.id,
			file: test.module.relativeModuleId,
			name: test.name,
			fullName: test.fullName,
			status: test.result().state,
		},
		harness: harness.name,
		usage: run.usage,
		...(run.timings ? { timings: run.timings } : {}),
		...(run.errors.length > 0 ? { errors: run.errors } : {}),
		artifacts: await persistEvalArtifactReferences(test.artifacts(), runId, artifactDirectory),
		...(Object.keys(metadata).length > 0 ? { metadata } : {}),
	};
	await mkdir(artifactDirectory, { recursive: true, mode: 0o700 });
	await appendFile(join(artifactDirectory, "runs.jsonl"), `${JSON.stringify(record)}\n`, {
		encoding: "utf8",
		flag: "a",
		mode: 0o600,
	});
}

function collectHarnessObservations(modules: ReadonlyArray<TestModule>): HarnessObservation[] {
	const observations: HarnessObservation[] = [];
	for (const module of modules) {
		for (const test of module.children.allTests()) {
			const harness = test.meta().harness;
			if (!harness || !isHarnessRun(harness.run)) continue;
			const run = harness.run;
			const iteration = parseEvalHarnessIterationArtifact(run.artifacts?.[EVAL_HARNESS_ITERATION_ARTIFACT]);
			if (!iteration) continue;
			const score = readFiniteNumber(test.meta().eval?.avgScore);
			const estimatedCostUsd = readFiniteNumber(run.usage.metadata?.estimatedCostUsd);
			const observation = {
				evalSet: iteration.evalSet,
				groupKey: iteration.groupKey,
				testName: test.name,
				file: module.relativeModuleId,
				harness: iteration.harness,
				baseline: iteration.baseline,
				candidates: iteration.candidates,
				repetition: iteration.repetition,
				...(run.usage.totalTokens === undefined ? {} : { totalTokens: run.usage.totalTokens }),
				...(run.timings?.totalMs === undefined ? {} : { totalMs: run.timings.totalMs }),
				...(estimatedCostUsd === undefined ? {} : { estimatedCostUsd }),
			};
			if (run.errors.length > 0) observations.push({ ...observation, outcome: "errored" });
			else if (score !== undefined) observations.push({ ...observation, outcome: "scored", score });
			else {
				const state = test.result().state;
				const outcome = state === "passed" ? "unscored" : state === "failed" ? "errored" : state;
				observations.push({ ...observation, outcome });
			}
		}
	}
	return observations;
}

export default class EvalHarnessReporter implements Reporter {
	private vitest: Vitest | undefined;

	onInit(vitest: Vitest): void {
		this.vitest = vitest;
	}

	async onTestCaseResult(test: TestCase): Promise<void> {
		await appendHarnessRunReport(test);
	}

	onTestRunEnd(
		modules: ReadonlyArray<TestModule>,
		_errors: ReadonlyArray<SerializedError>,
		reason: TestRunEndReason,
	): void {
		if (reason === "interrupted") {
			this.vitest?.logger.log("\nEval comparisons unavailable: test run interrupted.");
			return;
		}
		const report = summarizeHarnessComparisons(collectHarnessObservations(modules));
		const formatted = formatHarnessComparisonReport(report);
		if (formatted) this.vitest?.logger.log(`\n${formatted}`);
	}
}

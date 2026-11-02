import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { EvalTask } from "../src/plan.ts";
import { PI_SESSION_SNAPSHOT_ARTIFACT, readTaskObservation } from "../src/report.ts";

const temporaryDirectories: string[] = [];
afterEach(async () => {
	await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

const task: EvalTask = {
	file: "evals/example.docs.eval.ts",
	fullName: "Example workflow > handles the case",
	evalSet: "Example workflow",
	caseId: "handles the case",
	variant: "without_docs",
	model: "fixture/model",
	runNumber: 1,
};
const SESSION = '{"type":"session"}\n';

type ReportAssertion = {
	caseId?: string;
	status?: "passed" | "skipped" | "pending" | "todo" | "disabled" | "failed";
	meta?: Record<string, unknown>;
};

async function writeTaskReport(assertions: ReportAssertion[]) {
	const directory = await mkdtemp(join(tmpdir(), "pi-eval-report-test-"));
	temporaryDirectories.push(directory);
	const reportPath = join(directory, "vitest.json");
	const results = assertions.map(({ caseId = task.caseId, status = "passed", meta = {} }) => ({
		ancestorTitles: [task.evalSet],
		fullName: `${task.evalSet} ${caseId}`,
		status,
		title: caseId,
		failureMessages: [],
		meta,
	}));
	const count = (status: ReportAssertion["status"]): number =>
		results.filter((result) => result.status === status).length;
	await writeFile(
		reportPath,
		JSON.stringify({
			numFailedTests: count("failed"),
			numPassedTests: count("passed"),
			numPendingTests: count("pending") + count("skipped") + count("disabled"),
			numTodoTests: count("todo"),
			numTotalTests: results.length,
			startTime: 0,
			success: count("failed") === 0,
			testResults: [
				{
					message: "",
					name: "/repo/packages/evals/evals/example.docs.eval.ts",
					status: count("failed") === 0 ? "passed" : "failed",
					assertionResults: results,
				},
			],
		}),
	);
	return { directory, reportPath };
}

function scoredMeta(overrides?: {
	avgScore?: number | null;
	model?: string;
	errors?: Array<Record<string, string>>;
	artifacts?: Record<string, string>;
}): Record<string, unknown> {
	return {
		eval: {
			avgScore: overrides && "avgScore" in overrides ? overrides.avgScore : 0.5,
			scores: [{ name: "StructuredOutputJudge", score: 0.5 }],
			thresholdFailed: false,
		},
		harness: {
			name: "without_docs",
			run: {
				output: { ok: true },
				session: { events: [{ type: "message", role: "user", content: "prompt" }] },
				usage: {
					provider: "fixture",
					model: overrides?.model ?? "model",
					inputTokens: 10,
					outputTokens: 5,
					totalTokens: 15,
					toolCalls: 1,
					metadata: { cacheReadTokens: 2, cacheWriteTokens: 3, estimatedCostUsd: 0.01 },
				},
				timings: { totalMs: 1234 },
				artifacts: overrides?.artifacts ?? { runId: "run-1", [PI_SESSION_SNAPSHOT_ARTIFACT]: SESSION },
				errors: overrides?.errors ?? [],
			},
		},
	};
}

async function readObservation(assertion: ReportAssertion = {}) {
	const { directory, reportPath } = await writeTaskReport([assertion]);
	return { directory, observation: await readTaskObservation(task, reportPath, directory) };
}

describe("readTaskObservation", () => {
	it.each(["skipped", "todo", "disabled"] as const)(
		"preserves a skipped outcome for %s cases without harness runs",
		async (status) => {
			const { observation } = await readObservation({ status });
			expect(observation).toMatchObject({ outcome: "skipped" });
		},
	);

	it("preserves a pending outcome when no harness run exists", async () => {
		const { observation } = await readObservation({ status: "pending" });
		expect(observation).toMatchObject({ outcome: "pending" });
	});

	it("preserves metrics from a failed eval with a partial harness run", async () => {
		const { directory, observation } = await readObservation({
			status: "failed",
			meta: scoredMeta(),
		});
		expect(observation).toEqual({
			evalSet: task.evalSet,
			caseId: task.caseId,
			variant: task.variant,
			model: task.model,
			runNumber: task.runNumber,
			outcome: "errored",
			inputTokens: 10,
			outputTokens: 5,
			cacheReadTokens: 2,
			cacheWriteTokens: 3,
			totalTokens: 15,
			toolCalls: 1,
			totalMs: 1234,
			estimatedCostUsd: 0.01,
		});
		const hashes = await readdir(join(directory, task.variant, "sessions"));
		await expect(
			readFile(join(directory, task.variant, "sessions", hashes[0], "session.jsonl"), "utf8"),
		).resolves.toBe(SESSION);
	});

	it("records an errored outcome when a passed eval has no harness run", async () => {
		const { observation } = await readObservation({ status: "passed" });
		expect(observation).toMatchObject({ outcome: "errored" });
	});

	it("reads a scored harness run and persists the session artifact", async () => {
		const { directory, observation } = await readObservation({ meta: scoredMeta() });
		expect(observation).toEqual({
			evalSet: task.evalSet,
			caseId: task.caseId,
			variant: task.variant,
			model: task.model,
			runNumber: task.runNumber,
			outcome: "scored",
			score: 0.5,
			inputTokens: 10,
			outputTokens: 5,
			cacheReadTokens: 2,
			cacheWriteTokens: 3,
			totalTokens: 15,
			toolCalls: 1,
			totalMs: 1234,
			estimatedCostUsd: 0.01,
		});
		const hashes = await readdir(join(directory, task.variant, "sessions"));
		expect(hashes).toHaveLength(1);
		await expect(
			readFile(join(directory, task.variant, "sessions", hashes[0], "session.jsonl"), "utf8"),
		).resolves.toBe(SESSION);
	});

	it("selects the requested case when a sibling case is skipped", async () => {
		const { directory, reportPath } = await writeTaskReport([
			{ caseId: "sibling case", status: "skipped" },
			{ caseId: task.caseId, meta: scoredMeta() },
		]);
		const observation = await readTaskObservation(task, reportPath, directory);
		expect(observation).toMatchObject({ outcome: "scored", score: 0.5, totalTokens: 15 });
	});

	it("treats a zero score as scored data", async () => {
		const { observation } = await readObservation({ meta: scoredMeta({ avgScore: 0 }) });
		expect(observation).toMatchObject({ outcome: "scored", score: 0 });
	});

	it("records an unscored outcome when a completed eval has no score", async () => {
		const { observation } = await readObservation({ meta: scoredMeta({ avgScore: null }) });
		expect(observation).toMatchObject({ outcome: "unscored" });
	});

	it("records an errored outcome when the reported model does not match the task", async () => {
		const { observation } = await readObservation({ meta: scoredMeta({ model: "other" }) });
		expect(observation).toMatchObject({ outcome: "errored" });
	});

	it("records an errored outcome when a completed harness run contains errors", async () => {
		const { observation } = await readObservation({ meta: scoredMeta({ errors: [{ message: "boom" }] }) });
		expect(observation).toMatchObject({ outcome: "errored" });
	});

	it("still scores a completed eval when the session artifact is missing", async () => {
		const { observation } = await readObservation({ meta: scoredMeta({ artifacts: { runId: "run-1" } }) });
		expect(observation).toMatchObject({ outcome: "scored", score: 0.5 });
	});
});

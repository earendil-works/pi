import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { buildMissionIterationPrompt } from "../src/missions/build-mission-prompt.js";
import { runMissionLoop } from "../src/missions/mission-runner.js";
import { parseMissionDefinition } from "../src/missions/parse-mission.js";

function makeMissionDir(): { dir: string; cleanup: () => void } {
	const dir = mkdtempSync(join(tmpdir(), "mu-mission-optimize-red-"));
	return {
		dir,
		cleanup: () => rmSync(dir, { recursive: true, force: true }),
	};
}

function writeOptimizeMissionFiles(
	dir: string,
	options?: {
		tasksJson?: string;
		experimentsJsonl?: string;
		spec?: string;
		progress?: string;
		runbook?: string;
	},
): void {
	writeFileSync(
		join(dir, "SPEC.md"),
		options?.spec ??
			[
				"---",
				"mode: optimize",
				"metric: duration_seconds",
				"direction: lower",
				"---",
				"",
				"# Goal",
				"Optimize the billing benchmark.",
				"",
				"# Benchmark",
				"./benchmark.sh",
				"",
				"# Validation",
				"npm test",
			].join("\n"),
	);
	writeFileSync(
		join(dir, "PROGRESS.md"),
		options?.progress ?? ["# Progress", "", "## Baseline", "- duration_seconds: not yet recorded"].join("\n"),
	);
	writeFileSync(
		join(dir, "RUNBOOK.md"),
		options?.runbook ??
			[
				"# Runbook",
				"",
				"1. Read SPEC.md, PROGRESS.md, and EXPERIMENTS.jsonl.",
				"2. Run the baseline benchmark if needed.",
				"3. Brainstorm one promising small change.",
				"4. Run benchmark + validation.",
				"5. Keep / discard / crash / blocked.",
			].join("\n"),
	);
	writeFileSync(join(dir, "EXPERIMENTS.jsonl"), options?.experimentsJsonl ?? "");
	if (options?.tasksJson !== undefined) {
		writeFileSync(join(dir, "TASKS.json"), options.tasksJson);
	}
}

describe("optimize-mode missions (red)", () => {
	const cleanups: Array<() => void> = [];

	afterEach(() => {
		for (const cleanup of cleanups.splice(0)) {
			cleanup();
		}
	});

	it("parses an optimize-mode mission without requiring TASKS.json", () => {
		const { dir, cleanup } = makeMissionDir();
		cleanups.push(cleanup);
		writeOptimizeMissionFiles(dir);

		const mission = parseMissionDefinition(dir);

		expect(mission.dir).toBe(dir);
		expect(mission.specText).toContain("mode: optimize");
		expect("mode" in mission).toBe(true);
		expect((mission as { mode?: string }).mode).toBe("optimize");
	});

	it("parses optimize convergence settings from SPEC.md frontmatter", () => {
		const { dir, cleanup } = makeMissionDir();
		cleanups.push(cleanup);
		writeOptimizeMissionFiles(dir, {
			spec: [
				"---",
				"mode: optimize",
				"metric: duration_seconds",
				"direction: lower",
				"converge_after: 3",
				"convergence_kind: discard",
				"---",
				"",
				"# Goal",
				"Optimize the billing benchmark.",
			].join("\n"),
		});

		const mission = parseMissionDefinition(dir) as { convergeAfter?: number; convergenceKind?: string };

		expect(mission.convergeAfter).toBe(3);
		expect(mission.convergenceKind).toBe("discard");
	});

	it("builds an optimize-specific stable prompt instead of the build-mode stop rule", () => {
		const { dir, cleanup } = makeMissionDir();
		cleanups.push(cleanup);
		writeOptimizeMissionFiles(dir, {
			tasksJson: JSON.stringify(
				{
					tasks: [{ id: "seed", title: "Try profiling first", status: "todo", validation: [], notes: "" }],
				},
				null,
				2,
			),
		});

		const mission = parseMissionDefinition(dir);
		const prompt = buildMissionIterationPrompt(mission);

		expect(prompt).toContain("EXPERIMENTS.jsonl");
		expect(prompt).toMatch(/baseline benchmark/i);
		expect(prompt).toMatch(/keep|discard|crash|blocked/i);
		expect(prompt).not.toMatch(/all task statuses.*done/i);
		expect(prompt).not.toMatch(/work exactly one task at a time/i);
	});

	it("does not terminate optimize mode immediately just because seed tasks are done", async () => {
		const { dir, cleanup } = makeMissionDir();
		cleanups.push(cleanup);
		writeOptimizeMissionFiles(dir, {
			tasksJson: JSON.stringify(
				{
					tasks: [{ id: "seed", title: "Already explored", status: "done", validation: [], notes: "" }],
				},
				null,
				2,
			),
		});

		let iterations = 0;
		await expect(
			runMissionLoop({
				missionDir: dir,
				executeIteration: async () => {
					iterations += 1;
					appendFileSync(
						join(dir, "EXPERIMENTS.jsonl"),
						JSON.stringify({ run: iterations, status: "discard", metric: 42.3, description: "baseline try" }) +
							"\n",
					);
					if (iterations >= 1) {
						throw new Error("stop-after-first-optimize-iteration");
					}
				},
			}),
		).rejects.toThrow(/stop-after-first-optimize-iteration/);

		expect(iterations).toBe(1);
	});

	it("terminates optimize mode after a blocked iteration recorded in EXPERIMENTS.jsonl", async () => {
		const { dir, cleanup } = makeMissionDir();
		cleanups.push(cleanup);
		writeOptimizeMissionFiles(dir, {
			tasksJson: JSON.stringify(
				{
					tasks: [{ id: "seed", title: "Needs user login", status: "blocked", validation: [], notes: "" }],
				},
				null,
				2,
			),
		});

		let iterations = 0;
		const result = await runMissionLoop({
			missionDir: dir,
			maxIterations: 5,
			executeIteration: async () => {
				iterations += 1;
				appendFileSync(
					join(dir, "EXPERIMENTS.jsonl"),
					JSON.stringify({ run: iterations, status: "blocked", reason: "User must restore auth first" }) + "\n",
				);
			},
		});

		expect(iterations).toBe(1);
		expect(result.status).toBe("blocked");
		if (result.status !== "blocked") {
			throw new Error(`Expected blocked result, received ${result.status}`);
		}
		expect(result.iterations).toBe(1);
		expect(result.reason).toMatch(/restore auth/i);
	});

	it("converges optimize mode after three straight discards when SPEC.md asks for discard convergence", async () => {
		const { dir, cleanup } = makeMissionDir();
		cleanups.push(cleanup);
		writeOptimizeMissionFiles(dir, {
			spec: [
				"---",
				"mode: optimize",
				"metric: duration_seconds",
				"direction: lower",
				"converge_after: 3",
				"convergence_kind: discard",
				"---",
				"",
				"# Goal",
				"Optimize the billing benchmark.",
				"",
				"# Benchmark",
				"./benchmark.sh",
				"",
				"# Validation",
				"npm test",
			].join("\n"),
		});

		let iterations = 0;
		const result = (await runMissionLoop({
			missionDir: dir,
			maxIterations: 5,
			executeIteration: async () => {
				iterations += 1;
				appendFileSync(
					join(dir, "EXPERIMENTS.jsonl"),
					JSON.stringify({
						run: iterations,
						status: "discard",
						metric: 42.3 + iterations,
						description: `try ${iterations}`,
					}) + "\n",
				);
			},
		})) as { status: string; iterations: number; reason?: string };

		expect(result.status).toBe("converged");
		expect(result.iterations).toBe(3);
		expect(iterations).toBe(3);
	});

	it("uses non-keep convergence by default so discard, crash, discard stops optimize mode after three tries without a keep", async () => {
		const { dir, cleanup } = makeMissionDir();
		cleanups.push(cleanup);
		writeOptimizeMissionFiles(dir, {
			spec: [
				"---",
				"mode: optimize",
				"metric: duration_seconds",
				"direction: lower",
				"converge_after: 3",
				"---",
				"",
				"# Goal",
				"Optimize the billing benchmark.",
				"",
				"# Benchmark",
				"./benchmark.sh",
				"",
				"# Validation",
				"npm test",
			].join("\n"),
		});

		let iterations = 0;
		const statuses = ["discard", "crash", "discard"] as const;
		const result = (await runMissionLoop({
			missionDir: dir,
			maxIterations: 5,
			executeIteration: async () => {
				const status = statuses[iterations] ?? "discard";
				iterations += 1;
				appendFileSync(
					join(dir, "EXPERIMENTS.jsonl"),
					JSON.stringify({
						run: iterations,
						status,
						metric: 42.3 + iterations,
						description: `try ${iterations}`,
					}) + "\n",
				);
			},
		})) as { status: string; iterations: number; reason?: string };

		expect(result.status).toBe("converged");
		expect(result.iterations).toBe(3);
		expect(iterations).toBe(3);
	});

	it("resets the convergence streak after a keep before counting later non-keeps", async () => {
		const { dir, cleanup } = makeMissionDir();
		cleanups.push(cleanup);
		writeOptimizeMissionFiles(dir, {
			spec: [
				"---",
				"mode: optimize",
				"metric: duration_seconds",
				"direction: lower",
				"converge_after: 3",
				"---",
				"",
				"# Goal",
				"Optimize the billing benchmark.",
			].join("\n"),
		});

		let iterations = 0;
		const statuses = ["discard", "discard", "keep", "discard", "discard", "discard"] as const;
		const result = (await runMissionLoop({
			missionDir: dir,
			maxIterations: 8,
			executeIteration: async () => {
				const status = statuses[iterations] ?? "discard";
				iterations += 1;
				appendFileSync(
					join(dir, "EXPERIMENTS.jsonl"),
					JSON.stringify({
						run: iterations,
						status,
						metric: 42.3 + iterations,
						description: `try ${iterations}`,
					}) + "\n",
				);
			},
		})) as { status: string; iterations: number; reason?: string };

		expect(result.status).toBe("converged");
		expect(result.iterations).toBe(6);
		expect(iterations).toBe(6);
	});

	it("treats EXPERIMENTS.jsonl as append-only optimize history", async () => {
		const { dir, cleanup } = makeMissionDir();
		cleanups.push(cleanup);
		writeOptimizeMissionFiles(dir, {
			experimentsJsonl: `${JSON.stringify({ type: "config", metric: "duration_seconds", direction: "lower" })}\n`,
			tasksJson: JSON.stringify(
				{
					tasks: [{ id: "seed", title: "Profile slow setup", status: "todo", validation: [], notes: "" }],
				},
				null,
				2,
			),
		});

		await expect(
			runMissionLoop({
				missionDir: dir,
				executeIteration: async () => {
					appendFileSync(
						join(dir, "EXPERIMENTS.jsonl"),
						JSON.stringify({ run: 1, status: "keep", metric: 38.1, description: "parallelized setup" }) + "\n",
					);
					throw new Error("stop-after-append");
				},
			}),
		).rejects.toThrow(/stop-after-append/);

		const lines = readFileSync(join(dir, "EXPERIMENTS.jsonl"), "utf8").trim().split("\n");

		expect(lines).toHaveLength(2);
		expect(JSON.parse(lines[0] ?? "{}")).toMatchObject({ type: "config" });
		expect(JSON.parse(lines[1] ?? "{}")).toMatchObject({ run: 1, status: "keep" });
	});
});

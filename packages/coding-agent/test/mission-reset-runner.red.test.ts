import { appendFileSync, cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { runMissionLoop } from "../src/missions/mission-runner.js";
import { parseMissionDefinition } from "../src/missions/parse-mission.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixtureRoot = join(__dirname, "fixtures", "mission-reset-control-event");

function copyFixtureMission(name: string): { dir: string; cleanup: () => void } {
	const dir = mkdtempSync(join(tmpdir(), `mu-mission-reset-runner-red-${name}-`));
	cpSync(join(fixtureRoot, name), dir, { recursive: true });
	return {
		dir,
		cleanup: () => rmSync(dir, { recursive: true, force: true }),
	};
}

function appendResumeResetEvent(dir: string): void {
	appendFileSync(
		join(dir, "EXPERIMENTS.jsonl"),
		JSON.stringify({
			type: "control",
			kind: "resume-reset",
			timestamp: 1760000000000,
			note: "Manual resume reset",
		}) + "\n",
	);
}

describe("mission reset runner semantics (red)", () => {
	const cleanups: Array<() => void> = [];

	afterEach(() => {
		for (const cleanup of cleanups.splice(0)) {
			cleanup();
		}
	});

	it("allows a converged optimize mission to execute a fresh iteration after a resume-reset barrier", async () => {
		const { dir, cleanup } = copyFixtureMission("optimize-converged");
		cleanups.push(cleanup);
		appendResumeResetEvent(dir);

		let iterations = 0;
		await expect(
			runMissionLoop({
				missionDir: dir,
				maxIterations: 2,
				executeIteration: async () => {
					iterations += 1;
					throw new Error("stop-after-first-post-reset-iteration");
				},
			}),
		).rejects.toThrow(/stop-after-first-post-reset-iteration/);

		expect(iterations).toBe(1);
	});

	it("treats control events as barriers instead of experiment outcomes when parsing history", () => {
		const { dir, cleanup } = copyFixtureMission("optimize-blocked");
		cleanups.push(cleanup);
		appendResumeResetEvent(dir);

		const mission = parseMissionDefinition(dir);

		expect(mission.latestExperimentResult).toBeUndefined();
		expect(mission.optimizeStatusesSinceReset).toEqual([]);
	});

	it("allows a previously blocked optimize mission to execute a fresh iteration after a resume-reset barrier", async () => {
		const { dir, cleanup } = copyFixtureMission("optimize-blocked");
		cleanups.push(cleanup);
		appendResumeResetEvent(dir);

		let iterations = 0;
		await expect(
			runMissionLoop({
				missionDir: dir,
				maxIterations: 2,
				executeIteration: async () => {
					iterations += 1;
					throw new Error("stop-after-first-post-reset-iteration");
				},
			}),
		).rejects.toThrow(/stop-after-first-post-reset-iteration/);

		expect(iterations).toBe(1);
	});
});

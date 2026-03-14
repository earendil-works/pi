import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { runMissionLoop } from "../src/missions/mission-runner.js";

function makeMissionDir(): { dir: string; cleanup: () => void } {
	const dir = mkdtempSync(join(tmpdir(), "mu-mission-loop-red-"));
	return {
		dir,
		cleanup: () => rmSync(dir, { recursive: true, force: true }),
	};
}

function writeMission(
	dir: string,
	tasks: Array<{ id: string; title: string; status: string; validation?: string[]; notes?: string }>,
): void {
	writeFileSync(join(dir, "SPEC.md"), "# Goal\nShip /mission-run\n");
	writeFileSync(join(dir, "PROGRESS.md"), "# Progress\n\n## Next Smallest Step\n- `baseline`\n");
	writeFileSync(join(dir, "RUNBOOK.md"), "# Runbook\n\n1. Work one task at a time.\n");
	writeFileSync(
		join(dir, "TASKS.json"),
		JSON.stringify(
			{
				tasks: tasks.map((task) => ({ validation: [], notes: "", ...task })),
			},
			null,
			2,
		),
	);
}

describe("mission loop runner (red)", () => {
	const cleanups: Array<() => void> = [];

	afterEach(() => {
		for (const cleanup of cleanups.splice(0)) {
			cleanup();
		}
	});

	it("stops immediately when all mission task statuses are done", async () => {
		const { dir, cleanup } = makeMissionDir();
		cleanups.push(cleanup);
		writeMission(dir, [{ id: "baseline", title: "Done already", status: "done" }]);

		let iterations = 0;
		const result = await runMissionLoop({
			missionDir: dir,
			executeIteration: async () => {
				iterations++;
			},
		});

		expect(result.status).toBe("done");
		expect(result.iterations).toBe(0);
		expect(iterations).toBe(0);
	});

	it("re-reads TASKS.json after each iteration and exits once all tasks become done", async () => {
		const { dir, cleanup } = makeMissionDir();
		cleanups.push(cleanup);
		writeMission(dir, [{ id: "baseline", title: "Run baseline", status: "todo" }]);

		const prompts: string[] = [];
		const result = await runMissionLoop({
			missionDir: dir,
			executeIteration: async ({ prompt }) => {
				prompts.push(prompt);
				writeMission(dir, [{ id: "baseline", title: "Run baseline", status: "done" }]);
			},
		});

		expect(result.status).toBe("done");
		expect(result.iterations).toBe(1);
		expect(prompts).toHaveLength(1);
		expect(prompts[0]).toMatch(/all task statuses.*done/i);
	});

	it("returns blocked instead of spinning forever when unfinished tasks remain but none are runnable", async () => {
		const { dir, cleanup } = makeMissionDir();
		cleanups.push(cleanup);
		writeMission(dir, [
			{ id: "a", title: "Blocked slice", status: "blocked" },
			{ id: "b", title: "Discarded slice", status: "discarded" },
		]);

		let iterations = 0;
		const result = await runMissionLoop({
			missionDir: dir,
			executeIteration: async () => {
				iterations++;
			},
		});

		expect(result.status).toBe("blocked");
		if (result.status !== "blocked") {
			throw new Error(`Expected blocked result, received ${result.status}`);
		}
		expect(result.status).toBe("blocked");
		expect(result.iterations).toBe(0);
		expect(iterations).toBe(0);
		expect(result.reason).toMatch(/no runnable tasks/i);
	});

	it("honors maxIterations exactly instead of running one extra iteration", async () => {
		const { dir, cleanup } = makeMissionDir();
		cleanups.push(cleanup);
		writeMission(dir, [{ id: "baseline", title: "Run baseline", status: "todo" }]);

		let iterations = 0;
		const result = await runMissionLoop({
			missionDir: dir,
			maxIterations: 2,
			executeIteration: async () => {
				iterations += 1;
			},
		});

		expect(iterations).toBe(2);
		expect(result.status).toBe("blocked");
		if (result.status !== "blocked") {
			throw new Error(`Expected blocked result, received ${result.status}`);
		}
		expect(result.iterations).toBe(2);
		expect(result.reason).toMatch(/max iteration limit \(2\)/i);
	});
});

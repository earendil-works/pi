import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { buildMissionIterationPrompt } from "../src/missions/build-mission-prompt.js";
import { parseMissionDefinition } from "../src/missions/parse-mission.js";

function makeMissionDir(): { dir: string; cleanup: () => void } {
	const dir = mkdtempSync(join(tmpdir(), "mu-mission-runner-red-"));
	return {
		dir,
		cleanup: () => rmSync(dir, { recursive: true, force: true }),
	};
}

function writeMissionFiles(
	dir: string,
	options: {
		tasksJson?: string;
		spec?: string;
		progress?: string;
		runbook?: string;
	},
): void {
	writeFileSync(join(dir, "SPEC.md"), options.spec ?? "# Goal\nShip /mission-run\n");
	writeFileSync(join(dir, "PROGRESS.md"), options.progress ?? "# Progress\n\n## Next Smallest Step\n- `baseline`\n");
	writeFileSync(
		join(dir, "RUNBOOK.md"),
		options.runbook ??
			"# Runbook\n\n1. Read SPEC.md, TASKS.json, PROGRESS.md, and RUNBOOK.md.\n2. Work one task at a time.\n",
	);
	writeFileSync(
		join(dir, "TASKS.json"),
		options.tasksJson ??
			JSON.stringify(
				{
					tasks: [
						{
							id: "baseline",
							title: "Run the baseline mission slice",
							status: "todo",
							validation: ["npm test"],
							notes: "",
						},
					],
				},
				null,
				2,
			),
	);
}

describe("mission runner parsing contract (red)", () => {
	const cleanups: Array<() => void> = [];

	afterEach(() => {
		for (const cleanup of cleanups.splice(0)) {
			cleanup();
		}
	});

	it("parses a valid mission directory and keeps TASKS.json machine-readable", () => {
		const { dir, cleanup } = makeMissionDir();
		cleanups.push(cleanup);
		writeMissionFiles(dir, {});

		const mission = parseMissionDefinition(dir);

		expect(mission.dir).toBe(dir);
		expect(mission.tasks).toHaveLength(1);
		expect(mission.tasks[0]?.id).toBe("baseline");
		expect(mission.allTasksDone).toBe(false);
		expect(mission.runnableTasks.map((task) => task.id)).toEqual(["baseline"]);
	});

	it("rejects malformed statuses before the loop starts", () => {
		const { dir, cleanup } = makeMissionDir();
		cleanups.push(cleanup);
		writeMissionFiles(dir, {
			tasksJson: JSON.stringify({
				tasks: [
					{
						id: "baseline",
						title: "Run the baseline mission slice",
						status: "working",
						validation: [],
						notes: "",
					},
				],
			}),
		});

		expect(() => parseMissionDefinition(dir)).toThrow(/status|todo|in_progress|done|blocked|discarded/i);
	});

	it("rejects duplicate task ids before entering the while loop", () => {
		const { dir, cleanup } = makeMissionDir();
		cleanups.push(cleanup);
		writeMissionFiles(dir, {
			tasksJson: JSON.stringify({
				tasks: [
					{ id: "dup", title: "First", status: "todo", validation: [], notes: "" },
					{ id: "dup", title: "Second", status: "todo", validation: [], notes: "" },
				],
			}),
		});

		expect(() => parseMissionDefinition(dir)).toThrow(/duplicate/i);
	});

	it("builds a stable iteration prompt that restates the source-of-truth mission files and stop condition", () => {
		const { dir, cleanup } = makeMissionDir();
		cleanups.push(cleanup);
		writeMissionFiles(dir, {});

		const mission = parseMissionDefinition(dir);
		const prompt = buildMissionIterationPrompt(mission);

		expect(prompt).toContain("SPEC.md");
		expect(prompt).toContain("TASKS.json");
		expect(prompt).toContain("PROGRESS.md");
		expect(prompt).toContain("RUNBOOK.md");
		expect(prompt).toMatch(/one task at a time/i);
		expect(prompt).toMatch(/all task statuses.*done|task.*blocked/i);
		expect(prompt).toMatch(/keep|discard|blocked/i);
	});
});

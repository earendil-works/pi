import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { parseMissionDefinition } from "../src/missions/parse-mission.js";
import type { MissionTask } from "../src/missions/types.js";

interface ChildMissionModule {
	deriveChildMissionDir?: (parentMissionDir: string, taskId: string) => string;
	materializeChildBuildMissionFromTask?: (parentMissionDir: string, task: MissionTask) => string;
}

function writeParentMission(dir: string, task: MissionTask): void {
	writeFileSync(join(dir, "SPEC.md"), "# Goal\nRun delegated build work\n");
	writeFileSync(join(dir, "PROGRESS.md"), "# Progress\n\n## Next recommended task\n- `delegate-login`\n");
	writeFileSync(
		join(dir, "RUNBOOK.md"),
		"1. Work exactly one task at a time.\n2. Delegate child build work when needed.\n",
	);
	writeFileSync(join(dir, "TASKS.json"), JSON.stringify({ tasks: [task] }, null, 2));
}

async function loadChildMissionModule(): Promise<ChildMissionModule> {
	try {
		return (await import("../src/missions/child-mission.js")) as ChildMissionModule;
	} catch (error: unknown) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`Expected child mission module at src/missions/child-mission.ts: ${message}`);
	}
}

describe("child build mission materialization (red)", () => {
	const cleanups: Array<() => void> = [];

	afterEach(() => {
		for (const cleanup of cleanups.splice(0)) {
			cleanup();
		}
	});

	test("derives a deterministic child mission directory from the parent mission dir and task id", async () => {
		const parentDir = mkdtempSync(join(tmpdir(), "mu-child-mission-red-"));
		cleanups.push(() => rmSync(parentDir, { recursive: true, force: true }));

		const parentTask: MissionTask = {
			id: "delegate-login",
			title: "Delegate login flow implementation",
			status: "todo",
			validation: ["npm test -w @kennyfrc/mu-coding-agent -- login-flow.red.test.ts"],
			notes: "Create a child build mission for the login flow work.",
		};
		writeParentMission(parentDir, parentTask);

		const childMissionModule = await loadChildMissionModule();
		expect(typeof childMissionModule.deriveChildMissionDir).toBe("function");

		if (typeof childMissionModule.deriveChildMissionDir !== "function") {
			return;
		}

		expect(childMissionModule.deriveChildMissionDir(parentDir, parentTask.id)).toBe(
			join(parentDir, "children", parentTask.id),
		);
	});

	test("materializes a parseable child build mission under children/<task-id> and keeps the path idempotent", async () => {
		const parentDir = mkdtempSync(join(tmpdir(), "mu-child-mission-red-"));
		cleanups.push(() => rmSync(parentDir, { recursive: true, force: true }));

		const parentTask: MissionTask = {
			id: "delegate-login",
			title: "Delegate login flow implementation",
			status: "todo",
			validation: ["npm test -w @kennyfrc/mu-coding-agent -- login-flow.red.test.ts"],
			notes: "Create a child build mission for the login flow work.",
		};
		writeParentMission(parentDir, parentTask);

		const childMissionModule = await loadChildMissionModule();
		expect(typeof childMissionModule.materializeChildBuildMissionFromTask).toBe("function");

		if (typeof childMissionModule.materializeChildBuildMissionFromTask !== "function") {
			return;
		}

		const expectedChildDir = join(parentDir, "children", parentTask.id);
		const childDir = childMissionModule.materializeChildBuildMissionFromTask(parentDir, parentTask);
		expect(childDir).toBe(expectedChildDir);

		expect(existsSync(join(childDir, "SPEC.md"))).toBe(true);
		expect(existsSync(join(childDir, "TASKS.json"))).toBe(true);
		expect(existsSync(join(childDir, "PROGRESS.md"))).toBe(true);
		expect(existsSync(join(childDir, "RUNBOOK.md"))).toBe(true);

		const childMission = parseMissionDefinition(childDir);
		expect(childMission.mode).toBe("build");
		expect(childMission.runnableTasks.length).toBeGreaterThan(0);
		expect(childMission.specText).toContain(parentTask.title);
		expect(childMission.specText).toContain(parentTask.notes);

		const validatorResult = spawnSync(
			"node",
			[join(homedir(), ".mu/agent/docs/scripts/mission-validator.mjs"), childDir],
			{ encoding: "utf8" },
		);
		expect(validatorResult.status).toBe(0);

		const secondChildDir = childMissionModule.materializeChildBuildMissionFromTask(parentDir, parentTask);
		expect(secondChildDir).toBe(childDir);
		expect(readdirSync(join(parentDir, "children"))).toEqual([parentTask.id]);
	});
});

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { MissionTask } from "./types.js";

const REQUIRED_CHILD_MISSION_FILES = ["SPEC.md", "TASKS.json", "PROGRESS.md", "RUNBOOK.md"] as const;

function assertNonEmpty(value: string, label: string): string {
	const trimmed = value.trim();
	if (!trimmed) {
		throw new Error(`${label} must be a non-empty string`);
	}
	return trimmed;
}

function ensureFile(path: string, content: string): void {
	if (!existsSync(path)) {
		writeFileSync(path, content);
	}
}

function hasExistingChildMissionHarness(childMissionDir: string): boolean {
	return REQUIRED_CHILD_MISSION_FILES.every((fileName) => existsSync(join(childMissionDir, fileName)));
}

function buildChildMissionSpec(task: MissionTask): string {
	return [
		"---",
		"mode: build",
		"---",
		"",
		"# Summary & Recommendation",
		`${task.title}`,
		"",
		"# Parent backlog item",
		`- id: ${task.id}`,
		`- title: ${task.title}`,
		`- notes: ${task.notes || "(none provided)"}`,
		"",
		"# Validation",
		...(task.validation.length > 0
			? task.validation.map((command) => `- ${command}`)
			: ["- No explicit validation commands provided."]),
	].join("\n");
}

function buildChildMissionTasks(task: MissionTask): string {
	return JSON.stringify(
		{
			tasks: [
				{
					id: task.id,
					title: task.title,
					status: "todo",
					validation: task.validation,
					notes: task.notes,
				},
			],
		},
		null,
		2,
	);
}

function buildChildMissionProgress(task: MissionTask): string {
	return [
		"# Progress",
		"",
		"## Current baseline",
		"- not run yet",
		"",
		"## Current best known state",
		"- commit: none recorded yet",
		"- reason kept: n/a",
		"",
		"## Last completed task",
		"- none",
		"",
		"## Next recommended task",
		`- \`${task.id}\``,
		"",
		"## Known issues",
		"- none",
	].join("\n");
}

function buildChildMissionRunbook(task: MissionTask): string {
	return [
		"1. Treat `SPEC.md`, `TASKS.json`, `PROGRESS.md`, and `RUNBOOK.md` as the source of truth.",
		"2. Work exactly one task at a time.",
		`3. Complete the delegated backlog item \`${task.id}\` with the smallest verifiable change.`,
		"4. Keep the change only if validation passes; otherwise discard it or mark the task blocked with the exact reason.",
		"5. Update `TASKS.json` and `PROGRESS.md` before stopping.",
	].join("\n");
}

export function deriveChildMissionDir(parentMissionDir: string, taskId: string): string {
	const resolvedParentMissionDir = resolve(assertNonEmpty(parentMissionDir, "parentMissionDir"));
	const resolvedTaskId = assertNonEmpty(taskId, "taskId");
	return join(resolvedParentMissionDir, "children", resolvedTaskId);
}

export function materializeChildBuildMissionFromTask(parentMissionDir: string, task: MissionTask): string {
	const childMissionDir = deriveChildMissionDir(parentMissionDir, task.id);
	if (hasExistingChildMissionHarness(childMissionDir)) {
		return childMissionDir;
	}

	mkdirSync(childMissionDir, { recursive: true });
	ensureFile(join(childMissionDir, "SPEC.md"), buildChildMissionSpec(task));
	ensureFile(join(childMissionDir, "TASKS.json"), buildChildMissionTasks(task));
	ensureFile(join(childMissionDir, "PROGRESS.md"), buildChildMissionProgress(task));
	ensureFile(join(childMissionDir, "RUNBOOK.md"), buildChildMissionRunbook(task));
	return childMissionDir;
}

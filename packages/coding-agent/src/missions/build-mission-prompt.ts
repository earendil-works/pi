import type { MissionDefinition } from "./types.js";

export function buildMissionIterationPrompt(mission: MissionDefinition): string {
	const taskSummary = mission.tasks.map((task) => `- [${task.status}] ${task.id}: ${task.title}`).join("\n");

	return [
		`Mission directory: ${mission.dir}`,
		"",
		"Treat SPEC.md, TASKS.json, PROGRESS.md, and RUNBOOK.md as the source of truth.",
		"Work exactly one task at a time.",
		"Keep the change only if validation passes; otherwise discard it or mark the task blocked with the exact reason.",
		"Stop only when all task statuses in TASKS.json are done.",
		"",
		"Current tasks:",
		taskSummary,
		"",
		"SPEC.md",
		mission.specText.trim(),
		"",
		"TASKS.json",
		JSON.stringify({ tasks: mission.tasks }, null, 2),
		"",
		"PROGRESS.md",
		mission.progressText.trim(),
		"",
		"RUNBOOK.md",
		mission.runbookText.trim(),
	].join("\n");
}

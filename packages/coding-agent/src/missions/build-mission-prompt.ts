import type { MissionDefinition } from "./types.js";

export function buildMissionIterationPrompt(mission: MissionDefinition): string {
	if (mission.mode === "optimize") {
		const seedTaskSummary =
			mission.tasks.length > 0
				? mission.tasks.map((task) => `- [${task.status}] ${task.id}: ${task.title}`).join("\n")
				: "- No seed tasks provided.";

		return [
			`Mission directory: ${mission.dir}`,
			"",
			"Treat SPEC.md, EXPERIMENTS.jsonl, PROGRESS.md, and RUNBOOK.md as the source of truth.",
			"If no baseline benchmark has been recorded yet, run the baseline benchmark first.",
			"This is optimize mode: brainstorm the single most promising small change, then benchmark and validate it.",
			"Each iteration must end with keep, discard, crash, or blocked.",
			`Stop if there are ${mission.convergeAfter ?? 3} consecutive ${mission.convergenceKind ?? "non-keep"} results without a keep.`,
			"Do not stop because seed tasks are done; TASKS.json is only optional starting ideas in optimize mode.",
			"",
			"Seed ideas:",
			seedTaskSummary,
			"",
			"SPEC.md",
			mission.specText.trim(),
			"",
			"EXPERIMENTS.jsonl",
			(mission.experimentsText ?? "").trim(),
			"",
			"PROGRESS.md",
			mission.progressText.trim(),
			"",
			"RUNBOOK.md",
			mission.runbookText.trim(),
		].join("\n");
	}

	const taskSummary = mission.tasks.map((task) => `- [${task.status}] ${task.id}: ${task.title}`).join("\n");
	const milestonesSummary =
		mission.milestones.length > 0
			? mission.milestones
					.map(
						(milestone) =>
							`- ${milestone.id}: ${milestone.title}\n  goal: ${milestone.goal}\n  gate task: ${milestone.gateTaskId}\n  verification:\n${milestone.verification.map((step) => `    - ${step.id} [${step.kind}]\n      command: ${step.command}\n      expect: ${step.expect}`).join("\n")}`,
					)
					.join("\n")
			: undefined;

	return [
		`Mission directory: ${mission.dir}`,
		"",
		mission.milestones.length > 0
			? "Treat SPEC.md, TASKS.json, MILESTONES.json, PROGRESS.md, and RUNBOOK.md as the source of truth."
			: "Treat SPEC.md, TASKS.json, PROGRESS.md, and RUNBOOK.md as the source of truth.",
		"Work exactly one task at a time.",
		"Keep the change only if validation passes; otherwise discard it or mark the task blocked with the exact reason.",
		"Stop when all task statuses in TASKS.json are done, or when a task is marked blocked.",
		mission.milestones.length > 0
			? "Acceptance gate tasks are real tasks. Do not mark a gate task done until its milestone verification is green."
			: undefined,
		"",
		"Current tasks:",
		taskSummary,
		mission.milestones.length > 0 ? "" : undefined,
		mission.milestones.length > 0 ? "MILESTONES.json" : undefined,
		mission.milestones.length > 0 ? JSON.stringify({ milestones: mission.milestones }, null, 2) : undefined,
		mission.milestones.length > 0 ? "" : undefined,
		mission.milestones.length > 0 ? "Milestone summary:" : undefined,
		milestonesSummary,
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
	]
		.filter((line): line is string => line !== undefined)
		.join("\n");
}

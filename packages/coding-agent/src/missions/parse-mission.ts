import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseMissionHistory } from "./mission-history.js";
import type {
	MissionConvergenceKind,
	MissionDefinition,
	MissionMetricDirection,
	MissionMilestone,
	MissionMilestoneVerification,
	MissionMilestoneVerificationKind,
	MissionMode,
	MissionTask,
	MissionTaskStatus,
} from "./types.js";

const TASK_STATUSES: MissionTaskStatus[] = ["todo", "in_progress", "done", "blocked", "discarded"];
const MILESTONE_VERIFICATION_KINDS: MissionMilestoneVerificationKind[] = [
	"command",
	"xtui",
	"cdp",
	"log",
	"assertion",
	"diff",
];
function asRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function parseSpecFrontmatter(specText: string): {
	mode: MissionMode;
	metric?: string;
	direction?: MissionMetricDirection;
	convergeAfter?: number;
	convergenceKind?: MissionConvergenceKind;
} {
	if (!specText.startsWith("---\n")) {
		return { mode: "build" };
	}

	const endMarker = specText.indexOf("\n---", 4);
	if (endMarker === -1) {
		return { mode: "build" };
	}

	const headerText = specText.slice(4, endMarker);
	const fields = new Map<string, string>();
	for (const line of headerText.split("\n")) {
		const separator = line.indexOf(":");
		if (separator === -1) continue;
		const key = line.slice(0, separator).trim();
		const value = line.slice(separator + 1).trim();
		if (key) fields.set(key, value);
	}

	const modeValue = fields.get("mode");
	if (modeValue !== undefined && modeValue !== "build" && modeValue !== "optimize") {
		throw new Error(`Mission SPEC.md has invalid mode "${modeValue}". Expected build or optimize`);
	}

	const directionValue = fields.get("direction");
	if (directionValue !== undefined && directionValue !== "lower" && directionValue !== "higher") {
		throw new Error(`Mission SPEC.md has invalid direction "${directionValue}". Expected lower or higher`);
	}

	const convergenceKindValue = fields.get("convergence_kind");
	if (
		convergenceKindValue !== undefined &&
		convergenceKindValue !== "discard" &&
		convergenceKindValue !== "non-keep"
	) {
		throw new Error(
			`Mission SPEC.md has invalid convergence_kind "${convergenceKindValue}". Expected discard or non-keep`,
		);
	}

	const convergeAfterValue = fields.get("converge_after");
	let convergeAfter: number | undefined;
	if (convergeAfterValue !== undefined) {
		const parsed = Number.parseInt(convergeAfterValue, 10);
		if (!Number.isFinite(parsed) || parsed <= 0 || String(parsed) !== convergeAfterValue) {
			throw new Error(
				`Mission SPEC.md has invalid converge_after "${convergeAfterValue}". Expected a positive integer`,
			);
		}
		convergeAfter = parsed;
	}

	return {
		mode: modeValue === "optimize" ? "optimize" : "build",
		metric: fields.get("metric"),
		direction: directionValue as MissionMetricDirection | undefined,
		convergeAfter,
		convergenceKind: convergenceKindValue as MissionConvergenceKind | undefined,
	};
}

function readRequiredFile(path: string, label: string): string {
	if (!existsSync(path)) {
		throw new Error(`Mission is missing required file: ${label} (${path})`);
	}
	return readFileSync(path, "utf8");
}

function parseMissionTask(value: unknown, index: number): MissionTask {
	if (!asRecord(value)) {
		throw new Error(`Mission task at index ${index} must be an object`);
	}

	const id = value.id;
	const title = value.title;
	const status = value.status;
	const validation = value.validation;
	const notes = value.notes;

	if (typeof id !== "string" || id.trim().length === 0) {
		throw new Error(`Mission task at index ${index} must have a non-empty string id`);
	}
	if (typeof title !== "string" || title.trim().length === 0) {
		throw new Error(`Mission task "${id}" must have a non-empty string title`);
	}
	if (typeof status !== "string" || !TASK_STATUSES.includes(status as MissionTaskStatus)) {
		throw new Error(
			`Mission task "${id}" has invalid status "${String(status)}". Expected one of: ${TASK_STATUSES.join(", ")}`,
		);
	}
	if (!Array.isArray(validation) || validation.some((item) => typeof item !== "string")) {
		throw new Error(`Mission task "${id}" must have a string[] validation field`);
	}
	if (typeof notes !== "string") {
		throw new Error(`Mission task "${id}" must have a string notes field`);
	}

	return {
		id,
		title,
		status: status as MissionTaskStatus,
		validation,
		notes,
	};
}

function parseMissionMilestoneVerification(
	milestoneId: string,
	value: unknown,
	index: number,
): MissionMilestoneVerification {
	if (!asRecord(value)) {
		throw new Error(`Mission milestone "${milestoneId}" verification entry at index ${index} must be an object`);
	}

	const id = value.id;
	const kind = value.kind;
	const command = value.command;
	const expectValue = value.expect;

	if (typeof id !== "string" || id.trim().length === 0) {
		throw new Error(
			`Mission milestone "${milestoneId}" verification entry at index ${index} must have a non-empty string id`,
		);
	}
	if (typeof kind !== "string" || !MILESTONE_VERIFICATION_KINDS.includes(kind as MissionMilestoneVerificationKind)) {
		throw new Error(
			`Mission milestone "${milestoneId}" verification entry "${String(id)}" has invalid kind "${String(kind)}". Expected one of: ${MILESTONE_VERIFICATION_KINDS.join(", ")}`,
		);
	}
	if (typeof command !== "string" || command.trim().length === 0) {
		throw new Error(
			`Mission milestone "${milestoneId}" verification entry "${id}" must have a non-empty string command`,
		);
	}
	if (typeof expectValue !== "string" || expectValue.trim().length === 0) {
		throw new Error(
			`Mission milestone "${milestoneId}" verification entry "${id}" must have a non-empty string expect`,
		);
	}

	return {
		id,
		kind: kind as MissionMilestoneVerificationKind,
		command,
		expect: expectValue,
	};
}

function parseMissionMilestone(value: unknown, index: number): MissionMilestone {
	if (!asRecord(value)) {
		throw new Error(`Mission milestone at index ${index} must be an object`);
	}

	const id = value.id;
	const title = value.title;
	const goal = value.goal;
	const taskIds = value.taskIds;
	const gateTaskId = value.gateTaskId;
	const verification = value.verification;
	const notes = value.notes;

	if (typeof id !== "string" || id.trim().length === 0) {
		throw new Error(`Mission milestone at index ${index} must have a non-empty string id`);
	}
	if (typeof title !== "string" || title.trim().length === 0) {
		throw new Error(`Mission milestone "${id}" must have a non-empty string title`);
	}
	if (typeof goal !== "string" || goal.trim().length === 0) {
		throw new Error(`Mission milestone "${id}" must have a non-empty string goal`);
	}
	if (
		!Array.isArray(taskIds) ||
		taskIds.length === 0 ||
		taskIds.some((item) => typeof item !== "string" || item.length === 0)
	) {
		throw new Error(`Mission milestone "${id}" must have a non-empty string[] taskIds field`);
	}
	if (typeof gateTaskId !== "string" || gateTaskId.trim().length === 0) {
		throw new Error(`Mission milestone "${id}" must have a non-empty string gateTaskId`);
	}
	if (!Array.isArray(verification) || verification.length === 0 || verification.some((item) => !asRecord(item))) {
		throw new Error(`Mission milestone "${id}" must have a non-empty verification object[] field`);
	}
	if (typeof notes !== "string") {
		throw new Error(`Mission milestone "${id}" must have a string notes field`);
	}

	const parsedVerification = verification.map((entry, verificationIndex) =>
		parseMissionMilestoneVerification(id, entry, verificationIndex),
	);
	const seenVerificationIds = new Set<string>();
	for (const entry of parsedVerification) {
		if (seenVerificationIds.has(entry.id)) {
			throw new Error(`Mission milestone "${id}" contains duplicate verification id: ${entry.id}`);
		}
		seenVerificationIds.add(entry.id);
	}

	return {
		id,
		title,
		goal,
		taskIds,
		gateTaskId,
		verification: parsedVerification,
		notes,
	};
}

export function parseMissionDefinition(missionDir: string): MissionDefinition {
	const dir = resolve(missionDir);
	const specPath = join(dir, "SPEC.md");
	const tasksPath = join(dir, "TASKS.json");
	const milestonesPath = join(dir, "MILESTONES.json");
	const experimentsPath = join(dir, "EXPERIMENTS.jsonl");
	const progressPath = join(dir, "PROGRESS.md");
	const runbookPath = join(dir, "RUNBOOK.md");

	const specText = readRequiredFile(specPath, "SPEC.md");
	const specFrontmatter = parseSpecFrontmatter(specText);
	const progressText = readRequiredFile(progressPath, "PROGRESS.md");
	const runbookText = readRequiredFile(runbookPath, "RUNBOOK.md");
	const experimentsText =
		specFrontmatter.mode === "optimize" ? readRequiredFile(experimentsPath, "EXPERIMENTS.jsonl") : undefined;
	const parsedHistory = parseMissionHistory(experimentsText);

	let tasks: MissionTask[] = [];
	if (specFrontmatter.mode === "build" || existsSync(tasksPath)) {
		const tasksText = readRequiredFile(tasksPath, "TASKS.json");

		let parsed: unknown;
		try {
			parsed = JSON.parse(tasksText);
		} catch (error: unknown) {
			const message = error instanceof Error ? error.message : String(error);
			throw new Error(`Mission TASKS.json is not valid JSON: ${message}`);
		}

		if (!asRecord(parsed) || !Array.isArray(parsed.tasks)) {
			throw new Error("Mission TASKS.json must contain a top-level tasks array");
		}
		if (parsed.tasks.length === 0) {
			throw new Error("Mission TASKS.json must contain at least one task");
		}

		tasks = parsed.tasks.map((task, index) => parseMissionTask(task, index));
		const seenIds = new Set<string>();
		for (const task of tasks) {
			if (seenIds.has(task.id)) {
				throw new Error(`Mission TASKS.json contains duplicate task id: ${task.id}`);
			}
			seenIds.add(task.id);
		}
	}

	let milestones: MissionMilestone[] = [];
	if (existsSync(milestonesPath)) {
		const milestonesText = readRequiredFile(milestonesPath, "MILESTONES.json");

		let parsed: unknown;
		try {
			parsed = JSON.parse(milestonesText);
		} catch (error: unknown) {
			const message = error instanceof Error ? error.message : String(error);
			throw new Error(`Mission MILESTONES.json is not valid JSON: ${message}`);
		}

		if (!asRecord(parsed) || !Array.isArray(parsed.milestones)) {
			throw new Error("Mission MILESTONES.json must contain a top-level milestones array");
		}

		milestones = parsed.milestones.map((milestone, index) => parseMissionMilestone(milestone, index));
		const seenIds = new Set<string>();
		const seenGateTaskIds = new Set<string>();
		const taskIds = new Set(tasks.map((task) => task.id));

		for (const milestone of milestones) {
			if (seenIds.has(milestone.id)) {
				throw new Error(`Mission MILESTONES.json contains duplicate milestone id: ${milestone.id}`);
			}
			seenIds.add(milestone.id);

			for (const taskId of milestone.taskIds) {
				if (!taskIds.has(taskId)) {
					throw new Error(
						`Mission milestone "${milestone.id}" references taskIds entry missing from TASKS.json: ${taskId}`,
					);
				}
			}

			if (!milestone.taskIds.includes(milestone.gateTaskId)) {
				throw new Error(
					`Mission milestone "${milestone.id}" gateTaskId must also appear in taskIds: ${milestone.gateTaskId}`,
				);
			}

			if (seenGateTaskIds.has(milestone.gateTaskId)) {
				throw new Error(`Mission MILESTONES.json reuses gateTaskId across milestones: ${milestone.gateTaskId}`);
			}
			seenGateTaskIds.add(milestone.gateTaskId);
		}
	}

	const allTasksDone = specFrontmatter.mode === "build" && tasks.every((task) => task.status === "done");
	const runnableTasks = tasks.filter((task) => task.status === "todo" || task.status === "in_progress");

	return {
		mode: specFrontmatter.mode,
		dir,
		specPath,
		tasksPath: existsSync(tasksPath) ? tasksPath : undefined,
		milestonesPath: existsSync(milestonesPath) ? milestonesPath : undefined,
		experimentsPath: experimentsText !== undefined ? experimentsPath : undefined,
		progressPath,
		runbookPath,
		specText,
		progressText,
		runbookText,
		experimentsText,
		latestExperimentResult: parsedHistory.latestExperimentResult,
		optimizeStatusesSinceReset: parsedHistory.optimizeStatusesSinceReset,
		metric: specFrontmatter.metric,
		direction: specFrontmatter.direction,
		convergeAfter: specFrontmatter.convergeAfter,
		convergenceKind: specFrontmatter.convergenceKind,
		tasks,
		milestones,
		allTasksDone,
		runnableTasks,
	};
}

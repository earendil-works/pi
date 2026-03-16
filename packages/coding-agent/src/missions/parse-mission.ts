import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type {
	MissionDefinition,
	MissionExperimentStatus,
	MissionLatestExperimentResult,
	MissionMetricDirection,
	MissionMode,
	MissionTask,
	MissionTaskStatus,
} from "./types.js";

const TASK_STATUSES: MissionTaskStatus[] = ["todo", "in_progress", "done", "blocked", "discarded"];
const EXPERIMENT_STATUSES: MissionExperimentStatus[] = ["keep", "discard", "crash", "blocked"];

function asRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function parseSpecFrontmatter(specText: string): {
	mode: MissionMode;
	metric?: string;
	direction?: MissionMetricDirection;
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

	return {
		mode: modeValue === "optimize" ? "optimize" : "build",
		metric: fields.get("metric"),
		direction: directionValue as MissionMetricDirection | undefined,
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

function parseLatestExperimentResult(experimentsText: string): MissionLatestExperimentResult | undefined {
	const lines = experimentsText
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.length > 0);

	for (let index = lines.length - 1; index >= 0; index -= 1) {
		const line = lines[index];
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch {
			continue;
		}
		if (!asRecord(parsed)) {
			continue;
		}
		const status = parsed.status;
		if (typeof status !== "string" || !EXPERIMENT_STATUSES.includes(status as MissionExperimentStatus)) {
			continue;
		}
		const reason = typeof parsed.reason === "string" && parsed.reason.trim().length > 0 ? parsed.reason : undefined;
		return {
			status: status as MissionExperimentStatus,
			reason,
			raw: parsed,
		};
	}

	return undefined;
}

export function parseMissionDefinition(missionDir: string): MissionDefinition {
	const dir = resolve(missionDir);
	const specPath = join(dir, "SPEC.md");
	const tasksPath = join(dir, "TASKS.json");
	const experimentsPath = join(dir, "EXPERIMENTS.jsonl");
	const progressPath = join(dir, "PROGRESS.md");
	const runbookPath = join(dir, "RUNBOOK.md");

	const specText = readRequiredFile(specPath, "SPEC.md");
	const specFrontmatter = parseSpecFrontmatter(specText);
	const progressText = readRequiredFile(progressPath, "PROGRESS.md");
	const runbookText = readRequiredFile(runbookPath, "RUNBOOK.md");
	const experimentsText =
		specFrontmatter.mode === "optimize" ? readRequiredFile(experimentsPath, "EXPERIMENTS.jsonl") : undefined;
	const latestExperimentResult = experimentsText ? parseLatestExperimentResult(experimentsText) : undefined;

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

	const allTasksDone = specFrontmatter.mode === "build" && tasks.every((task) => task.status === "done");
	const runnableTasks = tasks.filter((task) => task.status === "todo" || task.status === "in_progress");

	return {
		mode: specFrontmatter.mode,
		dir,
		specPath,
		tasksPath: existsSync(tasksPath) ? tasksPath : undefined,
		experimentsPath: experimentsText !== undefined ? experimentsPath : undefined,
		progressPath,
		runbookPath,
		specText,
		progressText,
		runbookText,
		experimentsText,
		latestExperimentResult,
		metric: specFrontmatter.metric,
		direction: specFrontmatter.direction,
		tasks,
		allTasksDone,
		runnableTasks,
	};
}

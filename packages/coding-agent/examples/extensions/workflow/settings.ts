import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { DEFAULT_MAX_CONCURRENCY } from "../workflow-core/src/index.ts";

export interface WorkflowSettings {
	maxConcurrency: number;
	autoMode: boolean;
}

const DEFAULTS: WorkflowSettings = {
	maxConcurrency: DEFAULT_MAX_CONCURRENCY,
	autoMode: false,
};

function readWorkflowSection(settings: Record<string, unknown>): Partial<WorkflowSettings> {
	const workflow = settings.workflow;
	if (!workflow || typeof workflow !== "object" || Array.isArray(workflow)) {
		return {};
	}

	const section = workflow as Record<string, unknown>;
	const parsed: Partial<WorkflowSettings> = {};

	if (typeof section.maxConcurrency === "number" && section.maxConcurrency > 0) {
		parsed.maxConcurrency = section.maxConcurrency;
	}
	if (typeof section.autoMode === "boolean") {
		parsed.autoMode = section.autoMode;
	}

	return parsed;
}

function loadSettingsFile(filePath: string): Partial<WorkflowSettings> {
	if (!existsSync(filePath)) return {};
	try {
		const content = readFileSync(filePath, "utf-8");
		const settings = JSON.parse(content) as Record<string, unknown>;
		return readWorkflowSection(settings);
	} catch {
		return {};
	}
}

/** Load workflow.* settings from ~/.pi/agent/settings.json and <cwd>/.pi/settings.json */
export function loadWorkflowSettings(cwd: string): WorkflowSettings {
	const globalPath = join(getAgentDir(), "settings.json");
	const projectPath = join(cwd, ".pi", "settings.json");
	const merged = {
		...loadSettingsFile(globalPath),
		...loadSettingsFile(projectPath),
	};
	return { ...DEFAULTS, ...merged };
}

export type MissionTaskStatus = "todo" | "in_progress" | "done" | "blocked" | "discarded";
export type MissionMode = "build" | "optimize";
export type MissionMetricDirection = "lower" | "higher";
export type MissionExperimentStatus = "keep" | "discard" | "crash" | "blocked";

export interface MissionLatestExperimentResult {
	status: MissionExperimentStatus;
	reason?: string;
	raw: Record<string, unknown>;
}

export interface MissionTask {
	id: string;
	title: string;
	status: MissionTaskStatus;
	validation: string[];
	notes: string;
}

export interface MissionDefinition {
	mode: MissionMode;
	dir: string;
	specPath: string;
	tasksPath?: string;
	experimentsPath?: string;
	progressPath: string;
	runbookPath: string;
	specText: string;
	progressText: string;
	runbookText: string;
	experimentsText?: string;
	latestExperimentResult?: MissionLatestExperimentResult;
	metric?: string;
	direction?: MissionMetricDirection;
	tasks: MissionTask[];
	allTasksDone: boolean;
	runnableTasks: MissionTask[];
}

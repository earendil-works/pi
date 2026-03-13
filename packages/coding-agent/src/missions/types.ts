export type MissionTaskStatus = "todo" | "in_progress" | "done" | "blocked" | "discarded";
export type MissionMode = "build" | "optimize";
export type MissionMetricDirection = "lower" | "higher";

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
	metric?: string;
	direction?: MissionMetricDirection;
	tasks: MissionTask[];
	allTasksDone: boolean;
	runnableTasks: MissionTask[];
}

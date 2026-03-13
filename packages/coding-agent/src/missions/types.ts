export type MissionTaskStatus = "todo" | "in_progress" | "done" | "blocked" | "discarded";

export interface MissionTask {
	id: string;
	title: string;
	status: MissionTaskStatus;
	validation: string[];
	notes: string;
}

export interface MissionDefinition {
	dir: string;
	specPath: string;
	tasksPath: string;
	progressPath: string;
	runbookPath: string;
	specText: string;
	progressText: string;
	runbookText: string;
	tasks: MissionTask[];
	allTasksDone: boolean;
	runnableTasks: MissionTask[];
}

export type MissionTaskStatus = "todo" | "in_progress" | "done" | "blocked" | "discarded";
export type MissionMode = "build" | "optimize";
export type MissionMetricDirection = "lower" | "higher";
export type MissionExperimentStatus = "keep" | "discard" | "crash" | "blocked";
export type MissionConvergenceKind = "discard" | "non-keep";

export interface MissionConvergencePolicy {
	after: number | null;
	kind: MissionConvergenceKind;
}

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

export type MissionMilestoneVerificationKind = "command" | "xtui" | "cdp" | "log" | "assertion" | "diff";

export interface MissionMilestoneVerification {
	id: string;
	kind: MissionMilestoneVerificationKind;
	command: string;
	expect: string;
}

export interface MissionMilestone {
	id: string;
	title: string;
	goal: string;
	taskIds: string[];
	gateTaskId: string;
	verification: MissionMilestoneVerification[];
	notes: string;
}

export interface MissionDefinition {
	mode: MissionMode;
	dir: string;
	specPath: string;
	tasksPath?: string;
	milestonesPath?: string;
	experimentsPath?: string;
	progressPath: string;
	runbookPath: string;
	specText: string;
	progressText: string;
	runbookText: string;
	experimentsText?: string;
	latestExperimentResult?: MissionLatestExperimentResult;
	optimizeStatusesSinceReset?: MissionExperimentStatus[];
	metric?: string;
	direction?: MissionMetricDirection;
	convergeAfter?: number;
	convergenceKind?: MissionConvergenceKind;
	tasks: MissionTask[];
	milestones: MissionMilestone[];
	allTasksDone: boolean;
	runnableTasks: MissionTask[];
}

import { theme } from "../theme/theme.js";
import type { MissionDefinition, MissionTask } from "./types.js";

export type MissionUiStatus = "running" | "blocked" | "done" | "stopped";

export interface MissionUiState {
	missionName: string;
	iteration: number;
	status: MissionUiStatus;
	doneCount: number;
	totalCount: number;
	currentTaskId?: string;
	currentTaskTitle?: string;
}

function getCurrentTask(mission: MissionDefinition): MissionTask | undefined {
	return (
		mission.tasks.find((task) => task.status === "in_progress") ??
		mission.tasks.find((task) => task.status === "todo")
	);
}

export function buildMissionUiState(options: {
	missionName: string;
	mission: MissionDefinition;
	iteration: number;
	status: MissionUiStatus;
}): MissionUiState {
	const currentTask = getCurrentTask(options.mission);
	const doneCount = options.mission.tasks.filter((task) => task.status === "done").length;

	return {
		missionName: options.missionName,
		iteration: options.iteration,
		status: options.status,
		doneCount,
		totalCount: options.mission.tasks.length,
		currentTaskId: currentTask?.id,
		currentTaskTitle: currentTask?.title,
	};
}

export function formatMissionMetaLabel(state: MissionUiState | null): string {
	if (!state) {
		return "";
	}

	const parts = [
		theme.fg("accent", `mission ${state.missionName}`),
		theme.fg("muted", `iter ${state.iteration}`),
		theme.fg(
			state.status === "done"
				? "accent"
				: state.status === "blocked" || state.status === "stopped"
					? "warning"
					: "muted",
			state.status,
		),
		theme.fg("muted", `${state.doneCount}/${state.totalCount} done`),
	];

	if (state.currentTaskId && state.currentTaskTitle) {
		parts.push(theme.fg("muted", `task ${state.currentTaskId}: ${state.currentTaskTitle}`));
	}

	return parts.join(theme.fg("muted", " • "));
}

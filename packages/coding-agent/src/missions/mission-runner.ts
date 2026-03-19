import { buildMissionIterationPrompt } from "./build-mission-prompt.js";
import { parseMissionDefinition } from "./parse-mission.js";
import type { MissionConvergencePolicy, MissionDefinition, MissionExperimentStatus } from "./types.js";

export interface MissionIterationExecution {
	mission: MissionDefinition;
	prompt: string;
}

export interface RunMissionLoopOptions {
	missionDir: string;
	maxIterations?: number;
	executeIteration: (execution: MissionIterationExecution) => Promise<void>;
	signal?: AbortSignal;
	shouldContinue?: () => boolean;
	onIterationComplete?: () => void;
	convergencePolicy?: MissionConvergencePolicy;
}

export type MissionLoopResult =
	| { status: "done"; iterations: number }
	| { status: "stopped"; iterations: number }
	| { status: "converged"; iterations: number; reason: string }
	| { status: "blocked"; iterations: number; reason: string };

function getBlockedBuildTaskReason(mission: MissionDefinition): string | undefined {
	if (mission.mode === "optimize") {
		return undefined;
	}

	const blockedTask = mission.tasks.find((task) => task.status === "blocked");
	if (!blockedTask) {
		return undefined;
	}

	return `Mission has blocked task ${blockedTask.id}: ${blockedTask.title}`;
}

function getConvergencePolicy(
	mission: MissionDefinition,
	override: MissionConvergencePolicy | undefined,
): MissionConvergencePolicy {
	if (override) {
		return override;
	}

	return {
		after: mission.convergeAfter ?? 3,
		kind: mission.convergenceKind ?? "non-keep",
	};
}

function hasConverged(statuses: MissionExperimentStatus[], policy: MissionConvergencePolicy): boolean {
	if (policy.after === null) {
		return false;
	}

	let streak = 0;
	for (let index = statuses.length - 1; index >= 0; index -= 1) {
		const status = statuses[index];
		if (status === "blocked") {
			break;
		}
		if (status === "keep") {
			break;
		}
		if (policy.kind === "discard") {
			if (status !== "discard") {
				break;
			}
			streak += 1;
			continue;
		}

		if (status === "discard" || status === "crash") {
			streak += 1;
			continue;
		}

		break;
	}

	return streak >= policy.after;
}

function getTerminalMissionResult(
	mission: MissionDefinition,
	iterations: number,
	convergencePolicyOverride?: MissionConvergencePolicy,
): Exclude<MissionLoopResult, { status: "stopped" }> | null {
	if (mission.mode !== "optimize" && mission.allTasksDone) {
		return { status: "done", iterations };
	}

	const blockedBuildTaskReason = getBlockedBuildTaskReason(mission);
	if (blockedBuildTaskReason) {
		return {
			status: "blocked",
			iterations,
			reason: blockedBuildTaskReason,
		};
	}

	if (mission.mode === "optimize" && mission.latestExperimentResult?.status === "blocked") {
		return {
			status: "blocked",
			iterations,
			reason: mission.latestExperimentResult.reason ?? "Mission recorded a blocked optimize iteration",
		};
	}

	if (mission.mode === "optimize") {
		const convergencePolicy = getConvergencePolicy(mission, convergencePolicyOverride);
		if (hasConverged(mission.optimizeStatusesSinceReset ?? [], convergencePolicy)) {
			return {
				status: "converged",
				iterations,
				reason: `Mission reached ${convergencePolicy.after} consecutive ${convergencePolicy.kind} results`,
			};
		}
	}

	return null;
}

export async function runMissionLoop(options: RunMissionLoopOptions): Promise<MissionLoopResult> {
	const maxIterations = options.maxIterations ?? 100;
	let iterations = 0;

	while (true) {
		if (options.signal?.aborted) {
			const terminalResult = getTerminalMissionResult(
				parseMissionDefinition(options.missionDir),
				iterations,
				options.convergencePolicy,
			);
			if (terminalResult) {
				return terminalResult;
			}
			return { status: "stopped", iterations };
		}

		const mission = parseMissionDefinition(options.missionDir);
		const terminalResult = getTerminalMissionResult(mission, iterations, options.convergencePolicy);
		if (terminalResult) {
			return terminalResult;
		}
		if (options.shouldContinue && !options.shouldContinue()) {
			return { status: "stopped", iterations };
		}
		if (iterations >= maxIterations) {
			return {
				status: "blocked",
				iterations,
				reason: `Mission exceeded max iteration limit (${maxIterations})`,
			};
		}

		if (mission.mode === "optimize") {
			const prompt = buildMissionIterationPrompt(mission);
			await options.executeIteration({ mission, prompt });
			iterations += 1;
			options.onIterationComplete?.();
			if (options.signal?.aborted) {
				const terminalAfterIteration = getTerminalMissionResult(
					parseMissionDefinition(options.missionDir),
					iterations,
					options.convergencePolicy,
				);
				if (terminalAfterIteration) {
					return terminalAfterIteration;
				}
				return { status: "stopped", iterations };
			}
			continue;
		}

		if (mission.runnableTasks.length === 0) {
			return {
				status: "blocked",
				iterations,
				reason: "Mission has unfinished tasks but no runnable tasks remaining",
			};
		}

		const prompt = buildMissionIterationPrompt(mission);
		await options.executeIteration({ mission, prompt });
		iterations += 1;
		options.onIterationComplete?.();
		if (options.signal?.aborted) {
			const terminalAfterIteration = getTerminalMissionResult(
				parseMissionDefinition(options.missionDir),
				iterations,
				options.convergencePolicy,
			);
			if (terminalAfterIteration) {
				return terminalAfterIteration;
			}
			return { status: "stopped", iterations };
		}
	}
}

import { buildMissionIterationPrompt } from "./build-mission-prompt.js";
import { parseMissionDefinition } from "./parse-mission.js";
import type { MissionDefinition } from "./types.js";

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
}

export type MissionLoopResult =
	| { status: "done"; iterations: number }
	| { status: "stopped"; iterations: number }
	| { status: "blocked"; iterations: number; reason: string };

export async function runMissionLoop(options: RunMissionLoopOptions): Promise<MissionLoopResult> {
	const maxIterations = options.maxIterations ?? 100;
	let iterations = 0;

	while (true) {
		if (options.signal?.aborted) {
			return { status: "stopped", iterations };
		}

		const mission = parseMissionDefinition(options.missionDir);
		if (mission.mode !== "optimize" && mission.allTasksDone) {
			return { status: "done", iterations };
		}
		if (mission.mode === "optimize" && mission.latestExperimentResult?.status === "blocked") {
			return {
				status: "blocked",
				iterations,
				reason: mission.latestExperimentResult.reason ?? "Mission recorded a blocked optimize iteration",
			};
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
			return { status: "stopped", iterations };
		}
	}
}

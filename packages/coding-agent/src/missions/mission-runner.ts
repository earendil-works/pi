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
}

export type MissionLoopResult =
	| { status: "done"; iterations: number }
	| { status: "stopped"; iterations: number }
	| { status: "blocked"; iterations: number; reason: string };

export async function runMissionLoop(options: RunMissionLoopOptions): Promise<MissionLoopResult> {
	const maxIterations = options.maxIterations ?? 100;
	let iterations = 0;

	while (iterations <= maxIterations) {
		if (options.signal?.aborted) {
			return { status: "stopped", iterations };
		}

		const mission = parseMissionDefinition(options.missionDir);
		if (mission.mode === "optimize") {
			const prompt = buildMissionIterationPrompt(mission);
			await options.executeIteration({ mission, prompt });
			if (options.signal?.aborted) {
				return { status: "stopped", iterations: iterations + 1 };
			}
			iterations += 1;
			continue;
		}

		if (mission.allTasksDone) {
			return { status: "done", iterations };
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
		if (options.signal?.aborted) {
			return { status: "stopped", iterations: iterations + 1 };
		}
		iterations += 1;
	}

	return {
		status: "blocked",
		iterations,
		reason: `Mission exceeded max iteration limit (${maxIterations})`,
	};
}

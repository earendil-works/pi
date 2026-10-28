import type { Task, TaskDefinition } from "./types.ts";

/** Define an executable task. Register it in the registry so a Harness can run tasks of its kind. */
export function defineTask<I, S extends { phase: string }, R, H extends object = object>(
	definition: TaskDefinition<I, S, R, H>,
): Task<I, S, R, H> {
	return { definition };
}

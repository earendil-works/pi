/**
 * Parallel sub-task execution for independent agent workloads.
 *
 * The main agent loop is inherently sequential: each turn waits for an LLM
 * response, executes tool calls (possibly concurrently within the turn), then
 * waits for the next prompt. Many real tasks decompose into independent
 * sub-tasks that have no shared state and could be handled by separate agent
 * instances running at the same time.
 *
 * `runParallelAgentTasks` runs N independent agent loops concurrently and
 * collects their results. It does not modify the parent context and does not
 * require the sub-tasks to coordinate with each other.
 *
 * Intended for use by extensions, custom tools, and harness integrations that
 * have already identified a set of independent work items. Task decomposition
 * (deciding *what* to run in parallel) is left to the caller — this utility
 * only handles *how* to run it.
 */

import { agentLoop } from "./agent-loop.ts";
import type { AgentContext, AgentLoopConfig, AgentMessage, StreamFn } from "./types.ts";

/** A single sub-task to run in parallel. */
export interface ParallelAgentTask {
	/** Initial prompt messages for this sub-task's agent loop. */
	prompts: AgentMessage[];
	/** Snapshot of the context this sub-task runs in. */
	context: AgentContext;
	/** Loop config (model, tools, hooks, etc.). */
	config: AgentLoopConfig;
	/** Optional abort signal scoped to this sub-task. */
	signal?: AbortSignal;
	/** Optional stream function override for this sub-task. */
	streamFn?: StreamFn;
}

/** Result of one completed (or failed) sub-task. */
export type ParallelAgentResult =
	| {
			status: "fulfilled";
			/** Messages produced by this sub-task's agent loop. */
			messages: AgentMessage[];
	  }
	| {
			status: "rejected";
			/** Reason the sub-task loop failed. */
			reason: unknown;
	  };

/**
 * Run multiple independent agent loops concurrently.
 *
 * Each task gets its own isolated agent loop. Results are returned in the same
 * order as the input tasks regardless of completion order.
 *
 * Sub-task failures are captured as `{ status: "rejected" }` entries rather
 * than thrown, so a single failing sub-task does not abort the others.
 *
 * @example
 * ```typescript
 * const results = await runParallelAgentTasks([
 *   { prompts: [userMsg("summarise file A")], context, config },
 *   { prompts: [userMsg("summarise file B")], context, config },
 *   { prompts: [userMsg("summarise file C")], context, config },
 * ]);
 * for (const result of results) {
 *   if (result.status === "fulfilled") {
 *     console.log(result.messages);
 *   }
 * }
 * ```
 */
export async function runParallelAgentTasks(tasks: ReadonlyArray<ParallelAgentTask>): Promise<ParallelAgentResult[]> {
	const settled = await Promise.allSettled(
		tasks.map(({ prompts, context, config, signal, streamFn }) =>
			agentLoop(prompts, context, config, signal, streamFn).result(),
		),
	);

	return settled.map((outcome): ParallelAgentResult => {
		if (outcome.status === "fulfilled") {
			return { status: "fulfilled", messages: outcome.value };
		}
		return { status: "rejected", reason: outcome.reason };
	});
}

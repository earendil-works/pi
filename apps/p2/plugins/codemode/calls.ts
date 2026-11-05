// The codemode tool calls running in this worker, so that removing the plugin can end them.

import {
	type Harness as DurableHarness,
	LiveDoc,
	type LiveState,
	type TaskId,
	type ToolExecutionApi,
	type ToolExecutionResult,
} from "@earendil-works/pi-durable";
import type { Context } from "@p2/app/v1";

/** What a call removed mid-script reports, as its output, before Durable settles it aborted. */
export const REMOVED_MESSAGE = "Code mode was removed while this script ran.";
/** How long to wait for that output to be committed to the call's slot before aborting anyway. */
const REPORT_MS = 2000;

/**
 * Problem: removing the plugin by a hot reload closes the sandbox while the Harness stays open. Durable stores no
 * outcome for a run the sandbox ended on its own (so a restart replays it), and the call then waits for its own
 * cancellation: nothing would ever settle it.
 * Solution: on removal (not on a worker stop, after which the next worker replays), each running call reports why in
 * its output, then is aborted through Durable (`abortTask`), which ends its script and nested calls bottom-up and
 * settles it with an error result. Only then is the sandbox closed.
 */
export class RunningCalls {
	readonly #calls = new Map<TaskId, ToolExecutionApi>();
	readonly #idle = new Set<() => void>();

	/** Runs one codemode `execute()`, known as running until it returns. */
	async track(api: ToolExecutionApi, run: () => Promise<ToolExecutionResult>): Promise<ToolExecutionResult> {
		this.#calls.set(api.taskId, api);
		try {
			return await run();
		} finally {
			this.#calls.delete(api.taskId);
			if (this.#calls.size === 0) for (const resolve of this.#idle) resolve();
		}
	}

	/** Resolves once no call runs (at once when none does). */
	idle(): Promise<void> {
		if (this.#calls.size === 0) return Promise.resolve();
		return new Promise((resolve) => {
			const done = () => {
				this.#idle.delete(done);
				resolve();
			};
			this.#idle.add(done);
		});
	}

	get size(): number {
		return this.#calls.size;
	}

	/** Ends every running call with an error result; resolves once each is terminal. */
	async cancel(harness: DurableHarness, context: Context): Promise<void> {
		await Promise.all(
			[...this.#calls.values()].map(async (api) => {
				try {
					api.output(`${REMOVED_MESSAGE}\n`);
					await reported(harness, api, context);
				} catch {
					// Already settling: the abort below decides.
				}
				await harness.abortTask(api.taskId, context);
				await harness.waitForTask(api.taskId, context);
			}),
		);
	}
}

/** Resolves once the call's slot holds the removal message (the output is committed with a throttle), or after a bound. */
async function reported(harness: DurableHarness, api: ToolExecutionApi, context: Context): Promise<void> {
	const done = (live: Readonly<LiveState> | undefined): boolean => {
		const slot = live?.tools?.find((tool) => tool.taskId === api.taskId);
		return !slot || slot.status === "done" || slot.output?.includes(REMOVED_MESSAGE) === true;
	};
	const shown = Promise.withResolvers<void>();
	const observation = await harness.observeDoc(
		LiveDoc,
		api.conversationId,
		{
			advance: (call) => {
				if (call.kind === "value" && done(call.value)) shown.resolve();
			},
			end: () => shown.resolve(),
		},
		context,
	);
	if (observation === undefined) return;
	const timer = setTimeout(shown.resolve, REPORT_MS);
	try {
		if (!done(observation.value)) await shown.promise;
	} finally {
		clearTimeout(timer);
		observation.detach();
	}
}

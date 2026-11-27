// The sweep of sessions gone (`sweepGone`): what the workers of sessions without a row keep (their directories: a
// removal that found no runner, data older code left) is deleted, each one reported as it goes (decision 125: nothing
// of a Pi's data goes silently). The waker runs it whenever a runner appears, before it wakes the working sessions.

import { type Context, type Reference, reportError } from "@earendil-works/p3/v1";
import type { WorkerRunner } from "@earendil-works/p3/v1/server";
import type { SessionsStore } from "./contract.server.ts";

/**
 * Deletes what `runner` keeps of sessions `store` has no row of, one by one, and reports each one deleted and each one
 * that failed (it stays, and the next runner, the next start, tries again); one failing holds up none of the others.
 */
export async function sweepGone(
	runner: WorkerRunner,
	store: Reference<typeof SessionsStore>,
	ctx: Context,
): Promise<void> {
	let stored: readonly string[];
	try {
		stored = await runner.stored();
	} catch (error) {
		reportFailure("p3 sessions: the sweep of sessions gone could not list the workers' data", error, ctx);
		return;
	}
	for (const id of stored) {
		try {
			// The key: one read per directory, a few at a start.
			if ((await store.sessions.one.page({ id }, 1, ctx)).items.length > 0) continue;
			await runner.remove(id);
			reportError("p3 sessions: deleted the workers' data of a session gone", id, ctx);
		} catch (error) {
			reportFailure(`p3 sessions: the workers' data of session ${id}, gone, is still there`, error, ctx);
		}
	}
}

/** Reports `error` of `what`, unless it is the waker's end (its reload, the server's close): that is no failure. */
function reportFailure(what: string, error: unknown, ctx: Context): void {
	if (ctx.abortSignal?.aborted !== true) reportError(what, error, ctx);
}

// The sweep of sessions gone (`sweepGone`): what the workers of sessions without a row keep (their directories: a
// removal that found no runner, data older code left) is deleted and reported (decision 125: nothing of a Pi's data
// goes silently). The waker runs it whenever a runner appears, before it wakes the working sessions.

import { type Ctx, type P3Principal, type Reference, reportError } from "@earendil-works/p3/v1";
import type { WorkerRunner } from "@earendil-works/p3/v1/server";
import type { SessionsStore } from "./contract.server.ts";

/**
 * Deletes what `runner` keeps of sessions `store` has no row of, and reports their ids; a failure is reported, and the
 * next runner (the next start) sweeps again.
 */
export async function sweepGone(
	runner: WorkerRunner,
	store: Reference<typeof SessionsStore>,
	ctx: Ctx<P3Principal>,
): Promise<void> {
	try {
		const gone: string[] = [];
		for (const id of await runner.stored()) {
			// The key: one read per directory, a few at a start.
			if ((await store.sessions.one.page({ id }, 1, ctx)).items.length === 0) gone.push(id);
		}
		for (const id of gone) await runner.remove(id);
		if (gone.length > 0) reportError("p3 sessions: deleted the workers' data of sessions gone", gone, ctx);
	} catch (error) {
		// Ending with the waker (its reload, the server's close) is no failure.
		if (ctx.abortSignal?.aborted !== true) reportError("p3 sessions: the sweep of sessions gone", error, ctx);
	}
}

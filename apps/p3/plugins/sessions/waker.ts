// The waker: it starts the workers of every `working` session that is not archived whenever a runner appears in
// `WorkerRunners`: once the server is up (a restart cut their runs off; Durable resumes them there), and after a
// reload of the runner plugin (the old runner stopped every worker before the new one is contributed). It holds each
// one's `SessionStart` until the worker is live, then lets go, at most four at once: a Pi with many working sessions
// does not fork them all in one moment. A worker keeps itself alive while it works. Before it wakes them, it sweeps
// what the workers of sessions gone kept (`sweep.ts`).

import {
	type Ctx,
	contribute,
	type FacetHost,
	type P3Principal,
	reportError,
	untilAborted,
} from "@earendil-works/p3/v1";
import { ServerRuntime, type WorkerRunner, WorkerRunners } from "@earendil-works/p3/v1/server";
import { SessionsStore } from "./contract.server.ts";
import { SessionStart } from "./contract.ts";
import { sweepGone } from "./sweep.ts";

/** How many workers the waker starts at once. */
const AT_ONCE = 4;

/** Serves the waker on `host`. */
export function serveWaker(host: FacetHost<P3Principal>): void {
	contribute(host, "sessions.waker", (self) => {
		const store = self.get(SessionsStore, {});
		const runtime = self.registry(ServerRuntime);
		const runners = self.registry(WorkerRunners);
		self.onLive(async (ctx) => {
			/** Starts session `session`'s worker: held until it serves `SessionStart` (it is live then), then released. */
			const start = (session: string) =>
				runtime.value.host
					.root(async (root) => void (await root.get(SessionStart, { session })), ctx)
					.catch((error: unknown) => {
						// Ending with the waker (its reload, the server's close) is no failure.
						if (ctx.abortSignal?.aborted !== true) {
							reportError(`p3 sessions: ${session}: could not start its worker`, error, ctx);
						}
					});
			const wake = async (runner: WorkerRunner) => {
				await sweepGone(runner, store, ctx);
				await inTurns(await store.working({}, ctx), start, ctx);
			};
			const watch = await runners.watch(ctx);
			try {
				if (watch.value !== undefined) await wake(watch.value);
				// Each new runner wakes them again (`undefined` comes between two: the old one withdrew before it stopped
				// its workers).
				watch.start(async (call) => {
					if (call.kind === "value" && call.value !== undefined) await wake(call.value);
				});
				await untilAborted(ctx);
			} finally {
				await watch.stop();
			}
		});
	});
}

/** Runs `start` for every one of `sessions`, at most `AT_ONCE` at a time, until `ctx` aborts. */
async function inTurns(sessions: readonly string[], start: (session: string) => Promise<void>, ctx: Ctx) {
	let next = 0;
	const turn = async (): Promise<void> => {
		while (next < sessions.length && ctx.abortSignal?.aborted !== true) await start(sessions[next++]!);
	};
	await Promise.all(Array.from({ length: Math.min(AT_ONCE, sessions.length) }, turn));
}

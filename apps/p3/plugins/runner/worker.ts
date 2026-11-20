// The runner plugin on a session's worker: the worker stops itself once it was idle for its idle time (no holds, calls,
// jobs or lingering objects on its host, every `WorkerBusy` count 0). Any work in between starts the wait again. How
// long, and whether to stop at all, is the runner's choice; the base only closes (`WorkerRuntime.close`).

import { contribute, defineFacet, untilAborted } from "@earendil-works/p3/v1";
import { WorkerBusy, WorkerRuntime } from "@earendil-works/p3/v1/worker";

export default defineFacet((host) => {
	contribute(host, "runner.idle", (self) => {
		const runtime = self.registry(WorkerRuntime);
		const busy = self.registry(WorkerBusy);
		self.onLive(async (ctx) => {
			const { host: worker, idleMs, close } = runtime.value;
			const idle = (): boolean => {
				const { references, calls, jobs, lingering } = worker.activity.value;
				return references + calls + jobs + lingering === 0 && busy.value === 0;
			};
			let timer: ReturnType<typeof setTimeout> | undefined;
			const check = (): void => {
				clearTimeout(timer);
				timer = idle() ? setTimeout(() => (idle() ? close() : check()), idleMs) : undefined;
			};
			const stops: (() => Promise<unknown>)[] = [];
			// One cleanup for every exit, an abort while a watch is being taken included.
			try {
				const activity = await worker.activity.watch(ctx);
				stops.push(() => activity.stop());
				const counts = await busy.watch(ctx);
				stops.push(() => counts.stop());
				activity.start(async () => check());
				counts.start(async () => check());
				check();
				await untilAborted(ctx);
			} finally {
				clearTimeout(timer);
				for (const stop of stops) await stop();
			}
		});
	});
});

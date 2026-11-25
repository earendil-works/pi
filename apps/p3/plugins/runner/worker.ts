// The runner plugin on a session's worker: the worker stops itself once it was idle for its idle time (no holds, calls,
// jobs or lingering objects on its host, every `WorkerBusy` count 0). Any work in between starts the wait again. How
// long, and whether to stop at all, is the runner's choice; the base only closes (`WorkerRuntime.close`).

import { contribute, defineFacet } from "@earendil-works/p3/v1";
import { WorkerBusy, WorkerRuntime } from "@earendil-works/p3/v1/worker";

export default defineFacet((host) => {
	contribute(host, "runner.idle", (self) => {
		const runtime = self.registry(WorkerRuntime);
		const busy = self.registry(WorkerBusy);
		self.onLive(async (ctx) => {
			const { host: worker, idleMs, close } = runtime.value;
			const idle = (): boolean => {
				const activity = worker.activity.value;
				return activity.references + activity.jobs + activity.lingering === 0 && busy.value === 0;
			};
			let timer: ReturnType<typeof setTimeout> | undefined;
			const check = (): void => {
				clearTimeout(timer);
				timer = idle() ? setTimeout(() => (idle() ? close("idle") : check()), idleMs) : undefined;
			};
			const watches = [await worker.activity.watch(ctx), await busy.watch(ctx)];
			for (const watch of watches) watch.start(async () => check());
			check();
			try {
				await new Promise<void>((resolve) =>
					ctx.abortSignal?.addEventListener("abort", () => resolve(), { once: true }),
				);
			} finally {
				clearTimeout(timer);
				for (const watch of watches) await watch.stop();
			}
		});
	});
});

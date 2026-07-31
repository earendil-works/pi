/** Instance-local FIFO: one owner at a time; same context identity coalesces; queued abort settles without fetch. */
export function createRefreshQueue<TContext extends { signal?: AbortSignal }>(
	refresh: (context: TContext) => Promise<void>,
): (context: TContext) => Promise<void> {
	type Job = {
		context: TContext | undefined;
		resolve: () => void;
		reject: (error: unknown) => void;
		onAbort?: () => void;
	};

	const queued: Job[] = [];
	let active: Job | undefined;
	const pending = new WeakMap<TContext, Promise<void>>();

	const detachListener = (job: Job) => {
		const context = job.context;
		if (context && job.onAbort) context.signal?.removeEventListener("abort", job.onAbort);
		job.onAbort = undefined;
	};

	const forget = (job: Job) => {
		detachListener(job);
		const context = job.context;
		if (context) pending.delete(context);
		job.context = undefined;
	};

	const runNext = () => {
		if (active) return;
		const job = queued.shift();
		if (!job) return;
		active = job;
		const context = job.context!;
		// Owner keeps pending for same-context coalescing; signal is observed by the refresh body.
		detachListener(job);

		void (async () => {
			try {
				await refresh(context);
				job.resolve();
			} catch (error) {
				job.reject(error);
			} finally {
				pending.delete(context);
				job.context = undefined;
				active = undefined;
				runNext();
			}
		})();
	};

	return (context) => {
		const existing = pending.get(context);
		if (existing) return existing;

		let resolve!: () => void;
		let reject!: (error: unknown) => void;
		const promise = new Promise<void>((res, rej) => {
			resolve = res;
			reject = rej;
		});
		const job: Job = { context, resolve, reject };
		pending.set(context, promise);

		const cancel = () => {
			if (job === active || !job.context) return;
			const index = queued.indexOf(job);
			if (index >= 0) queued.splice(index, 1);
			forget(job);
			job.resolve();
		};
		job.onAbort = cancel;
		queued.push(job);
		if (context.signal?.aborted) cancel();
		else context.signal?.addEventListener("abort", cancel, { once: true });
		if (job.context) runNext();
		return promise;
	};
}

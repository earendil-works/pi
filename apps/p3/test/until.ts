// Waiting in tests for what no watchable shows, and deadlines for what one does. `within(what, ctx)` is a context that
// aborts after a deadline, naming the wait: `until(member, done, within("the rename", ctx))` (`until` of `/v1`: after a
// call on the same reference the value is there already, design §3). `eventually(probe, done)` polls what no
// watchable shows (a process's exit, a file). `collected(refs)` collects garbage until weakly held values are gone (a
// cache's GC test). It imports nothing of p3, so a built-in plugin's own tests use it too.

import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import { type Context, withAbortSignal } from "@earendil-works/chord/context";

/**
 * `context` with a deadline for a wait on it (`until` of `/v1`): after `ms` (2 s by default) it aborts with an error
 * naming `what`, so a value that never comes fails the case at once, saying which.
 */
export function within(what: string, context: Context, ms = 2000): Context {
	const deadline = new AbortController();
	setTimeout(() => deadline.abort(new Error(`${what}: not within ${ms} ms`)), ms).unref();
	return withAbortSignal(deadline.signal, context);
}

/**
 * The first result of `probe` that does not throw and passes `done`, tried every 10 ms; rejects with the last error
 * after `ms` (10 s by default). For effects in other processes (a worker's exit), which no watchable shows here. Its
 * deadline is on the monotonic clock, so a case that mocks `Date` still fails in time.
 */
export async function eventually<T>(
	probe: () => T | Promise<T>,
	done: (value: T) => boolean = () => true,
	ms = 10_000,
): Promise<T> {
	const deadline = performance.now() + ms;
	let last: unknown = new Error("eventually: nothing passed");
	for (;;) {
		try {
			const value = await probe();
			if (done(value)) return value;
			last = new Error(`eventually: ${JSON.stringify(value)} did not pass`);
		} catch (error) {
			last = error;
		}
		if (performance.now() > deadline) throw last;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

/** Whether every value `refs` hold weakly is gone once garbage was collected (up to 20 rounds, a turn apart). */
export async function collected(refs: readonly WeakRef<object>[]): Promise<boolean> {
	setFlagsFromString("--expose-gc");
	const gc = runInNewContext("gc") as () => void;
	for (let i = 0; i < 20 && refs.some((ref) => ref.deref() !== undefined); i++) {
		await new Promise((resolve) => setImmediate(resolve));
		gc();
	}
	return refs.every((ref) => ref.deref() === undefined);
}

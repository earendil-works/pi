// Waiting in tests for an effect a test caused, without sleeps. `until(member, done, ctx)` resolves with the first
// value of a watchable (a reference's state member, its `state`, a registry) for which `done` holds, the current one
// included: for a change made elsewhere (another host's commit reaching this one, a first value); after a call on the
// same reference the value is there already (a call's answer follows its state, design §3). `eventually(probe, done)`
// polls what no watchable shows (a process's exit, a file). `collected(refs)` collects garbage until weakly held
// values are gone (a cache's GC test). It imports nothing of p3, so a plugin's own tests use it too.

import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import type { Context } from "@earendil-works/chord/context";
import type { NativeWatchable } from "@earendil-works/chord/watch";

/**
 * The first value of `source`, now or later, for which `done` holds; rejects after `ms` (2 s by default). A JSON
 * watchable is a native one too: `until` reads only each call's value.
 */
export async function until<T>(
	source: NativeWatchable<T>,
	done: (value: T) => boolean,
	context: Context,
	ms = 2000,
): Promise<T> {
	const watch = await source.watch(context);
	try {
		if (done(watch.value)) return watch.value;
		return await new Promise<T>((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error(`until: no matching value within ${ms} ms`)), ms);
			watch.start(async (call) => {
				if (call.kind === "value" && done(call.value)) {
					clearTimeout(timer);
					resolve(call.value);
				}
			});
		});
	} finally {
		await watch.stop();
	}
}

/**
 * The first result of `probe` that does not throw and passes `done`, tried every 10 ms; rejects with the last error
 * after `ms` (10 s by default). For effects in other processes (a worker's exit), which no watchable shows here.
 */
export async function eventually<T>(
	probe: () => T | Promise<T>,
	done: (value: T) => boolean = () => true,
	ms = 10_000,
): Promise<T> {
	const deadline = Date.now() + ms;
	let last: unknown = new Error("eventually: nothing passed");
	for (;;) {
		try {
			const value = await probe();
			if (done(value)) return value;
			last = new Error(`eventually: ${JSON.stringify(value)} did not pass`);
		} catch (error) {
			last = error;
		}
		if (Date.now() > deadline) throw last;
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

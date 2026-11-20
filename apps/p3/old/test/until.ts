// Waiting in tests for a value a test caused: `until(member, done, ctx)` resolves with the first value of a watchable
// (a reference's state member) for which `done` holds, the current one included; it rejects when `ms` pass first.
// Needed only for a change made elsewhere (another host's commit reaching this one, a first value). After a call on the
// same reference the value is there already: a call's answer follows its state (design §3).

import type { Watchable } from "@earendil-works/chord";
import type { Context } from "@earendil-works/chord/context";

/** The first value of `source`, now or later, for which `done` holds; rejects after `ms` (2 s by default). */
export async function until<T>(
	source: Watchable<T>,
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

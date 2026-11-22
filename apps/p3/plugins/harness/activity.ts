// What a session's agent is doing, from Durable's committed state: its live tasks (the task graph) and why the root
// conversation's last run ended (`pi.live`'s `runFailure`). The harness reports it to the server on transitions only.

import type { SessionState } from "@earendil-works/p3/v1";
import type { LiveState, TaskGraph } from "@earendil-works/p3/v1/worker";

/**
 * The session's state: `working` while a task outside a background boundary is live and not every such task sleeps on
 * signals; `waiting` when every one does (a question to a person); else `failed` when the root conversation's last run
 * ended without an answer, `settled` otherwise.
 */
export function activityOf(graph: TaskGraph, live: LiveState): SessionState {
	const tasks = Object.values(graph.tasks).filter((task) => !task.background);
	if (tasks.length > 0) {
		const asleep = tasks.every((task) => task.state.status === "sleeping" && (task.state.signals?.length ?? 0) > 0);
		return asleep ? "waiting" : "working";
	}
	return live.runFailure === undefined ? "settled" : "failed";
}

/** Runs each call of the returned function after the ones before it have settled, in call order. */
export function serialized(): <T>(fn: () => Promise<T>) => Promise<T> {
	let last: Promise<unknown> = Promise.resolve();
	return (fn) => {
		const next = last.then(fn, fn);
		last = next.catch(() => {});
		return next;
	};
}

/**
 * Serializes asynchronous operations: each call waits until the previous one
 * has fully settled (including its finally blocks) before starting.
 *
 * Used by the AgentSession wrapper to serialize manual compactions. Upstream's
 * compact() keeps its abort controller in a singleton field that
 * _clearManualCompactionState() resets to undefined from the finally block;
 * when two manual compactions overlap, the first compaction's finally can
 * clear the second's controller while the second is between installing it and
 * reading it, crashing the second compaction with
 * "Cannot read properties of undefined (reading 'signal')" before it emits
 * compaction_end — which leaves the TUI's "Compacting context..." indicator
 * spinning forever on a dead compaction. Running manual compactions strictly
 * one at a time removes the overlap entirely.
 */
export function createAsyncSerializer(): <T>(fn: () => Promise<T>) => Promise<T> {
	let tail: Promise<unknown> = Promise.resolve();
	return function serialize<T>(fn: () => Promise<T>): Promise<T> {
		// Run fn whether or not the previous call succeeded.
		const run = tail.then(fn, fn);
		tail = run.catch(() => {});
		return run;
	};
}

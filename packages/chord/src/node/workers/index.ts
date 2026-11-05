// Chord v2's workers component (`@earendil-works/chord/workers`, slice 10 §3, §4): a forked worker process per
// address of a host kind, started on demand, stopped when idle, never restarted by itself, its plugins shipped from the
// server; `workerMain` is the worker's side (also `@earendil-works/chord/workers/child`, without esbuild). Node-only.

export * from "./child.ts";
export {
	createWorkers,
	type WorkerState,
	type Workers,
	type WorkersError,
	type WorkersOptions,
} from "./workers.ts";

// Chord v2's workers component (`@earendil-works/chord/next/workers`, slice 10 §3, §4): a forked worker process per
// address of a host kind, started on demand, stopped when idle, never restarted by itself, its plugins shipped from the
// server; `workerMain` is the worker's side. Node-only.

export type { CrossedError } from "./control.ts";
export { type ProcessLock, processLock } from "./lock.ts";
export {
	type WorkerMainOptions,
	type WorkerPlugins,
	type WorkerResult,
	type WorkerStart,
	workerMain,
} from "./main.ts";
export {
	createWorkers,
	type WorkerState,
	type Workers,
	type WorkersError,
	type WorkersOptions,
} from "./workers.ts";

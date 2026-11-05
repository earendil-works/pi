// The worker process's side of the workers component (`@earendil-works/chord/workers/child`): `workerMain` and
// `processLock` without the server's side, whose worker base bundles with esbuild. A worker entry imports this, so a
// forked worker never loads esbuild.

export type { CrossedError } from "./control.ts";
export { type ProcessLock, processLock } from "./lock.ts";
export {
	type WorkerMainOptions,
	type WorkerPlugins,
	type WorkerResult,
	type WorkerStart,
	workerMain,
} from "./main.ts";

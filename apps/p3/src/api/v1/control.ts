// The control messages between the server and a session worker: JSON messages beside the link's frames on one IPC
// channel (`{ p3: message }`; the IPC link takes only its frames). The base's worker speaks them, a runner sends them.

import type { PluginScript } from "@earendil-works/chord/plugins/runtime";

/** What the server sends a worker. */
export type ToWorker =
	| {
			readonly kind: "start";
			readonly session: string;
			/** The worker's private directory: its store lives in it. */
			readonly dir: string;
			/** The name of the session's lock (Chord's `processLock`): the worker takes it before it opens its store. */
			readonly lock: string;
			/** How long it idles before it stops itself. */
			readonly idleMs: number;
			readonly scripts: readonly PluginScript[];
	  }
	| { readonly kind: "reload"; readonly scripts: readonly PluginScript[] }
	| { readonly kind: "shutdown" };

/**
 * What a worker sends the server: `locked` once it holds its session's lock (a previous worker of the session exited);
 * `failed` names the plugins that did not load; `closed`: it stops itself (it was idle for its idle time) and exits
 * now, 0 once its host and store closed (a clean exit).
 */
export type FromWorker =
	| { readonly kind: "locked" }
	| { readonly kind: "ready"; readonly failed: readonly string[] }
	| { readonly kind: "reloaded"; readonly failed: readonly string[] }
	| { readonly kind: "reload_failed"; readonly error: string }
	| { readonly kind: "closed" };

/** A control message in its envelope, as it goes over the IPC channel. */
export function workerMessage(message: ToWorker | FromWorker): { readonly p3: ToWorker | FromWorker } {
	return { p3: message };
}

/** The control message in an IPC message, or `undefined` for a link frame. Both ends are p3's own processes. */
export function workerControl<M extends ToWorker | FromWorker>(message: unknown): M | undefined {
	return typeof message === "object" && message !== null && "p3" in message ? (message as { p3: M }).p3 : undefined;
}

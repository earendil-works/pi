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
			/**
			 * The session's lock (a socket path in a private directory, short enough for one: at most 104 bytes), which
			 * the worker takes before it opens its store.
			 */
			readonly lock: string;
			/** How long it idles before it stops itself. */
			readonly idleMs: number;
			readonly scripts: readonly PluginScript[];
	  }
	| { readonly kind: "reload"; readonly scripts: readonly PluginScript[] }
	| { readonly kind: "shutdown" };

/**
 * What a worker sends the server: `failed` names the plugins that did not load; `closed`: it was idle for its idle
 * time and its store's queued commits settled; it closes its host and store and exits now (a clean exit, no crash).
 */
export type FromWorker =
	| { readonly kind: "ready"; readonly failed: readonly string[] }
	| { readonly kind: "reloaded"; readonly failed: readonly string[] }
	| { readonly kind: "reload_failed"; readonly error: string }
	| { readonly kind: "closed"; readonly reason: "idle" };

/** A control message in its envelope, as it goes over the IPC channel. */
export function workerMessage(message: ToWorker | FromWorker): { readonly p3: ToWorker | FromWorker } {
	return { p3: message };
}

/** The control message in an IPC message, or `undefined` for a link frame. Both ends are p3's own processes. */
export function workerControl<M extends ToWorker | FromWorker>(message: unknown): M | undefined {
	return typeof message === "object" && message !== null && "p3" in message ? (message as { p3: M }).p3 : undefined;
}

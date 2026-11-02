// The worker's side (slice 10 §3): `workerMain` reads the start message, takes the address's lock, makes the link to
// the server (`started` goes out when the app's host listens on it), runs the app's function with a plugin runtime over
// the shipped scripts, reports `ready` and each idle flip, applies reloads, and on `shutdown`, the parent's disconnect,
// `SIGTERM` or `SIGINT` aborts its context, runs the app's closers in reverse order and exits.

import { BACKGROUND_CONTEXT, type Context, withAbortSignal } from "../../context/index.ts";
import type { JsonValue } from "../../json.ts";
import type { Address } from "../../next/contracts/index.ts";
import type { Principal } from "../../next/data/index.ts";
import type { Host, LoadReport, PluginFacet, ReloadReport } from "../../next/host/index.ts";
import { type IpcPort, ipcLink, type Link } from "../../next/link/index.ts";
import type { Watchable } from "../../watch.ts";
import type { HostPackages } from "../plugins/evaluate.ts";
import { createPluginRuntime, type PluginScript } from "../plugins/runtime.ts";
import {
	type CrossedError,
	controlOf,
	crossed,
	crossedReport,
	envelope,
	type FromWorker,
	type ToWorker,
} from "./control.ts";
import { processLock } from "./lock.ts";

/** What the app's function gets. */
export type WorkerStart = {
	readonly address: Address;
	/** The start data the server's `start(address)` gave. */
	readonly start: JsonValue;
	/** The link to the server: `connect` it before anything slow (`started` goes out then). */
	readonly parent: Link;
	readonly plugins: WorkerPlugins;
	/** Registers a closer: closers run in reverse order at shutdown. */
	onClose(closer: (context: Context) => Promise<void> | void): void;
};

/** The worker's plugins: the shipped scripts of its kind, loaded on its host; the server's reloads applied to it. */
export interface WorkerPlugins {
	/** Loads `host` with the start message's scripts of `kind` and `core` (the app's own facets). */
	load<P extends Principal>(
		host: Host<P>,
		options: { readonly kind: string; readonly core: readonly PluginFacet<P>[] },
		context: Context,
	): Promise<LoadReport>;
}

/** What the app's function returns: extra keep-alive counts (busy while any is nonzero). */
export type WorkerResult = { readonly busy?: Watchable<Readonly<Record<string, number>>> };

/** What `workerMain` takes besides the app's function. */
export type WorkerMainOptions = {
	/** The host packages by specifier: this process's own instances (functions cannot cross IPC). */
	readonly hostPackages: HostPackages;
	/** What crosses as `fatal` for an error (never the original message unless this returns it). */
	readonly redact: (error: unknown) => CrossedError;
	readonly onError: (error: unknown) => void;
};

/**
 * Runs this process as a worker: `fn` once the start message arrived and the lock is taken. An uncaught error or a
 * throwing `fn` sends `fatal` (redacted) and exits.
 */
export function workerMain(
	fn: (start: WorkerStart, context: Context) => Promise<WorkerResult | undefined>,
	options: WorkerMainOptions,
): void {
	// `process` is the IPC port of a forked child.
	new Worker(process as unknown as IpcPort, options).run(fn);
}

/** How long a shutdown's closers get before the worker exits anyway: 3 s. */
const FORCED_EXIT = 3_000;

class Worker {
	readonly #port: IpcPort;
	readonly #options: WorkerMainOptions;
	readonly #controller = new AbortController();
	readonly #context: Context;
	readonly #closers: ((context: Context) => Promise<void> | void)[] = [];
	readonly #start = Promise.withResolvers<Extract<ToWorker, { readonly kind: "start" }>>();
	/** Reloads that arrived, applied one after another once `fn` returned. */
	readonly #reloads: (readonly PluginScript[])[] = [];
	#loaded: { readonly host: Host<Principal>; readonly runtime: ReturnType<typeof createPluginRuntime> } | undefined;
	#ready = false;
	#reloading = false;
	#busy: Watchable<Readonly<Record<string, number>>> | undefined;
	/** The last idle state sent. */
	#idle: boolean | undefined;
	#stopping = false;

	constructor(port: IpcPort, options: WorkerMainOptions) {
		this.#port = port;
		this.#options = options;
		this.#context = withAbortSignal(this.#controller.signal, BACKGROUND_CONTEXT);
		port.on("message", (message) => this.#message(controlOf<ToWorker>(message)));
		port.on("disconnect", () => void this.#shutdown());
		for (const signal of ["SIGTERM", "SIGINT"] as const) process.once(signal, () => void this.#shutdown());
		process.once("uncaughtException", (error) => this.#fatal(error));
		process.once("unhandledRejection", (error) => this.#fatal(error));
	}

	/** Takes the lock, makes the parent link, runs `fn`, then reports `ready` and applies reloads. */
	run(fn: (start: WorkerStart, context: Context) => Promise<WorkerResult | undefined>): void {
		// A throw while shutting down is the shutdown's own cancellation (its `ctx` aborted): no fatal, the closers run.
		void this.#run(fn).catch((error: unknown) => {
			if (!this.#stopping) this.#fatal(error);
		});
	}

	async #run(fn: (start: WorkerStart, context: Context) => Promise<WorkerResult | undefined>): Promise<void> {
		const message = await this.#start.promise;
		await processLock(message.lock, this.#context);
		const parent = new ParentLink(ipcLink(this.#port), () => this.#send({ kind: "started" }));
		const runtime = createPluginRuntime();
		const plugins: WorkerPlugins = {
			load: async (host, { kind, core }, context) => {
				this.#loaded = { host: host as unknown as Host<Principal>, runtime };
				return runtime.load(
					host,
					{ kind, core, scripts: message.scripts, modules: this.#options.hostPackages },
					context,
				);
			},
		};
		let report: LoadReport = { failed: [] };
		const loading: WorkerPlugins = {
			load: async (host, options, context) => {
				report = await plugins.load(host, options, context);
				return report;
			},
		};
		const start: WorkerStart = {
			address: message.address,
			start: message.start,
			parent,
			plugins: loading,
			onClose: (closer) => void this.#closers.push(closer),
		};
		const result = await fn(start, this.#context);
		if (this.#stopping) return;
		this.#busy = result?.busy;
		await this.#follow();
		this.#ready = true;
		const failed = new Set(report.failed.map(({ plugin }) => plugin));
		const added = message.scripts.map(({ plugin }) => plugin.name).filter((name) => !failed.has(name));
		const loaded: ReloadReport = { plugins: { added, changed: [], removed: [] }, failed: report.failed, objects: [] };
		this.#idle = this.#isIdle();
		this.#send({ kind: "ready", idle: this.#idle, report: crossedReport(loaded) });
		void this.#applyReloads();
	}

	/** Follows the host's activity and the app's `busy`: each idle flip is reported. */
	async #follow(): Promise<void> {
		const sources: Watchable<unknown>[] = [];
		if (this.#loaded !== undefined) sources.push(this.#loaded.host.activity);
		if (this.#busy !== undefined) sources.push(this.#busy);
		for (const source of sources) {
			const watch = await source.watch(this.#context);
			watch.start(async () => this.#flip());
		}
	}

	/** Whether every count is zero: the host's references, jobs and lingering objects, the app's `busy`, no reload. */
	#isIdle(): boolean {
		if (this.#reloading) return false;
		const activity = this.#loaded?.host.activity.value;
		if (activity !== undefined && activity.references + activity.jobs + activity.lingering > 0) return false;
		return Object.values(this.#busy?.value ?? {}).every((count) => count === 0);
	}

	/** Reports the idle state when it flipped (after `ready`). */
	#flip(): void {
		if (!this.#ready) return;
		const idle = this.#isIdle();
		if (idle === this.#idle) return;
		this.#idle = idle;
		this.#send({ kind: "idle", idle });
	}

	/** A control message from the server. */
	#message(message: ToWorker | undefined): void {
		if (message === undefined) return;
		switch (message.kind) {
			case "start":
				this.#start.resolve(message);
				return;
			case "shutdown":
				void this.#shutdown();
				return;
			case "reload":
				// A worker shutting down applies no reload (its exit answers it).
				if (this.#stopping) return;
				this.#reloads.push(message.scripts);
				if (this.#ready) void this.#applyReloads();
		}
	}

	/** Applies the reloads that arrived, one after another, each answered `reloaded`. */
	async #applyReloads(): Promise<void> {
		if (this.#reloading || this.#reloads.length === 0) return;
		const loaded = this.#loaded;
		this.#reloading = true;
		this.#flip();
		for (
			let scripts = this.#reloads.shift();
			scripts !== undefined && !this.#stopping;
			scripts = this.#reloads.shift()
		) {
			if (loaded === undefined) {
				this.#send({ kind: "reloaded", error: { message: "worker: plugins.load was never called" } });
				continue;
			}
			try {
				const report = await loaded.runtime.reload(loaded.host, scripts, this.#context);
				this.#send({ kind: "reloaded", report: crossedReport(report) });
			} catch (error) {
				this.#send({ kind: "reloaded", error: crossed(error) });
			}
		}
		this.#reloading = false;
		this.#flip();
	}

	/** Aborts the context, runs the closers in reverse order and exits (forced after 3 s). */
	async #shutdown(): Promise<void> {
		if (this.#stopping) return;
		this.#stopping = true;
		this.#controller.abort(new Error("worker: shutting down"));
		setTimeout(() => process.exit(0), FORCED_EXIT).unref();
		const context = BACKGROUND_CONTEXT;
		for (const closer of this.#closers.reverse()) {
			try {
				await closer(context);
			} catch (error) {
				this.#options.onError(error);
			}
		}
		process.exit(0);
	}

	/** Sends `fatal` with the redacted error, then exits. */
	#fatal(error: unknown): void {
		this.#options.onError(error);
		let redacted: CrossedError;
		try {
			redacted = this.#options.redact(error);
		} catch {
			redacted = { message: "worker: fatal error" };
		}
		if (!this.#port.connected) process.exit(1);
		// `process.send` takes a callback once the message is out.
		(process.send as (message: unknown, callback: () => void) => void)(
			envelope({ kind: "fatal", error: redacted }),
			() => process.exit(1),
		);
	}

	/** Sends a control message; dropped when the server is gone. */
	#send(message: FromWorker): void {
		if (this.#port.connected) process.send?.(envelope(message), undefined, undefined, () => {});
	}
}

/** The link to the server as the app gets it: `started` goes out when the app's host sets its listener (`connect`). */
class ParentLink implements Link {
	readonly #inner: Link;
	#started: (() => void) | undefined;

	constructor(inner: Link, started: () => void) {
		this.#inner = inner;
		this.#started = started;
	}

	send(message: Uint8Array): void {
		this.#inner.send(message);
	}

	onMessage(listener: (message: Uint8Array) => void): void {
		this.#inner.onMessage(listener);
		const started = this.#started;
		this.#started = undefined;
		started?.();
	}

	close(): void {
		this.#inner.close();
	}

	onClose(listener: () => void): void {
		this.#inner.onClose(listener);
	}
}

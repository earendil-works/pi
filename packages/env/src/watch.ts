import type { Context } from "@earendil-works/chord";
import { type FileChange, FileError, type FileWatcher, type WatchTarget } from "@earendil-works/pi-durable/env";
import { type Connection, isConnectionLost } from "./connection.ts";
import { toFileError } from "./errors.ts";

/** How the daemon watches, like `NodeExecutionEnv`'s `NodeWatchOptions`. */
export interface RemoteWatchOptions {
	/** Force a mode; by default Windows and file systems that do not report remote changes poll. */
	mode?: "native" | "polling";
	/** Interval between snapshots in `polling` mode; default 2000 ms. */
	pollIntervalMs?: number;
	/** Most directories one watcher covers; default 10,000. */
	maxDirectories?: number;
}

/** The one `overflow` change; it carries nothing else. */
const OVERFLOW: FileChange = { kind: "overflow" };

const RECONNECT_FIRST_MS = 1000;
const RECONNECT_MAX_MS = 30_000;

/**
 * A watcher running in the daemon (Durable's `NodeFileWatcher` next to the files). When the connection is lost, it is
 * opened again once the connection can be started again, and reports `overflow`: changes in between were not seen.
 */
export class RemoteWatcher implements FileWatcher {
	readonly #connection: Connection;
	readonly #targets: readonly WatchTarget[];
	readonly #onChange: (change: FileChange) => void;
	readonly #options: RemoteWatchOptions;
	#mode: "native" | "polling" = "native";
	#stopped = false;
	#controller: AbortController | undefined;
	#request: Promise<void> | undefined;
	#wake: (() => void) | undefined;

	private constructor(
		connection: Connection,
		targets: readonly WatchTarget[],
		onChange: (change: FileChange) => void,
		options: RemoteWatchOptions,
	) {
		this.#connection = connection;
		this.#targets = targets;
		this.#onChange = onChange;
		this.#options = options;
	}

	/** Watch `targets` (resolved paths); fails like `NodeFileWatcher.open` if coverage cannot be established. */
	static async open(
		connection: Connection,
		targets: readonly WatchTarget[],
		onChange: (change: FileChange) => void,
		options: RemoteWatchOptions = {},
	): Promise<RemoteWatcher> {
		const watcher = new RemoteWatcher(connection, targets, onChange, options);
		await watcher.#start();
		return watcher;
	}

	get mode(): "native" | "polling" {
		return this.#mode;
	}

	async stop(_context: Context): Promise<void> {
		if (this.#stopped) return;
		this.#stopped = true;
		this.#wake?.();
		this.#controller?.abort();
		await this.#request;
	}

	#deliver(change: FileChange): void {
		if (this.#stopped) return;
		try {
			this.#onChange(change);
		} catch {
			// A throwing callback must not stop watching.
		}
	}

	/** Open the daemon's watcher; resolves once it reports coverage. */
	#start(): Promise<void> {
		return new Promise((resolve, reject) => {
			let ready = false;
			const controller = new AbortController();
			this.#controller = controller;
			const request = this.#connection.request(
				"watch",
				{
					targets: this.#targets.map((target) => ({
						path: target.path,
						recursive: target.recursive === true,
						exclude: { hidden: target.exclude?.hidden === true, names: [...(target.exclude?.names ?? [])] },
					})),
					...this.#options,
				},
				{
					signal: controller.signal,
					onEvent: (event) => {
						if (event.kind === "ready") {
							ready = true;
							this.#mode = event.mode === "polling" ? "polling" : "native";
							resolve();
						} else if (event.kind === "change") {
							if (event.mode === "polling") this.#mode = "polling";
							// The daemon's wire format: `{ overflow: true }` or `{ paths }`.
							if (event.overflow === true) this.#deliver(OVERFLOW);
							else this.#deliver({ kind: "paths", paths: event.paths as string[] });
						} else if (event.kind === "error") {
							const code = event.code === "permission_denied" ? "permission_denied" : "invalid";
							this.#deliver({ kind: "failed", error: new FileError(code, String(event.message)) });
							this.#stopped = true;
						}
					},
				},
			);
			this.#request = request.then(
				() => {},
				(error: unknown) => {
					if (!ready) {
						reject(error);
						return;
					}
					if (this.#stopped) return;
					if (isConnectionLost(error)) {
						void this.#reconnect();
						return;
					}
					this.#deliver({ kind: "failed", error: toFileError(error) });
					this.#stopped = true;
				},
			);
		});
	}

	async #reconnect(): Promise<void> {
		for (let delay = RECONNECT_FIRST_MS; !this.#stopped; delay = Math.min(delay * 2, RECONNECT_MAX_MS)) {
			await new Promise<void>((resolve) => {
				const timer = setTimeout(resolve, delay);
				timer.unref();
				this.#wake = () => {
					clearTimeout(timer);
					resolve();
				};
			});
			this.#wake = undefined;
			if (this.#stopped) return;
			try {
				await this.#start();
				// Changes while disconnected were not seen.
				this.#deliver(OVERFLOW);
				return;
			} catch (error) {
				if (isConnectionLost(error)) continue;
				this.#deliver({ kind: "failed", error: toFileError(error) });
				this.#stopped = true;
				return;
			}
		}
	}
}

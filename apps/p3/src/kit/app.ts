// The running app: what `startServer` gives its caller. The server's host, its session workers, the data directory,
// the port it listens on, the owner's link of this start and token file, and the close.

import type { Host, HostError, Store } from "@earendil-works/chord";
import type { Context } from "@earendil-works/chord/context";
import type { HttpComponent, HttpError, ListenAddress } from "@earendil-works/chord/http";
import type { Plugins, PluginsError } from "@earendil-works/chord/plugins";
import type { ProcessLock, Workers, WorkersError } from "@earendil-works/chord/workers";
import type { Session } from "@earendil-works/p3/v1";
import type { P3Principal } from "../principals.ts";
import { removeRecord } from "./running.ts";

/**
 * What the kit reports: from its host, its HTTP component, its workers or its plugins, or the session workers' base
 * that did not build after the start (`base_build`: the server runs on, workers fail their start).
 */
export type AppError =
	| { readonly kind: "host"; readonly error: HostError }
	| { readonly kind: "http"; readonly error: HttpError }
	| { readonly kind: "workers"; readonly error: WorkersError }
	| { readonly kind: "plugins"; readonly error: PluginsError }
	| { readonly kind: "base_build"; readonly error: unknown };

/** A running p3 server. */
export interface App {
	readonly host: Host<P3Principal>;
	/** The session workers: their state, `stop` and `retry`. */
	readonly workers: Workers<typeof Session>;
	/** The data directory. */
	readonly dataDir: string;
	/** The port it listens on. */
	port(): number;
	/** The owner link of this start (single use, 10 minutes): `http://127.0.0.1:<port>/_p3/owner#<token>`. */
	ownerLink(): string;
	/** The owner token file's path (a device sign-in of the owner, mode 0600). */
	readonly ownerTokenFile: string;
	/**
	 * Closes the HTTP component, the workers, the host, the store and the plugins, removes the server's record and
	 * releases the data directory's lock.
	 */
	close(context: Context): Promise<void>;
}

/** What a running app is made of and closes. */
export type AppParts = {
	readonly host: Host<P3Principal>;
	readonly http: HttpComponent<P3Principal>;
	readonly workers: Workers<typeof Session>;
	readonly store: Store;
	readonly plugins: Plugins;
	readonly lock: ProcessLock;
};

/** The `App` of `startServer`: made before the server's plugins load, so a failed start closes what it opened. */
export class RunningApp implements App {
	readonly host: Host<P3Principal>;
	readonly workers: Workers<typeof Session>;
	readonly dataDir: string;
	readonly ownerTokenFile: string;
	readonly #parts: AppParts;
	/** The owner link and the address listened on, once the server listens. */
	#started: { readonly link: string; readonly listening: ListenAddress } | undefined;
	#closing: Promise<void> | undefined;

	constructor(parts: AppParts, layout: { readonly dataDir: string; readonly ownerToken: string }) {
		this.host = parts.host;
		this.workers = parts.workers;
		this.dataDir = layout.dataDir;
		this.ownerTokenFile = layout.ownerToken;
		this.#parts = parts;
	}

	/** The start finished: the owner link of this start and the address listened on. */
	started(link: string, listening: ListenAddress): void {
		this.#started = { link, listening };
	}

	ownerLink(): string {
		return this.#running().link;
	}

	port(): number {
		return this.#running().listening.port;
	}

	#running(): { readonly link: string; readonly listening: ListenAddress } {
		if (this.#started === undefined) throw new Error("app: the server has not started");
		return this.#started;
	}

	/** Whether the app is closing or closed: what runs after the start reports nothing more. */
	closing(): boolean {
		return this.#closing !== undefined;
	}

	close(context: Context): Promise<void> {
		this.#closing ??= this.#close(context);
		return this.#closing;
	}

	/**
	 * The close, in order: HTTP (it drains requests the host's close would seal), workers, host, store, the plugins'
	 * watcher, then the server's record and the data directory's lock (the record first: it is ours while we hold the
	 * lock).
	 */
	async #close(context: Context): Promise<void> {
		const { http, workers, host, store, plugins, lock } = this.#parts;
		await http.close(context);
		await workers.close(context);
		await host.close(context);
		await store.close(context);
		plugins.close();
		await removeRecord(this.dataDir, "server");
		await lock.release();
	}
}

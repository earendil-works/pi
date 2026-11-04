import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ExecutionEnv, FileChange, FileWatcher, WatchTarget } from "@earendil-works/pi-durable/env";

const context = BACKGROUND_CONTEXT;
/** An invalid read (an editor's save caught half-way) is read once more after this long before it is reported. */
const RETRY_INVALID_MS = 200;

/** Where to watch: an environment and the paths in it (computed when watching starts, e.g. from the remote home). */
export type ObservedFiles = { env: ExecutionEnv; targets: () => WatchTarget[] | Promise<WatchTarget[]> };

/**
 * Loads `load` whenever watched files may have changed. Watching is established before each load starts, so a change
 * made during a load is never missed: every change, `overflow` (lost events, reconnect) or explicit `reload()` bumps a
 * generation, and a load that finishes behind the current generation runs again. A load returns `true` to be read
 * once more shortly (content that may be half-written); it reports errors itself and keeps its last valid state.
 * While watching is impossible (an error, or offline), `fallbackMs` drives loads and new watch attempts.
 */
export class Observer {
	readonly #files: readonly ObservedFiles[];
	readonly #load: (retrying: boolean) => Promise<boolean | undefined>;
	readonly #fallbackMs: number;
	#generation = 0;
	#loaded = 0;
	#running: Promise<void> | undefined;
	#watchers: FileWatcher[] = [];
	#watching: Promise<void> | undefined;
	#fallback: ReturnType<typeof setTimeout> | undefined;
	#retry: ReturnType<typeof setTimeout> | undefined;
	#idle: (() => void)[] = [];
	#closed = false;

	constructor(
		files: readonly ObservedFiles[],
		load: (retrying: boolean) => Promise<boolean | undefined>,
		fallbackMs: number,
	) {
		this.#files = files;
		this.#load = load;
		this.#fallbackMs = fallbackMs;
	}

	/** Watch, then load; resolves after the first load. */
	async start(): Promise<void> {
		await this.#watch();
		await this.reload();
	}

	/** Load again now; resolves once loads have caught up with every change so far. */
	reload(): Promise<void> {
		if (this.#closed) return Promise.resolve();
		this.#generation++;
		const caughtUp = new Promise<void>((resolve) => this.#idle.push(resolve));
		this.#kick();
		return caughtUp;
	}

	async close(): Promise<void> {
		this.#closed = true;
		clearTimeout(this.#fallback);
		clearTimeout(this.#retry);
		await this.#watching;
		await Promise.allSettled(this.#watchers.map((watcher) => watcher.stop(context)));
		this.#watchers = [];
		await this.#running;
		for (const resolve of this.#idle.splice(0)) resolve();
	}

	#watch(): Promise<void> {
		this.#watching ??= (async () => {
			const watchers: FileWatcher[] = [];
			try {
				for (const { env, targets } of this.#files) {
					const watched = await env.watch(await targets(), (change) => this.#changed(change), context);
					if (!watched.ok) throw new Error(watched.error.message);
					watchers.push(watched.value);
				}
				if (this.#closed) throw new Error("closed");
				this.#watchers = watchers;
			} catch {
				await Promise.allSettled(watchers.map((watcher) => watcher.stop(context)));
				this.#scheduleFallback();
			} finally {
				this.#watching = undefined;
			}
		})();
		return this.#watching;
	}

	/** Without a watcher: load now and then, and try to watch again. */
	#scheduleFallback(): void {
		if (this.#closed) return;
		clearTimeout(this.#fallback);
		this.#fallback = setTimeout(() => {
			void this.#watch().then(() => this.reload());
		}, this.#fallbackMs);
		this.#fallback.unref();
	}

	#changed(change: FileChange): void {
		if (this.#closed) return;
		if (change.kind === "failed") {
			// A watcher stopped; the others may still run. Watch everything again later and load meanwhile.
			const watchers = this.#watchers;
			this.#watchers = [];
			void Promise.allSettled(watchers.map((watcher) => watcher.stop(context)));
			this.#scheduleFallback();
		}
		void this.reload();
	}

	#kick(retrying = false): void {
		if (this.#running || this.#closed) return;
		this.#running = (async () => {
			let again = retrying;
			while (this.#loaded < this.#generation && !this.#closed) {
				const generation = this.#generation;
				let retry: boolean | undefined;
				try {
					retry = await this.#load(again);
				} catch {
					retry = false;
				}
				again = false;
				this.#loaded = generation;
				if (retry && !this.#closed) {
					clearTimeout(this.#retry);
					this.#retry = setTimeout(() => {
						this.#generation++;
						this.#kick(true);
					}, RETRY_INVALID_MS);
					this.#retry.unref();
				}
			}
		})().finally(() => {
			this.#running = undefined;
			if (this.#loaded < this.#generation) this.#kick();
			else for (const resolve of this.#idle.splice(0)) resolve();
		});
	}
}

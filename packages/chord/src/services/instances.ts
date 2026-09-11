import { BACKGROUND_CONTEXT, withCancel } from "../context/index.ts";
import type { Context } from "../types.ts";

export interface InstanceDirectoryEntry {
	readonly key: string;
	readonly generation: number;
	readonly service: object;
	deactivate(): void;
}

interface Observer {
	readonly handler: (service: object, context: Context) => void | Promise<void>;
	readonly tasks: Map<InstanceDirectoryEntry, { readonly cancel: (reason?: unknown) => void }>;
	closed: boolean;
}

/** Owns keyed instance lifetime and the cancellable tasks observing those instances. */
export class InstanceDirectory<TEntry extends InstanceDirectoryEntry> {
	readonly #entries = new Map<string, TEntry>();
	readonly #observers = new Set<Observer>();
	readonly #reportError: (error: Error) => void;
	#ready: boolean;
	#disposed = false;

	constructor(options: { readonly ready: boolean; readonly onError: (error: Error) => void }) {
		this.#ready = options.ready;
		this.#reportError = options.onError;
	}

	get observerCount(): number {
		return this.#observers.size;
	}

	get(key: string): TEntry | undefined {
		return this.#entries.get(key);
	}

	insert(entry: TEntry): void {
		this.#assertActive();
		if (this.#entries.has(entry.key)) {
			throw new Error(`Keyed service already has a live instance with key ${entry.key}`);
		}
		this.#entries.set(entry.key, entry);
		if (this.#ready) this.#startAll(entry);
	}

	replace(entry: TEntry): void {
		this.#assertActive();
		const previous = this.#entries.get(entry.key);
		if (previous !== undefined) {
			if (previous.generation === entry.generation) {
				throw new Error("Keyed service repeated a live generation");
			}
			this.#remove(previous);
		}
		this.#entries.set(entry.key, entry);
		if (this.#ready) this.#startAll(entry);
	}

	remove(entry: TEntry): void {
		if (this.#entries.get(entry.key) !== entry) return;
		this.#remove(entry);
	}

	ready(): void {
		this.#assertActive();
		if (this.#ready) return;
		this.#ready = true;
		for (const entry of this.#entries.values()) this.#startAll(entry);
	}

	reset(): void {
		if (this.#disposed) return;
		this.#ready = false;
		for (const entry of [...this.#entries.values()]) this.#remove(entry);
	}

	observe<T>(handler: (service: T, context: Context) => void | Promise<void>): () => void {
		this.#assertActive();
		const observer: Observer = {
			handler: handler as Observer["handler"],
			tasks: new Map(),
			closed: false,
		};
		this.#observers.add(observer);
		if (this.#ready) {
			for (const entry of this.#entries.values()) this.#start(observer, entry);
		}
		return () => {
			if (observer.closed) return;
			observer.closed = true;
			for (const task of observer.tasks.values()) task.cancel();
			observer.tasks.clear();
			this.#observers.delete(observer);
		};
	}

	dispose(): void {
		if (this.#disposed) return;
		this.#disposed = true;
		for (const observer of this.#observers) {
			observer.closed = true;
			for (const task of observer.tasks.values()) task.cancel();
			observer.tasks.clear();
		}
		this.#observers.clear();
		for (const entry of [...this.#entries.values()]) {
			entry.deactivate();
		}
		this.#entries.clear();
	}

	#remove(entry: TEntry): void {
		if (this.#entries.get(entry.key) !== entry) return;
		this.#entries.delete(entry.key);
		entry.deactivate();
		for (const observer of this.#observers) {
			observer.tasks.get(entry)?.cancel();
			observer.tasks.delete(entry);
		}
	}

	#startAll(entry: TEntry): void {
		for (const observer of this.#observers) this.#start(observer, entry);
	}

	#start(observer: Observer, entry: TEntry): void {
		if (observer.closed || observer.tasks.has(entry)) return;
		const { context, cancel } = withCancel(BACKGROUND_CONTEXT);
		observer.tasks.set(entry, { cancel });
		try {
			void Promise.resolve(observer.handler(entry.service, context)).catch((error: unknown) => {
				if (!context.abortSignal?.aborted) this.#reportError(toError(error));
			});
		} catch (error) {
			if (!context.abortSignal?.aborted) this.#reportError(toError(error));
		}
	}

	#assertActive(): void {
		if (this.#disposed) throw new Error("Keyed service directory is disposed");
	}
}

function toError(error: unknown): Error {
	return error instanceof Error ? error : new Error(String(error));
}

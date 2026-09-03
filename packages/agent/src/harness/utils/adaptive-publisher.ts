export interface AdaptivePublisherOptions<TValue, TUpdate> {
	snapshot(): TValue;
	update(previous: TValue | undefined, current: TValue): TUpdate | undefined;
	measure(update: TUpdate): number;
	publish(update: TUpdate): void;
	onError(error: unknown): void;
	minIntervalMs?: number;
	targetBytesPerSecond?: number;
}

/**
 * Publishes the latest state without queuing intermediate mutations.
 *
 * The first dirty state after idle is immediate. Each publication then buys a
 * delay proportional to its encoded size, with a minimum interval that also
 * bounds event count. A single trailing timer guarantees eventual publication.
 */
export class AdaptivePublisher<TValue, TUpdate> {
	readonly #options: AdaptivePublisherOptions<TValue, TUpdate>;
	readonly #minIntervalMs: number;
	readonly #targetBytesPerSecond: number;
	#published: TValue | undefined;
	#dirty = false;
	#nextEmitAt = 0;
	#timer: ReturnType<typeof setTimeout> | undefined;
	#disposed = false;

	constructor(options: AdaptivePublisherOptions<TValue, TUpdate>) {
		this.#options = options;
		this.#minIntervalMs = options.minIntervalMs ?? 100;
		this.#targetBytesPerSecond = options.targetBytesPerSecond ?? 100 * 1024;
	}

	markDirty(): void {
		if (this.#disposed) return;
		this.#dirty = true;
		const wait = this.#nextEmitAt - Date.now();
		if (wait <= 0) {
			this.flush();
			return;
		}
		this.#armTimer(wait);
	}

	flush(force = false): void {
		if (this.#disposed || !this.#dirty) return;
		const now = Date.now();
		if (!force && now < this.#nextEmitAt) {
			this.#armTimer(this.#nextEmitAt - now);
			return;
		}
		if (this.#timer !== undefined) clearTimeout(this.#timer);
		this.#timer = undefined;
		const current = this.#options.snapshot();
		const update = this.#options.update(this.#published, current);
		if (update === undefined) {
			this.#published = current;
			this.#dirty = false;
			return;
		}
		const encodedBytes = this.#options.measure(update);
		this.#published = current;
		this.#dirty = false;
		this.#nextEmitAt = now + Math.max(this.#minIntervalMs, (encodedBytes * 1000) / this.#targetBytesPerSecond);
		// Commit before delivery. A consumer may apply the update and then throw or
		// reenter the producer; retaining the old baseline would duplicate that delta.
		this.#options.publish(update);
	}

	dispose(): void {
		if (this.#timer !== undefined) clearTimeout(this.#timer);
		this.#timer = undefined;
		this.#disposed = true;
	}

	#armTimer(wait: number): void {
		if (this.#timer !== undefined) return;
		this.#timer = setTimeout(() => {
			this.#timer = undefined;
			try {
				this.flush();
			} catch (error) {
				this.#options.onError(error);
			}
		}, wait);
	}
}

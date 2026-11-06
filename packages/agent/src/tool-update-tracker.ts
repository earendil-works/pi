/**
 * Bounds in-flight progress notifications. Progress is replaceable: if a tool
 * produces updates faster than they can be delivered, preserve its latest state,
 * not every intermediate snapshot. Tools that await onUpdate() receive a shared
 * backpressure promise while the pipeline is saturated.
 *
 * A rejected notification is surfaced immediately by drain(), even if another
 * notification will never settle.
 */
export class ToolUpdateTracker {
	readonly #pending = new Set<Promise<void>>();
	readonly #changed = new Set<() => void>();
	#latest: (() => void | Promise<void>) | undefined;
	#firstFailure: { error: unknown } | undefined;
	#capacityPromise: Promise<void> | undefined;
	#releaseCapacity: (() => void) | undefined;

	constructor(readonly maxPending = 16) {
		if (!Number.isSafeInteger(maxPending) || maxPending < 1) {
			throw new RangeError("maxPending must be a positive integer");
		}
	}

	/** Schedule a partial update. When saturated, only the newest unsent update remains. */
	track(update: () => void | Promise<void>): Promise<void> | void {
		if (this.#firstFailure) return;
		if (this.#pending.size >= this.maxPending) {
			this.#latest = update;
			if (!this.#capacityPromise) {
				this.#capacityPromise = new Promise<void>((resolve) => {
					this.#releaseCapacity = resolve;
				});
			}
			return this.#capacityPromise;
		}
		return this.#start(update);
	}

	#start(update: () => void | Promise<void>): Promise<void> {
		let work: Promise<void>;
		try {
			work = Promise.resolve(update());
		} catch (error) {
			this.#fail(error);
			return Promise.resolve();
		}
		let tracked!: Promise<void>;
		tracked = work.then(
			() => {
				this.#pending.delete(tracked);
				this.#settled();
			},
			(error: unknown) => {
				this.#pending.delete(tracked);
				this.#fail(error);
				this.#settled();
			},
		);
		this.#pending.add(tracked);
		return tracked;
	}

	#fail(error: unknown): void {
		this.#firstFailure ??= { error };
		this.#latest = undefined;
		// A tool awaiting progress capacity must not hang after its subscriber
		// fails; drain() will surface the original failure.
		this.#releaseCapacity?.();
		this.#capacityPromise = undefined;
		this.#releaseCapacity = undefined;
		this.#notify();
	}

	#settled(): void {
		if (!this.#firstFailure && this.#latest && this.#pending.size < this.maxPending) {
			const latest = this.#latest;
			this.#latest = undefined;
			this.#start(latest);
		}
		if (this.#pending.size < this.maxPending) {
			this.#releaseCapacity?.();
			this.#capacityPromise = undefined;
			this.#releaseCapacity = undefined;
		}
		this.#notify();
	}

	#notify(): void {
		for (const changed of this.#changed) changed();
		this.#changed.clear();
	}

	/** Wait for delivery, or fail promptly instead of awaiting unrelated hung updates. */
	async drain(): Promise<void> {
		while (this.#pending.size > 0 || this.#latest) {
			if (this.#firstFailure) throw this.#firstFailure.error;
			await new Promise<void>((resolve) => this.#changed.add(resolve));
		}
		if (this.#firstFailure) throw this.#firstFailure.error;
	}

	get pendingCount(): number {
		return this.#pending.size;
	}
}

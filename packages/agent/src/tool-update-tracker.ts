/**
 * Keeps only unresolved tool-update promises, rather than retaining every update
 * emitted during a potentially long-running tool invocation.
 *
 * Rejections are observed immediately (no unhandled-rejection window), then
 * reported when the caller drains the remaining updates.
 */
export class ToolUpdateTracker {
	readonly #pending = new Set<Promise<void>>();
	#firstFailure: { error: unknown } | undefined;

	track(update: void | Promise<void>): void {
		let settled!: Promise<void>;
		settled = Promise.resolve(update).then(
			() => {
				this.#pending.delete(settled);
			},
			(error: unknown) => {
				this.#firstFailure ??= { error };
				this.#pending.delete(settled);
			},
		);
		this.#pending.add(settled);
	}

	async drain(): Promise<void> {
		while (this.#pending.size > 0) await Promise.all(this.#pending);
		if (this.#firstFailure) throw this.#firstFailure.error;
	}

	get pendingCount(): number {
		return this.#pending.size;
	}
}

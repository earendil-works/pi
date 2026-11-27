// The seal fence (slice 6a §1.3): the token an attempt, a job run's invocation or the object itself hands its
// transactions. Once sealed, new transactions under it are refused `released` and the open one is discarded.

/** One seal token; sealed once, never unsealed. */
export class SealToken {
	#sealed = false;
	/**
	 * The abort reasons its owner ended its own work with (an attempt's end or failure, a reload stopping its routines),
	 * made by the first: at most two per token.
	 */
	#endings: unknown[] | undefined;

	/** Whether work under this token is refused. */
	get sealed(): boolean {
		return this.#sealed;
	}

	/** Seals the token; `Documents.fence` also discards the transaction it holds open. */
	seal(): void {
		this.#sealed = true;
	}

	/** Its owner ends the work under it with `reason`, the abort reason of the contexts it ends (sealing may follow). */
	end(reason: unknown): void {
		this.#endings ??= [];
		this.#endings.push(reason);
	}

	/**
	 * Whether `reason` is one its owner ended its work with: a transaction its context's abort cancelled for it is the
	 * object's own end (ERNDL-1190), not a change a caller lost.
	 */
	endedBy(reason: unknown): boolean {
		return this.#endings?.includes(reason) === true;
	}
}

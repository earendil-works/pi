// The seal fence (slice 6a §1.3): the token an attempt, a job run's invocation or the object itself hands its
// transactions. Once sealed, new transactions under it are refused `released` and the open one is discarded.

/** One seal token; sealed once, never unsealed. */
export class SealToken {
	#sealed = false;

	/** Whether work under this token is refused. */
	get sealed(): boolean {
		return this.#sealed;
	}

	/** Seals the token; `Documents.fence` also discards the transaction it holds open. */
	seal(): void {
		this.#sealed = true;
	}
}

// The seal fence (slice 6a §1.3): the token an attempt, a job run's invocation or the object itself hands its
// transactions. Once sealed, new transactions under it are refused `released` and the open one is discarded. It
// also remembers the signals its owner aborted to end its own work: what they cancelled is not reported (ERNDL-1190).

/** One seal token; sealed once, never unsealed. */
export class SealToken {
	#sealed = false;
	/**
	 * The signals its owner aborted to end its own work (an attempt's openers and calls, its routines, its job runs cut
	 * off), made by the first: a context whose abort came from one of them was ended by the owner's end.
	 */
	#ends: AbortSignal[] | undefined;

	/** Whether work under this token is refused. */
	get sealed(): boolean {
		return this.#sealed;
	}

	/** Seals the token; `Documents.fence` also discards the transaction it holds open. */
	seal(): void {
		this.#sealed = true;
	}

	/** Remembers that its owner aborts `signal` to end its own work; called before the abort. */
	endsWith(signal: AbortSignal): void {
		this.#ends ??= [];
		this.#ends.push(signal);
	}

	/** Whether `origin` (an abort's first source, `abortOrigin`) is a signal its owner aborted to end its own work. */
	endedBy(origin: AbortSignal): boolean {
		return this.#ends?.includes(origin) === true;
	}
}

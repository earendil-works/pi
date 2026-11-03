import type { CommitObservation, CommitPublication, Harness } from "@earendil-works/pi-durable";

/** Wakes a catch-up task after relevant commits. Subscribe before its initial scan to avoid missing a race. */
export class CommitSignal {
	version = 0;
	readonly #waiters = new Set<() => void>();
	readonly #observation: CommitObservation;

	constructor(harness: Harness, accepts: (publication: CommitPublication) => boolean) {
		this.#observation = harness.observeCommits({
			advance: (publication) => {
				if (!accepts(publication)) return;
				this.version++;
				for (const wake of [...this.#waiters]) wake();
			},
			// The Session closed or failed: its owner (the worker's Harness) ends with it.
			end: () => {},
		});
	}

	next(seen: number, signal: AbortSignal): Promise<void> {
		return new Promise((resolve, reject) => {
			if (signal.aborted) return reject(signal.reason);
			if (this.version !== seen) return resolve();
			const done = (): void => {
				this.#waiters.delete(wake);
				signal.removeEventListener("abort", abort);
			};
			const wake = (): void => {
				done();
				resolve();
			};
			const abort = (): void => {
				done();
				reject(signal.reason);
			};
			this.#waiters.add(wake);
			signal.addEventListener("abort", abort, { once: true });
		});
	}

	close(): void {
		this.#observation.detach();
	}
}

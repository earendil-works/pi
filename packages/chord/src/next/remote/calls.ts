// The call window (§3, decision log "Flow control: an ack-clocked window"): at most the peer's N calls in flight on a
// link from this host; further calls wait in one FIFO queue, sent in order as replies free slots.

/** A call waiting for a slot: its hold (a rebind or release takes it out) and what sends it. */
export type QueuedCall = { readonly hold: number; readonly send: () => void };

/**
 * The calls of one link's consumer side. `limit` is the peer's N from its `hello` (0 before it, so every call waits).
 * A relay forwards its downstream calls at once, so only this host's own calls are counted here.
 */
export class CallWindow<C extends QueuedCall = QueuedCall> {
	#limit = 0;
	#inFlight = 0;
	readonly #waiting = new Set<C>();

	/** Sends `call` now when a slot is free and nothing waits, otherwise queues it behind the earlier calls. */
	submit(call: C): void {
		if (this.#waiting.size === 0 && this.#inFlight < this.#limit) {
			this.#inFlight++;
			call.send();
			return;
		}
		this.#waiting.add(call);
	}

	/** The peer's window arrived with its `hello`: waiting calls go out. */
	opened(limit: number): void {
		this.#limit = limit;
		this.#drain();
	}

	/** A call in flight ended (its reply, its abort sent, its hold released or gone): its slot is free. */
	freed(): void {
		this.#inFlight--;
		this.#drain();
	}

	/** Takes a waiting call out (its caller cancelled); nothing happens for one that is not waiting. */
	remove(call: C): void {
		this.#waiting.delete(call);
	}

	/** Takes every waiting call of `hold` out and returns them (its hold rebinds or was released). */
	removeHold(hold: number): C[] {
		const removed: C[] = [];
		for (const call of this.#waiting) {
			if (call.hold !== hold) continue;
			this.#waiting.delete(call);
			removed.push(call);
		}
		return removed;
	}

	/** Takes every waiting call out and returns them (the link closed). */
	clear(): C[] {
		const removed = [...this.#waiting];
		this.#waiting.clear();
		return removed;
	}

	/** Sends waiting calls in order while slots are free. */
	#drain(): void {
		for (const call of this.#waiting) {
			if (this.#inFlight >= this.#limit) return;
			this.#waiting.delete(call);
			this.#inFlight++;
			call.send();
		}
	}
}

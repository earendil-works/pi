// The call window (§3, decision log "Flow control: an ack-clocked window"; decision "Call windows only for untrusted
// links"): at most the peer's N calls of one origin in flight on a link; further calls wait in one FIFO queue, sent in
// order as replies free slots. A peer that announced no window takes every call at once.

/** A call waiting for a slot: its hold (a rebind or release takes it out) and what sends it. */
export type QueuedCall<H = number> = { readonly hold: H; readonly send: () => void };

/**
 * The calls of one origin on one link: a link's consumer side for this host's own calls, or a relay's queue of one
 * downstream origin's calls towards one upstream link. `opened` sets the peer's N from its `hello`; before it every
 * call waits, and a peer that announced none (a trusted link) gets every call at once.
 */
export class CallWindow<C extends QueuedCall<unknown> = QueuedCall> {
	/** The peer's N: 0 until its `hello` arrived ("no hello yet"), `Infinity` when it announced no window. */
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

	/** The peer's window arrived with its `hello` (`undefined`: none announced): waiting calls go out. */
	opened(limit: number | undefined): void {
		this.#limit = limit ?? Infinity;
		this.#drain();
	}

	/**
	 * A call in flight ended (its reply, its abort sent, its hold released or gone): its slot is free. A caller taking
	 * waiting calls out at the same time takes them out first (`remove`, `removeHold`), so the slot never sends one.
	 */
	freed(): void {
		this.#inFlight--;
		this.#drain();
	}

	/** Takes a waiting call out (its caller cancelled); nothing happens for one that is not waiting. */
	remove(call: C): void {
		this.#waiting.delete(call);
	}

	/** Takes every waiting call of `hold` out and returns them (its hold rebinds or was released). */
	removeHold(hold: C["hold"]): C[] {
		return this.removeWhere((call) => call.hold === hold);
	}

	/**
	 * Takes every waiting call `matches` out and returns them, in order: one owner's calls when a reference sharing a hold
	 * releases (decision "References share one wire hold").
	 */
	removeWhere(matches: (call: C) => boolean): C[] {
		const removed: C[] = [];
		for (const call of this.#waiting) {
			if (!matches(call)) continue;
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

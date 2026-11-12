// The view kit's two outboxes (docs/rooms.md): reliable sends (`room.send`: numbered by the room, in order, each with
// its outcome) and motion (`room.emit`: events, at most `maxInFlight` unanswered, latest-only past that, dropped while
// the room is not joined). Plain classes over a target the connection attaches while its link is open.

/** How a reliable send ended. */
export type SendOutcome =
	/** The room numbered it. */
	| { readonly kind: "sent"; readonly seq: number }
	/** A newer message with its key replaced it before it left; the newer one carries the key. */
	| { readonly kind: "superseded" }
	/** The room refused it (its budget, a frame that may only watch). */
	| { readonly kind: "refused"; readonly error: string }
	/** The link closed before the answer: it may or may not have been numbered. */
	| { readonly kind: "uncertain" };

/** A message as it leaves: its key, if any, and its data as JSON text. */
export type Outgoing = { readonly key?: string; readonly data: string };

/** Where the sends of one link go: the room's `send`, and whether a call's failure was its link's. */
export type SendTarget = {
	send(messages: readonly Outgoing[]): Promise<readonly number[]>;
	/** Whether `error` came from the link (closed, the frame's room revoked with it): no refusal, the outcome unknown. */
	lost(error: unknown): boolean;
};

/** The most messages one `send` call carries (the contract's bound). */
const BATCH = 1000;

/**
 * Reliable sends: messages wait here until a target is attached, a keyed one replacing the waiting one with its key;
 * then they leave in batches, in order, without waiting for earlier answers (the link keeps the order of calls, and the
 * room numbers them in that order).
 */
export class Sends {
	#waiting: { message: Outgoing; resolve: (outcome: SendOutcome) => void }[] = [];
	#target: SendTarget | undefined;
	#scheduled = false;
	#closed = false;

	/** Sends `message`; resolves with its outcome (`uncertain` at once after `close`: nothing will send it). */
	send(message: Outgoing): Promise<SendOutcome> {
		if (this.#closed) return Promise.resolve({ kind: "uncertain" });
		return new Promise((resolve) => {
			if (message.key !== undefined) {
				const at = this.#waiting.findIndex((each) => each.message.key === message.key);
				const replaced = this.#waiting[at];
				if (replaced) {
					this.#waiting.splice(at, 1);
					replaced.resolve({ kind: "superseded" });
				}
			}
			this.#waiting.push({ message, resolve });
			this.#schedule();
		});
	}

	/** Sends what waits, and what comes, over `target`. */
	attach(target: SendTarget): void {
		this.#target = target;
		this.#schedule();
	}

	/** The link closed: messages wait until the next target. */
	detach(): void {
		this.#target = undefined;
	}

	/**
	 * The connection ended for good: what waits resolves `uncertain` (nothing will send it), as do later sends; what
	 * left resolves when its call fails with the link.
	 */
	close(): void {
		this.#closed = true;
		this.#target = undefined;
		for (const each of this.#waiting.splice(0)) each.resolve({ kind: "uncertain" });
	}

	/** Messages sent in one turn leave in one batch, after it. */
	#schedule(): void {
		if (this.#scheduled || !this.#target || !this.#waiting.length) return;
		this.#scheduled = true;
		queueMicrotask(() => {
			this.#scheduled = false;
			this.#flush();
		});
	}

	#flush(): void {
		const target = this.#target;
		if (!target) return;
		while (this.#waiting.length) {
			const batch = this.#waiting.splice(0, BATCH);
			target.send(batch.map((each) => each.message)).then(
				(seqs) => {
					for (const [index, each] of batch.entries()) each.resolve({ kind: "sent", seq: seqs[index] ?? -1 });
				},
				(error: unknown) => {
					const outcome: SendOutcome = target.lost(error)
						? { kind: "uncertain" }
						: { kind: "refused", error: error instanceof Error ? error.message : String(error) };
					for (const each of batch) each.resolve(outcome);
				},
			);
		}
	}
}

/** Where the emits of one joined room go: the room's `emit`, and the report of a failure that is not the link's. */
export type EmitTarget = {
	emit(messages: readonly Outgoing[]): Promise<unknown>;
	report(error: unknown): void;
};

/**
 * Motion: emits leave at once while the room is joined, at most `maxInFlight` unanswered; past that a keyed emit
 * replaces the waiting one with its key and an unkeyed one is dropped. Not joined: dropped. Leaving joined empties it
 * and retires its generation: answers of earlier emits change nothing, and nothing is sent again.
 */
export class Motion {
	readonly #maxInFlight: number;
	#target: EmitTarget | undefined;
	#generation = 0;
	#inFlight = 0;
	readonly #waiting = new Map<string, string>();

	constructor(maxInFlight: number) {
		this.#maxInFlight = maxInFlight;
	}

	/** Emits that are not answered yet (this generation's). */
	get inFlight(): number {
		return this.#inFlight;
	}

	/** Emits `message` (lossy: see the class). */
	emit(message: Outgoing): void {
		if (!this.#target) return;
		if (this.#inFlight < this.#maxInFlight) this.#send([message]);
		else if (message.key !== undefined) this.#waiting.set(message.key, message.data);
	}

	/** The room is joined: emits go to `target`. */
	attach(target: EmitTarget): void {
		this.#leave();
		this.#target = target;
	}

	/** The room is not joined any more. */
	detach(): void {
		this.#leave();
	}

	#leave(): void {
		this.#generation++;
		this.#target = undefined;
		this.#inFlight = 0;
		this.#waiting.clear();
	}

	#send(messages: readonly Outgoing[]): void {
		const target = this.#target;
		if (!target) return;
		const generation = this.#generation;
		this.#inFlight++;
		void target
			.emit(messages)
			.catch((error: unknown) => target.report(error))
			.finally(() => {
				if (generation !== this.#generation) return;
				this.#inFlight--;
				if (!this.#waiting.size) return;
				// The newest of each key waited: they leave together, as one emit.
				const waiting = [...this.#waiting].map(([key, data]) => ({ key, data }));
				this.#waiting.clear();
				this.#send(waiting);
			});
	}
}

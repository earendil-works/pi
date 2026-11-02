// Parked calls (§3, §7): calls made on a loading reference, queued in the order they were made until it goes live,
// each with its own deadline from the moment it was called (the reference's `readyTimeout`, never renewed).

import type { Context } from "../../context/index.ts";
import { ChordError } from "../data/index.ts";

/** One queued call: what to send, how its caller is settled, its deadline (`Date.now()` time) and what ends its wait. */
type ParkedCall = {
	readonly method: string;
	readonly args: unknown;
	readonly context: Context;
	readonly resolve: (value: unknown) => void;
	readonly reject: (error: unknown) => void;
	readonly due: number;
	readonly deadline: ReturnType<typeof setTimeout>;
	readonly cancel: (() => void) | undefined;
};

/**
 * The queue of one reference's parked calls. A call leaves it when it is sent, at its deadline (`unavailable/
 * park_timeout`), when its caller cancels, or rejected with the queue (the reference failed or was released).
 */
export class ParkedCalls {
	/** In the order the calls were made (a `Set` keeps insertion order and deletes in constant time). */
	readonly #calls = new Set<ParkedCall>();
	readonly #timeout: number;
	readonly #label: string;

	constructor(timeout: number, label: string) {
		this.#timeout = timeout;
		this.#label = label;
	}

	/** Whether calls are queued: a new call waits behind them, also while they are being sent. */
	get waiting(): boolean {
		return this.#calls.size > 0;
	}

	/** Queues a call; settles as the call it becomes once sent, or with why it left the queue. */
	park(method: string, args: unknown, context: Context): Promise<unknown> {
		const signal = context.abortSignal;
		signal?.throwIfAborted();
		const { promise, resolve, reject } = Promise.withResolvers<unknown>();
		const deadline = setTimeout(() => this.#expire(call), this.#timeout);
		let cancel: (() => void) | undefined;
		if (signal !== undefined) {
			cancel = () => {
				this.#take(call);
				reject(signal.reason);
			};
			signal.addEventListener("abort", cancel, { once: true });
		}
		const due = Date.now() + this.#timeout;
		const call: ParkedCall = { method, args, context, resolve, reject, due, deadline, cancel };
		this.#calls.add(call);
		return promise;
	}

	/**
	 * Sends the queued calls in order through `send`, each only while `live()` still holds: sending one runs code
	 * (a handler's synchronous part) that may release or drop the reference, and the rest then stays queued or is
	 * rejected by that; or that makes a new call, which is queued behind the rest and sent in this loop. A call whose
	 * deadline passed while earlier ones ran (their timers could not fire) is rejected instead of sent.
	 */
	flush(send: (method: string, args: unknown, context: Context) => Promise<unknown>, live: () => boolean): void {
		for (const call of this.#calls) {
			if (!live()) return;
			if (Date.now() >= call.due) {
				this.#expire(call);
				continue;
			}
			this.#take(call);
			send(call.method, call.args, call.context).then(call.resolve, call.reject);
		}
	}

	/** Rejects every queued call with `error`. */
	reject(error: unknown): void {
		for (const call of this.#calls) {
			this.#take(call);
			call.reject(error);
		}
	}

	/** `call`'s deadline passed: `unavailable/park_timeout`. */
	#expire(call: ParkedCall): void {
		this.#take(call);
		const message = `${this.#label}: a call waited ${this.#timeout} ms for its reference to go live`;
		call.reject(new ChordError({ code: "unavailable", reason: "park_timeout", message }));
	}

	/** Takes `call` out of the queue: its deadline and cancellation stop. */
	#take(call: ParkedCall): void {
		this.#calls.delete(call);
		clearTimeout(call.deadline);
		if (call.cancel !== undefined) call.context.abortSignal?.removeEventListener("abort", call.cancel);
	}
}

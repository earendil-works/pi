// Links (§3): an ordered, bidirectional channel of messages between two hosts, and the in-memory pair.

/** An ordered, bidirectional channel of `Uint8Array` messages between two hosts. Adapters only move bytes. */
export interface Link {
	/** Sends one message; a no-op once closed. */
	send(message: Uint8Array): void;
	/**
	 * Sets the one listener for incoming messages; messages that arrived earlier are delivered to it first. On a closed
	 * link it is not kept.
	 */
	onMessage(listener: (message: Uint8Array) => void): void;
	/** Closes both ends; messages not delivered yet are dropped. */
	close(): void;
	/** Sets the one listener for the close of either end; it runs at once when the link is closed already. */
	onClose(listener: () => void): void;
}

/** Two ends of one link: what one sends, the other receives asynchronously (a microtask later), in order. */
export function memoryLinkPair(): [Link, Link] {
	const a = new MemoryLink();
	const b = new MemoryLink();
	a.peer = b;
	b.peer = a;
	return [a, b];
}

/**
 * What every link end shares: the one message listener (messages that arrived before it are queued for it), the one
 * close listener, and closing once. Subclasses move the bytes: `deliver` what arrived, `ended` when the transport
 * closed, and implement `send` and `close`.
 */
export abstract class LinkEnd implements Link {
	#closed = false;
	#listener: ((message: Uint8Array) => void) | undefined;
	/** Messages that arrived before the listener was set. */
	#queued: Uint8Array[] = [];
	#closeListener: (() => void) | undefined;

	abstract send(message: Uint8Array): void;

	abstract close(): void;

	get closed(): boolean {
		return this.#closed;
	}

	onMessage(listener: (message: Uint8Array) => void): void {
		// A closed end delivers nothing: keeping the listener would keep its owner.
		if (this.#closed) return;
		this.#listener = listener;
		// A listener may close the link: what is still queued then is dropped.
		for (const message of this.#queued.splice(0)) {
			if (this.#closed) return;
			listener(message);
		}
	}

	onClose(listener: () => void): void {
		if (this.#closed) listener();
		else this.#closeListener = listener;
	}

	/** A message arrived; dropped once closed. */
	protected deliver(message: Uint8Array): void {
		if (this.#closed) return;
		if (this.#listener === undefined) this.#queued.push(message);
		else this.#listener(message);
	}

	/** Closes this end (once): nothing is delivered any more, and nothing the listeners reach is kept. */
	protected ended(): void {
		if (this.#closed) return;
		this.#closed = true;
		const listener = this.#closeListener;
		this.#listener = undefined;
		this.#closeListener = undefined;
		this.#queued = [];
		listener?.();
	}
}

/**
 * One end of a memory link. Closing it closes this end at once and the peer a microtask later, as a transport would.
 * Portable: `queueMicrotask` only.
 */
class MemoryLink extends LinkEnd {
	peer: MemoryLink | undefined;

	send(message: Uint8Array): void {
		if (this.closed) return;
		const peer = this.peer!;
		queueMicrotask(() => peer.deliver(message));
	}

	close(): void {
		if (this.closed) return;
		const peer = this.peer!;
		this.#end();
		queueMicrotask(() => peer.#end());
	}

	#end(): void {
		this.peer = undefined;
		this.ended();
	}
}

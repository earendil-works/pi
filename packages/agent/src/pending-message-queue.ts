import type { QueueMode } from "./types.ts";

/**
 * FIFO message queue that avoids copying the entire remainder of the queue
 * when draining one message at a time. Periodic compaction amortizes memory.
 */
export class PendingMessageQueue<T> {
	#messages: T[] = [];
	#head = 0;
	mode: QueueMode;

	constructor(mode: QueueMode) {
		this.mode = mode;
	}

	enqueue(message: T): void {
		this.#messages.push(message);
	}

	hasItems(): boolean {
		return this.#head < this.#messages.length;
	}

	peek(): T[] {
		if (this.mode === "all") return this.#messages.slice(this.#head);
		return this.hasItems() ? [this.#messages[this.#head]!] : [];
	}

	drain(): T[] {
		if (!this.hasItems()) return [];
		if (this.mode === "all") {
			const drained = this.#messages.slice(this.#head);
			this.clear();
			return drained;
		}
		const first = this.#messages[this.#head]!;
		this.#messages[this.#head++] = undefined as T;
		if (this.#head >= 256 && this.#head * 2 >= this.#messages.length) {
			this.#messages = this.#messages.slice(this.#head);
			this.#head = 0;
		}
		return [first];
	}

	clear(): void {
		this.#messages = [];
		this.#head = 0;
	}
}

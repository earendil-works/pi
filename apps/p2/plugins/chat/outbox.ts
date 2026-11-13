/**
 * Messages sent from the composer, until the server has them: sending never waits for the connection. A message shows
 * at once as it will look (`Outgoing.item`), and the outbox sends its messages in order whenever a sender is connected
 * (the conversation's view is open and its chat object live), each with its own request ID: a retried send is admitted
 * once, so a send whose answer was lost to a broken connection is simply sent again. A message the server refuses goes
 * back to the composer (`Sender.restore`); one it accepted stays shown until the transcript shows it (`shown`).
 *
 * One outbox per conversation, kept for the page's lifetime: switching conversations keeps unsent messages, and they
 * go out once their conversation is open again.
 */
import type { Item, PickedFile, ReplyTarget } from "@p2/app/v1/web";

export type Outgoing = {
	/** The request ID: a retry of this message is admitted once. */
	readonly id: string;
	readonly text: string;
	readonly files: readonly PickedFile[];
	readonly whenBusy: "steer" | "followUp";
	readonly replyTo?: ReplyTarget;
	/** The message as the transcript will show it (a person's message), shown until it does. */
	readonly item: Extract<Item, { type: "user" }>;
	/** Accepted: its submission (a queued input's ID), and the conversation's newest entry before it. */
	readonly sent?: { readonly submissionId: number; readonly after: number };
};

/** How an open conversation sends: the server's call, and what to do with a refused message. */
export type Sender = {
	/** Sends `message` (uploads, expansion, the call); resolves with what the server accepted. */
	send(message: Outgoing): Promise<NonNullable<Outgoing["sent"]>>;
	/** Whether `error` refuses the message for good (not allowed, invalid); anything else is retried. */
	refused(error: unknown): boolean;
	/** Puts a refused message back into the composer, saying why. */
	restore(message: Outgoing, error: unknown): void;
};

/** How long an accepted message stays shown when the transcript does not show it (it may never: a dropped steer). */
const SHOWN_AT_MOST = 10_000;
const RETRY_MIN = 500;
const RETRY_MAX = 10_000;
/** The wait before retry `attempt` (from 0): doubling from half a second, at most ten seconds. */
export const retryDelay = (attempt: number): number => Math.min(RETRY_MAX, RETRY_MIN * 2 ** attempt);
/**
 * Failed tries while connected after which a message goes back to the composer (about half a minute): an error that
 * keeps coming back is not the connection. A reconnect starts the count again.
 */
export const GIVE_UP = 6;

export class Outbox {
	readonly #retryDelay: (attempt: number) => number;
	readonly #shownAtMost: number;
	#messages: readonly Outgoing[] = [];
	readonly #listeners = new Set<() => void>();
	#sender: Sender | undefined;
	#running = false;
	/** The message being sent now: the server may already have it. */
	#inFlight: string | undefined;
	#attempt = 0;
	#retry: ReturnType<typeof setTimeout> | undefined;

	/** Timings: the wait before retry `attempt` (from 0), and how long an accepted message stays shown at most. */
	constructor(timing: { retryDelay?: (attempt: number) => number; shownAtMost?: number } = {}) {
		this.#retryDelay = timing.retryDelay ?? retryDelay;
		this.#shownAtMost = timing.shownAtMost ?? SHOWN_AT_MOST;
	}

	subscribe = (listener: () => void): (() => void) => {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	};
	snapshot = (): readonly Outgoing[] => this.#messages;

	/** Queues `message` and sends it as soon as a sender is connected. */
	add(message: Outgoing): void {
		this.#set([...this.#messages, message]);
		void this.#run();
	}

	/** Takes back `id` if it is not sent (nor being sent): the queued chip's "move back to editor". */
	take(id: string): Outgoing | undefined {
		const message = this.#messages.find((candidate) => candidate.id === id);
		if (!message || message.sent || message.id === this.#inFlight) return undefined;
		this.remove(id);
		return message;
	}

	/** Drops `id`, sent or not. */
	remove(id: string): void {
		this.#set(this.#messages.filter((message) => message.id !== id));
	}

	/**
	 * Takes back the messages not sent yet (Stop puts them into the composer, as the server's queued inputs). Not the
	 * one being sent: the server may have it already, and Stop's own answer returns it if so.
	 */
	takeUnsent(): Outgoing[] {
		const taken = (message: Outgoing) => !message.sent && message.id !== this.#inFlight;
		const unsent = this.#messages.filter(taken);
		if (unsent.length) this.#set(this.#messages.filter((message) => !taken(message)));
		return unsent;
	}

	/** How to send now, or undefined while sending cannot work (offline, the chat object not live). */
	connect(sender: Sender | undefined): void {
		this.#sender = sender;
		if (sender) {
			this.#attempt = 0;
			void this.#run();
		}
	}

	/** Drops accepted messages that `shown` says the transcript shows now. */
	settle(shown: (message: Outgoing) => boolean): void {
		const kept = this.#messages.filter((message) => !message.sent || !shown(message));
		if (kept.length !== this.#messages.length) this.#set(kept);
	}

	#set(messages: readonly Outgoing[]): void {
		this.#messages = messages;
		for (const listener of [...this.#listeners]) listener();
	}

	/** Sends the unsent messages in order, one at a time; a failure that is not a refusal waits and tries again. */
	async #run(): Promise<void> {
		if (this.#running) return;
		this.#running = true;
		clearTimeout(this.#retry);
		try {
			for (;;) {
				const sender = this.#sender;
				const next = this.#messages.find((message) => !message.sent);
				if (!sender || !next) return;
				this.#inFlight = next.id;
				try {
					const sent = await sender.send(next);
					this.#attempt = 0;
					// Removed meanwhile (its chip's ×): the server has it now and shows it.
					if (this.#messages.some((message) => message.id === next.id))
						this.#set(this.#messages.map((message) => (message.id === next.id ? { ...message, sent } : message)));
					setTimeout(() => this.remove(next.id), this.#shownAtMost);
				} catch (error) {
					if (sender.refused(error) || this.#attempt + 1 >= GIVE_UP) {
						this.#attempt = 0;
						this.remove(next.id);
						sender.restore(next, error);
						continue;
					}
					this.#retry = setTimeout(() => void this.#run(), this.#retryDelay(this.#attempt++));
					return;
				} finally {
					this.#inFlight = undefined;
				}
			}
		} finally {
			this.#running = false;
		}
	}
}

const outboxes = new Map<string, Outbox>();

/** The outbox of conversation `key` (`session#conversation`). */
export function outboxOf(key: string): Outbox {
	let outbox = outboxes.get(key);
	if (!outbox) {
		outbox = new Outbox();
		outboxes.set(key, outbox);
	}
	return outbox;
}

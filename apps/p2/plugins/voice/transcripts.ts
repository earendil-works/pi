// What voice mode heard and has yet to deliver: each final transcript waits here until the conversation accepted it.
// Sends go one at a time in the order spoken; a send that fails because the link is down (the reference is gone, a
// ping timeout) is kept and tried again, through whatever reference the conversation has by then. Each transcript keeps
// its request ID across attempts, so one the server already admitted is not placed twice.
import { isChordError } from "@p2/app/v1";
import { DEFAULT_AGENT_NAME, mentionsAgent, spokenMention } from "../chat-mode/contract.ts";

/** Where transcripts go: the conversation's current reference. */
export type TranscriptTarget = {
	send(text: string, requestId: string): Promise<unknown>;
	/** Aborts the run; inputs still queued are withdrawn, and the caller's own come back as text. */
	stop(): Promise<{ readonly restored: readonly string[] }>;
};

export type TranscriptOptions = {
	/** The conversation's reference now; undefined while there is none. */
	target: () => TranscriptTarget | undefined;
	/** Whether the agent works now (its run is stopped before each new message that interrupts it). */
	busy: () => boolean;
	log: (message: string) => void;
	/** A transcript is lost (refused, or too many waiting). */
	onError: (message: string) => void;
	onChange: () => void;
	/** At most this many wait; beyond, the oldest not being sent is dropped. */
	limit?: number;
	/** After a failed attempt, the next one (unless `flush()` comes first, as after a new reference). */
	retryMs?: number;
	/** How long withdrawn messages wait for the next one before they are sent alone (`carry`). */
	carryMs?: number;
	/** A send that has not settled by then counts as waiting for the link (it still completes or fails). */
	slowMs?: number;
};

type Pending = { text: string; requestId: string; attempted: boolean; interrupts: boolean };

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * What a transcript becomes as a message. With chat mode on, people talk with each other and Pi answers only when
 * addressed: "Pi, …" becomes an `@pi` mention, and only a mention interrupts Pi (its speech and its run). Without chat
 * mode every message is for Pi.
 */
export function voiceMessage(
	text: string,
	chatMode: boolean,
	name = DEFAULT_AGENT_NAME,
): { text: string; interrupts: boolean } {
	if (!chatMode) return { text, interrupts: true };
	const message = spokenMention(text, name);
	return { text: message, interrupts: mentionsAgent(message, name) };
}

/** A failure of the link rather than of the message: worth another attempt. */
export function isTransient(error: unknown): boolean {
	if (!isChordError(error)) return true;
	return ["unavailable", "gone", "released", "not_ready", "superseded", "aborted"].includes(error.code);
}

export class PendingTranscripts {
	readonly #options: TranscriptOptions;
	readonly #items: Pending[] = [];
	#flushing: Promise<void> | undefined;
	#again = false;
	#retry: ReturnType<typeof setTimeout> | undefined;
	#waiting = false;
	readonly #carried: string[] = [];
	#carryTimer: ReturnType<typeof setTimeout> | undefined;
	/** A stop in flight (`stopping`): sends wait for it, so a message is not withdrawn by the stop meant for its run. */
	#stop: Promise<void> | undefined;

	constructor(options: TranscriptOptions) {
		this.#options = options;
	}

	get size(): number {
		return this.#items.length;
	}

	/** Transcripts held back by the link (none while the link works and sends simply take a moment). */
	get waiting(): number {
		return this.#waiting ? this.#items.length : 0;
	}

	/**
	 * Messages of this person that a stop withdrew (a barge-in's): they go with the next message, or on their own after
	 * a few seconds without one.
	 */
	carry(texts: readonly string[]): void {
		const kept = texts.filter((text) => text.trim());
		if (kept.length === 0) return;
		this.#carried.push(...kept);
		clearTimeout(this.#carryTimer);
		this.#carryTimer = setTimeout(() => {
			const alone = this.#carried.splice(0);
			if (alone.length > 0) this.push(alone.join("\n\n"), false);
		}, this.#options.carryMs ?? 10_000);
	}

	/**
	 * The run is being stopped (the speaker's words interrupted it): sends wait until the stop settled, and this
	 * person's messages it withdrew go with the next message.
	 */
	stopping(stop: Promise<{ readonly restored: readonly string[] }>): void {
		const settled = stop
			.then(({ restored }) => {
				if (restored.length > 0) this.#options.log(`stopped; ${restored.length} queued message(s) kept`);
				this.carry(restored);
			})
			.catch((error: unknown) => this.#options.log(`stop failed: ${messageOf(error)}`))
			.finally(() => {
				if (this.#stop === settled) this.#stop = undefined;
			});
		this.#stop = settled;
	}

	/** Queues `text`; one that `interrupts` stops a busy run before it is sent (`voiceMessage`). */
	push(text: string, interrupts = true): void {
		if (this.#carried.length > 0) {
			clearTimeout(this.#carryTimer);
			text = [...this.#carried.splice(0), text].join("\n\n");
		}
		const limit = this.#options.limit ?? 10;
		if (this.#items.length >= limit) {
			// The one being sent may already be placed; the next oldest goes.
			const dropAt = this.#items.length > 1 ? 1 : 0;
			this.#items.splice(dropAt, 1);
			this.#options.onError("Too many messages waiting; dropped one");
		}
		this.#items.push({ text, requestId: crypto.randomUUID(), attempted: false, interrupts });
		this.#options.log(`transcript queued (${this.#items.length} waiting)`);
		void this.flush();
	}

	/** Sends what waits, in order; one flush at a time (a call during one makes it go round again). */
	flush(): Promise<void> {
		clearTimeout(this.#retry);
		this.#retry = undefined;
		if (this.#flushing) {
			this.#again = true;
			return this.#flushing;
		}
		this.#flushing = this.#run().finally(() => {
			this.#flushing = undefined;
			this.#options.onChange();
		});
		return this.#flushing;
	}

	clear(): void {
		clearTimeout(this.#retry);
		clearTimeout(this.#carryTimer);
		this.#carried.length = 0;
		this.#retry = undefined;
		if (this.#items.length > 0) this.#options.log(`${this.#items.length} transcripts dropped (voice mode off)`);
		this.#items.length = 0;
		this.#waiting = false;
	}

	async #run(): Promise<void> {
		const { target, busy, log, onError, onChange } = this.#options;
		do {
			this.#again = false;
			for (let item = this.#items[0]; item; item = this.#items[0]) {
				// A stop in flight first: a message sent meanwhile would be withdrawn by it.
				if (this.#stop) await this.#stop;
				if (!item.attempted && this.#carried.length > 0) {
					clearTimeout(this.#carryTimer);
					item.text = [...this.#carried.splice(0), item.text].join("\n\n");
				}
				const chat = target();
				if (!chat) {
					this.#setWaiting(true);
					log(`waiting for the conversation (${this.#items.length} transcripts)`);
					return;
				}
				// As typing and pressing Stop: a message for Pi while it works stops that run first (a retry does not stop
				// again: its first attempt may have been placed).
				const stopFirst = item.interrupts && !item.attempted && busy();
				const retry = item.attempted;
				item.attempted = true;
				log(`send${retry ? " (again)" : ""}${stopFirst ? " (stopping the run first)" : ""}`);
				const slow = setTimeout(() => {
					log("send is slow; waiting for the link");
					this.#setWaiting(true);
				}, this.#options.slowMs ?? 5000);
				try {
					if (stopFirst) {
						const stopped = await chat.stop().catch((error: unknown) => {
							log(`stop before send failed: ${messageOf(error)}`);
							return undefined;
						});
						// This person's messages still queued were withdrawn by the stop: they go with this one, not lost.
						const restored = stopped?.restored.filter((text) => text.trim()) ?? [];
						if (restored.length > 0) {
							item.text = [...restored, item.text].join("\n\n");
							log(`stopped; ${restored.length} queued message(s) of yours go with this one`);
						} else log("stopped");
					}
					await chat.send(item.text, item.requestId);
					const at = this.#items.indexOf(item);
					if (at >= 0) this.#items.splice(at, 1);
					this.#setWaiting(false);
					log(`sent (${this.#items.length} waiting)`);
				} catch (error) {
					if (isTransient(error)) {
						log(`send failed, kept for another try: ${messageOf(error)}`);
						this.#setWaiting(true);
						// A new reference arrived meanwhile: try it at once.
						if (this.#again) {
							this.#again = false;
							continue;
						}
						this.#retry = setTimeout(() => void this.flush(), this.#options.retryMs ?? 3000);
						return;
					}
					const at = this.#items.indexOf(item);
					if (at >= 0) this.#items.splice(at, 1);
					onError(`Send failed: ${messageOf(error)}`);
				} finally {
					clearTimeout(slow);
					onChange();
				}
			}
		} while (this.#again);
	}

	#setWaiting(waiting: boolean): void {
		if (this.#waiting === waiting) return;
		this.#waiting = waiting;
		this.#options.onChange();
	}
}

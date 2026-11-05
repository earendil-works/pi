/**
 * A new session's first messages, before the session exists: Send on the new-session screen shows them at once, as
 * sending in a conversation does (outbox.ts), and the session is created whenever the page is connected. Once it
 * exists, the messages move to its main conversation's outbox, which delivers them (uploads, template expansion,
 * retries), and the page opens the session.
 *
 * One start per page, kept for the page's lifetime: messages sent while the session is being created join it. A
 * creation the server refuses (a directory that does not exist, an unknown model) puts the messages back into the
 * composer; a failure of the connection is tried again, at most `GIVE_UP` times while connected. A creation whose answer
 * was lost with the connection is tried again too and may leave an empty session behind.
 */
import type { ModelChoice } from "@p2/app/v1/web";
import { GIVE_UP, type Outgoing, outboxOf, retryDelay } from "./outbox.ts";

/** Where and with which model the session starts (as chosen at the first Send), and the messages it starts with. */
export type Start = {
	readonly location: { readonly env: string | null; readonly cwd: string };
	readonly choice: ModelChoice;
	readonly messages: readonly Outgoing[];
};

/** How the connected new-session screen creates the session, and what it does with the outcome. */
export type Creator = {
	/** Creates the session; resolves with its ID. */
	create(start: Start): Promise<string>;
	/** Whether `error` refuses the creation for good; anything else is retried. */
	refused(error: unknown): boolean;
	/** The session exists and its main conversation's outbox has the messages. */
	created(session: string): void;
	/** Puts the messages of a refused creation back into the composer, saying why. */
	restore(messages: readonly Outgoing[], error: unknown): void;
};

export class SessionStart {
	readonly #retryDelay: (attempt: number) => number;
	#start: Start | undefined;
	readonly #listeners = new Set<() => void>();
	#creator: Creator | undefined;
	#running = false;
	#attempt = 0;
	#retry: ReturnType<typeof setTimeout> | undefined;

	/** Timing: the wait before retry `attempt` (from 0), as the outbox's by default. */
	constructor(timing: { retryDelay?: (attempt: number) => number } = {}) {
		this.#retryDelay = timing.retryDelay ?? retryDelay;
	}

	subscribe = (listener: () => void): (() => void) => {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	};
	snapshot = (): Start | undefined => this.#start;

	/** Adds `message`; the first one's `place` decides where and with which model the session starts. */
	add(message: Outgoing, place: Omit<Start, "messages">): void {
		this.#set(
			this.#start
				? { ...this.#start, messages: [...this.#start.messages, message] }
				: { ...place, messages: [message] },
		);
		void this.#run();
	}

	/** How to create the session now, or undefined while it cannot work (offline, the catalog not live). */
	connect(creator: Creator | undefined): void {
		this.#creator = creator;
		if (creator) {
			this.#attempt = 0;
			void this.#run();
		}
	}

	#set(start: Start | undefined): void {
		this.#start = start;
		for (const listener of [...this.#listeners]) listener();
	}

	/** Creates the session and hands the messages to its outbox; a failure that is not a refusal waits and tries again. */
	async #run(): Promise<void> {
		const creator = this.#creator;
		const start = this.#start;
		if (this.#running || !creator || !start) return;
		this.#running = true;
		clearTimeout(this.#retry);
		try {
			const session = await creator.create(start);
			this.#attempt = 0;
			// Read after the creation: messages sent meanwhile go with the first.
			const messages = this.#start?.messages ?? [];
			this.#set(undefined);
			const outbox = outboxOf(`${session}#1`);
			for (const message of messages) outbox.add(message);
			creator.created(session);
		} catch (error) {
			if (creator.refused(error) || this.#attempt + 1 >= GIVE_UP) {
				this.#attempt = 0;
				const messages = this.#start?.messages ?? [];
				this.#set(undefined);
				creator.restore(messages, error);
			} else this.#retry = setTimeout(() => void this.#run(), this.#retryDelay(this.#attempt++));
		} finally {
			this.#running = false;
		}
	}
}

/** The page's one new-session start. */
export const sessionStart = new SessionStart();

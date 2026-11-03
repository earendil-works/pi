// Ephemeral sessions (slice 13 §3, carry-over to slice 11): a pick-a-name login's sessions, in memory only, at most
// `max` (past it the oldest ends), and each ending with its client's connection: once the last Chord link
// authenticated with it closed and none opened for a grace period (a page reload, a reconnect after a drop), or when
// none opened within that period of the login.

import type { Principal } from "../../data/index.ts";

/** How long an ephemeral session lives without a link: a minute, past a reload and the reconnect loop's pauses. */
export const EPHEMERAL_GRACE_MS = 60_000;

/** One ephemeral session: its secret's hash, its principal, its open links, its end's timer while it has none. */
type Session = {
	readonly hash: string;
	readonly principal: Principal;
	links: number;
	timer: ReturnType<typeof setTimeout> | undefined;
};

/** The server's ephemeral sessions. */
export class EphemeralSessions {
	readonly #max: number;
	readonly #graceMs: number;
	/** Insertion order is age order: the first entry is the oldest. */
	readonly #sessions = new Map<string, Session>();

	constructor(max: number, graceMs = EPHEMERAL_GRACE_MS) {
		this.#max = max;
		this.#graceMs = graceMs;
	}

	/** A new session `id` (its secret's hash `hash`) for `principal`; the oldest ends past the cap. */
	issue(id: string, hash: string, principal: Principal): void {
		const session: Session = { hash, principal, links: 0, timer: undefined };
		this.#sessions.set(id, session);
		this.#waitForLink(id, session);
		for (const [oldest] of this.#sessions) {
			if (this.#sessions.size <= this.#max) break;
			this.revoke(oldest);
		}
	}

	/** Session `id`'s hash and principal, while it lives. */
	get(id: string): { readonly hash: string; readonly principal: Principal } | undefined {
		return this.#sessions.get(id);
	}

	/** Ends session `id`; whether it was one. */
	revoke(id: string): boolean {
		const session = this.#sessions.get(id);
		if (session === undefined) return false;
		clearTimeout(session.timer);
		this.#sessions.delete(id);
		return true;
	}

	/** A link authenticated with session `id` opened: what to call when it closes; `undefined` for no such session. */
	linkOpened(id: string): (() => void) | undefined {
		const session = this.#sessions.get(id);
		if (session === undefined) return undefined;
		session.links++;
		clearTimeout(session.timer);
		session.timer = undefined;
		let closed = false;
		return () => {
			if (closed) return;
			closed = true;
			session.links--;
			if (session.links === 0 && this.#sessions.get(id) === session) this.#waitForLink(id, session);
		};
	}

	/** Ends `session` unless a link opens within the grace period. */
	#waitForLink(id: string, session: Session): void {
		session.timer = setTimeout(() => {
			if (session.links === 0) this.revoke(id);
		}, this.#graceMs);
		// The server's process does not wait for it.
		session.timer.unref?.();
	}
}

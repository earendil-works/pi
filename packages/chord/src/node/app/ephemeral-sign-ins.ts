// Ephemeral sign-ins (slice 13 §3, carry-over to slice 11): a pick-a-name login's sign-ins, in memory only, at most
// `max` (past it the oldest ends), and each ending with its client's connection: once the last Chord link
// authenticated with it closed and none opened for a grace period (a page reload, a reconnect after a drop), or when
// none opened within that period of the login.

import type { Principal } from "../../data/index.ts";

/** How long an ephemeral sign-in lives without a link: a minute, past a reload and the reconnect loop's pauses. */
export const EPHEMERAL_GRACE_MS = 60_000;

/** One ephemeral sign-in: its secret's hash, its principal, its open links, its end's timer while it has none. */
type SignIn = {
	readonly hash: string;
	readonly principal: Principal;
	links: number;
	timer: ReturnType<typeof setTimeout> | undefined;
};

/** The server's ephemeral sign-ins. */
export class EphemeralSignIns {
	readonly #max: number;
	readonly #graceMs: number;
	/** Insertion order is age order: the first entry is the oldest. */
	readonly #signIns = new Map<string, SignIn>();

	constructor(max: number, graceMs = EPHEMERAL_GRACE_MS) {
		this.#max = max;
		this.#graceMs = graceMs;
	}

	/** A new sign-in `id` (its secret's hash `hash`) for `principal`; the oldest ends past the cap. */
	issue(id: string, hash: string, principal: Principal): void {
		const signIn: SignIn = { hash, principal, links: 0, timer: undefined };
		this.#signIns.set(id, signIn);
		this.#waitForLink(id, signIn);
		for (const [oldest] of this.#signIns) {
			if (this.#signIns.size <= this.#max) break;
			this.revoke(oldest);
		}
	}

	/** Sign-in `id`'s hash and principal, while it lives. */
	get(id: string): { readonly hash: string; readonly principal: Principal } | undefined {
		return this.#signIns.get(id);
	}

	/** Ends sign-in `id`; whether it was one. */
	revoke(id: string): boolean {
		const signIn = this.#signIns.get(id);
		if (signIn === undefined) return false;
		clearTimeout(signIn.timer);
		this.#signIns.delete(id);
		return true;
	}

	/** A link authenticated with sign-in `id` opened: what to call when it closes; `undefined` for no such sign-in. */
	linkOpened(id: string): (() => void) | undefined {
		const signIn = this.#signIns.get(id);
		if (signIn === undefined) return undefined;
		signIn.links++;
		clearTimeout(signIn.timer);
		signIn.timer = undefined;
		let closed = false;
		return () => {
			if (closed) return;
			closed = true;
			signIn.links--;
			if (signIn.links === 0 && this.#signIns.get(id) === signIn) this.#waitForLink(id, signIn);
		};
	}

	/** Ends `signIn` unless a link opens within the grace period. */
	#waitForLink(id: string, signIn: SignIn): void {
		signIn.timer = setTimeout(() => {
			if (signIn.links === 0) this.revoke(id);
		}, this.#graceMs);
		// The server's process does not wait for it.
		signIn.timer.unref?.();
	}
}

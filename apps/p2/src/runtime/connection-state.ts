// The page's link as its UI shows it (Chord's connection loop reports it through `startPage`'s `onConnection`): open or
// not, and "down" once it stayed closed longer than OFFLINE_AFTER_MS. The hooks are `useConnected` and `useOffline` in
// src/runtime/web.tsx.

/**
 * How long the link may be closed before the page says "Offline". A page back from the background (Android froze it,
 * its socket is gone) reconnects within about a second; a label flashing for that says nothing. Past 2 s the wait is
 * one the person notices, so the label explains it. A device known to be offline says so at once (`showsOffline`).
 */
export const OFFLINE_AFTER_MS = 2000;

/** The link: open or not, and whether it has been closed longer than `OFFLINE_AFTER_MS`. */
export type ConnectionState = { readonly connected: boolean; readonly down: boolean };

/** The page's link state; its listeners hear each change (a repeated report of the same state is none). */
export class ConnectionStore {
	#state: ConnectionState = { connected: false, down: false };
	/** Marks the link down; running from its close (or the page's start) until it opens or is down. */
	#downTimer: ReturnType<typeof setTimeout> | undefined;
	readonly #listeners = new Set<() => void>();

	get state(): ConnectionState {
		return this.#state;
	}

	/** The link opened or closed (the loop's `connecting` and `waiting` both closed). */
	set(connected: boolean): void {
		if (connected) {
			clearTimeout(this.#downTimer);
			this.#downTimer = undefined;
			if (!this.#state.connected) this.#publish({ connected: true, down: false });
			return;
		}
		// Armed once per close: a failed retry reports `waiting` again and must not restart the wait or re-render.
		if (this.#downTimer !== undefined || this.#state.down) return;
		if (this.#state.connected) this.#publish({ connected: false, down: false });
		this.#downTimer = setTimeout(() => {
			this.#downTimer = undefined;
			this.#publish({ connected: false, down: true });
		}, OFFLINE_AFTER_MS);
	}

	subscribe(listener: () => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	#publish(state: ConnectionState): void {
		this.#state = state;
		for (const listener of this.#listeners) listener();
	}
}

/**
 * Whether the page should say it is offline: its link down longer than `OFFLINE_AFTER_MS`, or closed while the device
 * is known to be offline (`online`: `navigator.onLine`). A link open on a device without a network (the server on the
 * same phone) is not offline.
 */
export function showsOffline(state: ConnectionState, online: boolean): boolean {
	return state.down || (!state.connected && !online);
}

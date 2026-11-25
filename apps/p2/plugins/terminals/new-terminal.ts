// A new terminal asked for from outside the terminal panel (the command menu's New terminal): one request for one
// session, page-wide, taken by that session's terminal view as soon as it shows, at once when it already does.
import { useSyncExternalStore } from "react";

let wanted: string | undefined;
const listeners = new Set<() => void>();

const subscribe = (listener: () => void) => {
	listeners.add(listener);
	return () => listeners.delete(listener);
};

function set(session: string | undefined): void {
	wanted = session;
	for (const listener of listeners) listener();
}

/** Asks `session`'s terminal view for a new terminal (replacing a request not taken yet). */
export const requestNewTerminal = (session: string): void => set(session);

const TAKE = { taken: () => set(undefined) };

/** The request for `session`'s view while there is one: the view opens the terminal, then calls `taken`. */
export function useNewTerminal(session: string | undefined): { readonly taken: () => void } | undefined {
	const requested = useSyncExternalStore(subscribe, () => session !== undefined && wanted === session);
	return requested ? TAKE : undefined;
}

// A session lives in its own worker process: `Session({ id })` is its address.

import { hostKind, int, remote, str } from "@earendil-works/chord/next";

export const Session = hostKind("session", { id: str() });

/** A session's greeting, served by the worker at the session's address. */
export const Greeting = remote("example.greeting", {
	version: 1,
	params: { id: str() },
	hostAddress: ({ id }) => Session({ id }),
	variants: { main: { state: { text: str(), pid: int() } } },
});

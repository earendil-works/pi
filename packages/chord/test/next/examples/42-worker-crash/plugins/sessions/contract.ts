// A session lives in its own worker process: `Session({ id })` is its address.

import { hostKind, int, method, remote, str } from "@earendil-works/chord/next";

export const Session = hostKind("session", { id: str() });

/** A session's process: its pid, and a way to make it crash. */
export const Process = remote("example.process", {
	version: 1,
	params: { id: str() },
	hostAddress: ({ id }) => Session({ id }),
	variants: { main: { state: { pid: int() }, methods: { crash: method() } } },
});

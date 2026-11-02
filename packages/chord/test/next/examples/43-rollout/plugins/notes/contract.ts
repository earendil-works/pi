// The notes' contracts: a label on the server, and one in each session's worker.

import { hostKind, local, remote, str } from "@earendil-works/chord/next";

export const Session = hostKind("session", { id: str() });

/** The label as the server shows it. */
export const Banner = local("example.banner", { version: 1, params: {}, members: { text: str() } });

/** The label as a session's worker shows it. */
export const Label = remote("example.label", {
	version: 1,
	params: { id: str() },
	hostAddress: ({ id }) => Session({ id }),
	variants: { main: { state: { text: str() } } },
});

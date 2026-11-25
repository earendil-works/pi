// The Familiar: one long-running session above the others, made on first use, that keeps track of the other sessions
// and starts, steers, stops and archives them through the conversations tool. Which session it is lives on the server.
// The owner sees it as "Ask Pi": the app's home and its row in the sidebar open it.
import { nul, obj, str, union } from "@earendil-works/pi-schema";
import { local, method, remote, serverHost } from "@p2/app/v1";

/** The Familiar's name for the owner: its session's title when made, its sidebar row's label. */
export const FAMILIAR_TITLE = "Ask Pi";

/** `WorkerInitValues` key: whether the starting worker's session is the Familiar (a boolean). */
export const FAMILIAR_INIT = "familiar";

const Opened = obj({ id: str() });

/**
 * Which session is the Familiar (server, host-internal; persisted): `session` is null until the first `open`, which
 * makes it (in the home directory, with the default model) or restores it when it was archived.
 */
export const FamiliarStore = local("p2.familiar-store", {
	version: 1,
	params: {},
	members: {
		session: union([str(), nul()]),
		open: method(undefined, Opened),
	},
});

/** The Familiar as the owner sees it: its session (null before the first `open`) and `open`, which makes it once. */
export const Familiar = remote("p2.familiar", {
	version: 1,
	params: {},
	hostAddress: serverHost,
	variants: {
		owner: {
			state: { session: union([str(), nul()]) },
			methods: { open: method(undefined, Opened) },
		},
	},
});

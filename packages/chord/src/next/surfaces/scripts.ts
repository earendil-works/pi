// The current plugin scripts of a client kind (slice 11 §1, decision "Slice 11, P5"): what the server's surface serves
// as a remote object every page and terminal holds. Its state is the set: the base bundle's hash, the combined file of
// every plugin script, and each plugin's script (and stylesheet); a rollout shipping the kind publishes a new set, and
// each client fetches what changed.

import { arr, hostKind, obj, opt, remote, type Static, str } from "../contracts/index.ts";

/** The server's host kind as the surfaces place their objects: the app kit's server is `Server()`. */
const Server = hostKind("server");

/** One plugin's script of the set: its name, its script's digest and URL, its stylesheet's URL when it has one. */
const ScriptEntry = obj({ name: str(), digest: str(), url: str(), css: opt(str()) });

/** One plugin's script of a set (see `ScriptEntry`). */
export type ScriptEntry = Static<typeof ScriptEntry>;

/**
 * A client kind's current scripts: `base` (the base bundle's hash: a change reloads the client), `combined` (the URL of
 * one file holding every plugin's script, what a fresh client loads), `plugins` (each one's script, in name order).
 */
export const ScriptSet = obj({ base: str(), combined: str(), plugins: arr(ScriptEntry) });

/** A client kind's current scripts (see `ScriptSet`). */
export type ScriptSet = Static<typeof ScriptSet>;

/** The current web scripts (`ScriptSet`), served by the server's web surface to any principal that may load the app. */
export const WebScripts = scriptsContract("chord.web.scripts");

/** The current terminal scripts (`ScriptSet`), served by the server's terminal surface as `WebScripts` is. */
export const TuiScripts = scriptsContract("chord.tui.scripts");

/** The contract of a client kind's current scripts, named `name`: a remote object on the server, its state the set. */
function scriptsContract<const N extends string>(name: N) {
	return remote(name, {
		version: 1,
		params: {},
		hostAddress: () => Server(),
		variants: { main: { state: { set: ScriptSet } } },
	});
}

/** The contract of a client kind's scripts, as clients hold it (`WebScripts`, `TuiScripts`). */
export type ScriptsContract = typeof WebScripts | typeof TuiScripts;

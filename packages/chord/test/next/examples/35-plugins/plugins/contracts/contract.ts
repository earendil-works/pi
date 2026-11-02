// The contracts the plugins share: a contracts-only plugin (no facet file). A plugin that imports this file gets its
// own copy built into its script; the app's code declares the same contracts (same names, versions and shapes).

import { hostKind, int, local, method, remote, str } from "@earendil-works/chord/next";

/** The worker's host kind: `Notes` lives there. */
export const Worker = hostKind("example.worker");

/** Notes on the worker: a label, a count and `add`. */
export const Notes = remote("example.notes", {
	version: 1,
	params: {},
	hostAddress: () => Worker(),
	variants: { main: { state: { label: str(), count: int() }, methods: { add: method(undefined, int()) } } },
});

/** The notes' label as the server shows it. */
export const Index = local("example.index", { version: 1, params: {}, members: { label: str() } });

/** When the clock plugin's script was evaluated: it changes only when the plugin is reloaded. */
export const Clock = local("example.clock", { version: 1, params: {}, members: { evaluatedAt: str() } });

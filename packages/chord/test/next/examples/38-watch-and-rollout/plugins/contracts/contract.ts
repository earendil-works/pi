// The contracts the plugins share (a contracts-only plugin): every plugin importing this file has a copy of it, so an
// edit here marks every one of them dirty.

import { local, str } from "@earendil-works/chord/next";

/** The label a plugin shows, one type per plugin. */
export function labelOf(plugin: string) {
	return local(`example.label.${plugin}`, { version: 1, params: {}, members: { text: str() } });
}

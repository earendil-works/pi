// Fixture plugin (slice 7c): contracts only, no facet; the other fixtures import (copy) it.

import { hostKind, int, local, method, remote, str } from "@earendil-works/chord/next";

/** The host kind of the fixtures' worker. */
export const Worker = hostKind("test.worker");

/** Notes on the worker: a label, a count and `add`. */
export const Notes = remote("test.notes", {
	version: 1,
	params: {},
	hostAddress: () => Worker(),
	variants: { main: { state: { label: str(), count: int() }, methods: { add: method(undefined, int()) } } },
});

/** The notes' label on the server. */
export const Index = local("test.index", { version: 1, params: {}, members: { label: str() } });

/** A file of a plugin read through `pluginFile`. */
export const Files = local("test.files", { version: 1, params: {}, members: { text: str() } });

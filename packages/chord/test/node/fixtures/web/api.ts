// The web API of the browser tests (`@test/app/v1/web`): the `Panels` and `Parts` registries web plugins contribute,
// the page's counter and beats, local objects of the page, and the server's desk, read or edited by admission.

import { defineRegistry, event, hostKind, int, local, method, oneOf, remote, str } from "../../../../src/index.ts";

/** Panel titles, in plugin-name order. */
export const Panels = defineRegistry<string, readonly string[]>("test.panels", { version: 1 });

/** Parts of the page: components (a function making an element), in plugin-name order. */
export const Parts = defineRegistry<() => unknown, readonly (() => unknown)[]>("test.parts", { version: 1 });

/** The page's counter. */
export const Counter = local("test.counter", {
	version: 1,
	params: {},
	members: { count: int(), increment: method() },
});

/** The page's beats: two event members (`useEvents`). */
export const Beats = local("test.beats", { version: 1, params: {}, members: { a: event(int()), b: event(int()) } });

/**
 * A desk on the server, read or edited by the caller's admitted mode: a variant each (`useVariant`). A server plugin
 * of the test serves it.
 */
export const Desk = remote("test.desk", {
	version: 1,
	params: {},
	hostAddress: () => hostKind("server")(),
	admission: oneOf("reader", "editor"),
	variants: {
		reader: { state: { text: str() } },
		editor: { state: { text: str() }, methods: { write: method(str()) } },
	},
});

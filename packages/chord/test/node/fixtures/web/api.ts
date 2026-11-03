// The web API of the browser tests (`@test/app/v1/web`): the `Panels` registry web plugins contribute and the page's
// counter, a local object of the page.

import { defineRegistry, int, local, method } from "../../../../src/index.ts";

/** Panel titles, in plugin-name order. */
export const Panels = defineRegistry<string, readonly string[]>("test.panels", { version: 1 });

/** The page's counter. */
export const Counter = local("test.counter", {
	version: 1,
	params: {},
	members: { count: int(), increment: method() },
});

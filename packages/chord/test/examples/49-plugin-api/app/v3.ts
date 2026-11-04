// Acme's API, version 3, shared by every host kind (`@acme/app/v3`): what a plugin imports from its host. It re-exports
// the part of Chord Acme supports (plugins never import Chord directly) next to Acme's own part: the `Greetings`
// registry every kind has. Examples 49 to 52 build against it; a real app keeps it in `src/api/v3/`.

import { defineRegistry } from "../../../../src/index.ts";

export {
	constant,
	defineFacet,
	defineRegistry,
	defineState,
	int,
	local,
	method,
	obj,
	str,
} from "../../../../src/index.ts";

/** Lines of greeting, one per contributing plugin; the app's start-data facet serves it (composing them in order). */
export const Greetings = defineRegistry<string, readonly string[]>("acme.greetings", { version: 1 });

/** The API's own version, for plugins that print it. */
export const API_VERSION = "v3";

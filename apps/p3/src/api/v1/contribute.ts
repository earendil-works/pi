// `contribute`: an object that only contributes. A facet's own `self.contribute` takes plain values; a contribution
// that needs a reference, a registry, a derive or a writable needs an object to declare them in. Browser-safe: the API
// module exports it.

import { type FacetHost, local, type StoreSelf } from "@earendil-works/chord";
import type { P3Principal } from "../../principals.ts";

/**
 * Serves a host-lifetime local object named `name` with no members, whose factory only calls `register(self)`: what it
 * contributes (routes, tools, renderers) is in its registries from the moment the object is live until it ends, fails
 * or restarts. A contribution that needs nothing at run time belongs to the facet's own `self.contribute` instead.
 */
export function contribute(
	host: FacetHost<P3Principal>,
	name: string,
	register: (self: StoreSelf<P3Principal>) => void,
): void {
	host.serve(local(name, { version: 1, params: {}, members: {} }), (_params, self) => {
		register(self);
		return {};
	});
}

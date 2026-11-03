// A facet's registration-only object (browser-safe).
import { local } from "@earendil-works/chord";
import type { FacetHost, StoreSelf } from "./chord.ts";

/**
 * Serves a host-lifetime local object named `name` whose factory only contributes (slots, routes, tools, renderers,
 * commands…) through `self` and exposes nothing. Its contributions come and go with the object (reload, removal).
 * Contributions that need nothing at runtime belong to the facet's own `self.contribute` instead.
 */
export function contribute(host: FacetHost, name: string, register: (self: StoreSelf) => void): void {
	host.serve(local(name, { version: 1, params: {}, members: {} }), (_params, self) => {
		register(self);
		return {};
	});
}

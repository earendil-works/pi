// The tunnel plugin: when its tunnel opens, it allows the tunnel's public host (requests through it are https); when
// it closes, it takes the host back. Its contribution is a writable, so the router follows each change.

import { defineFacet, local, method, str } from "@earendil-works/chord/next";
import { Http, type HttpContribution } from "@earendil-works/chord/next/http";

export const Tunnel = local("example.tunnel", {
	version: 1,
	params: {},
	members: { open: method(str()), close: method() },
});

export default defineFacet((host, self) => {
	self.contribute(Http, {
		routes: { "GET /hello": async (request) => ({ kind: "json", value: { origin: request.origin } }) },
	});
	host.serve(Tunnel, (_params, tunnel) => {
		const allowed = tunnel.writable<HttpContribution>({ hosts: [] });
		tunnel.contribute(Http, allowed);
		return {
			open: async (name) => {
				allowed.set({ hosts: [name] });
				return null;
			},
			close: async () => {
				allowed.set({ hosts: [] });
				return null;
			},
		};
	});
});

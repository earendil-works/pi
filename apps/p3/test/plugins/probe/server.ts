// The probe on the server: `GET /_probe/principal` answers who a request signed in as (401 for nobody: the route is
// not public), so a test asks what a cookie or a bearer token authenticates as, and sees the response's headers (a
// renewed cookie).

import { contribute, defineFacet } from "@earendil-works/p3/v1";
import { Http } from "@earendil-works/p3/v1/server";

export default defineFacet((host) => {
	contribute(host, "probe.routes", (self) => {
		self.contribute(Http, {
			routes: {
				"GET /_probe/principal": {
					handler: async (_request, ctx) => ({ kind: "json", value: ctx.principal ?? null }),
				},
			},
		});
	});
});

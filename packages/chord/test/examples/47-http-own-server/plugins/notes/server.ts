// The notes plugin's server facet: one route, the same whichever server runs it.

import { defineFacet } from "@earendil-works/chord";
import { Http } from "@earendil-works/chord/http";

export default defineFacet((_host, self) =>
	self.contribute(Http, {
		routes: {
			"GET /notes": {
				public: true,
				handler: async (request) => ({ kind: "json", value: { notes: ["buy milk"], via: request.origin } }),
			},
		},
	}),
);

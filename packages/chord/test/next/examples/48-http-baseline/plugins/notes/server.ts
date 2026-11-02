// The notes plugin's server facet: the notes page (a link from another site may open it), the notes as JSON, adding
// a note, and a webhook another site calls (cross-site: it always runs anonymous).

import { defineFacet } from "@earendil-works/chord/next";
import { Http } from "@earendil-works/chord/next/http";

const notes = ["buy milk"];

export default defineFacet((_host, self) =>
	self.contribute(Http, {
		routes: {
			"GET /": {
				page: true,
				handler: async (_request, ctx) => ({ kind: "html", body: `hi ${who(ctx.principal)}` }),
			},
			"GET /notes": async (_request, ctx) => ({ kind: "json", value: { notes, as: who(ctx.principal) } }),
			"POST /notes": async (request, ctx) => {
				if (ctx.principal === undefined) return { kind: "error", status: 401 };
				notes.push(String(await request.json()));
				return { kind: "json", value: notes };
			},
			"POST /hooks/build": {
				crossSite: true,
				handler: async (_request, ctx) => ({ kind: "json", value: who(ctx.principal) }),
			},
		},
	}),
);

/** Who a principal is, for the answers. */
function who(principal: unknown): string {
	return principal === undefined ? "anonymous" : JSON.stringify(principal);
}

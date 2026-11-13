// The notes plugin's server facet: routes reading and writing a project's notes, and its section of the home page.
// No route is public: the kit refuses anyone without a sign-in (401) before they run.

import { defineFacet, Sections } from "@notes/app/v1";
import { Http } from "@notes/app/v1/server";
import { Notes } from "./contract.ts";

export default defineFacet((_host, self) => {
	self.contribute(Sections, { title: "Notes", path: "/notes/:id" });
	self.contribute(Http, {
		routes: {
			"GET /notes/:id": async (request, ctx) => {
				const notes = await ctx.get(Notes, { id: request.params.id ?? "" });
				return { kind: "json", value: { text: notes.text.value, start: notes.start.value } };
			},
			"POST /notes/:id": async (request, ctx) => {
				const notes = await ctx.get(Notes, { id: request.params.id ?? "" });
				await notes.write(String(await request.json()), ctx);
				return { kind: "json", value: "saved" };
			},
		},
	});
});

// The home plugin's server facet: it serves the app's `Sections` registry (the provider of a core registry is a plugin
// of the app's required root, so it reloads like any plugin) and an object reading it, and `GET /` says who is signed
// in to which app (the kit's `AppInfo`, the start data every server plugin can read) with the sections plugins
// contributed.

import { AppInfo, arr, defineFacet, local, Sections, str } from "@notes/app/v1";
import { Http } from "@notes/app/v1/server";

/** The home page's data: the composed sections. */
const Home = local("notes.home", { version: 1, params: {}, members: { sections: arr(str()) } });

export default defineFacet((host, self) => {
	host.serve(Sections, { compose: (table) => table.map(({ value }) => `${value.title}: ${value.path}`) });
	host.serve(Home, (_params, home) => ({
		sections: home.derive([home.registry(Sections)], ([sections]) => sections),
	}));
	self.contribute(Http, {
		routes: {
			"GET /": async (_request, ctx) => {
				const info = await ctx.get(AppInfo, {});
				const page = await ctx.get(Home, {});
				const app = `${info.name.value} ${info.version.value}`;
				return { kind: "json", value: { app, you: ctx.principal ?? null, sections: page.sections.value } };
			},
		},
	});
});

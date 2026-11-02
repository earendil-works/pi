// The notes plugin's server facet: a page, a JSON route and a file download, contributed to the HTTP component's
// registry.

import { defineFacet } from "@earendil-works/chord/next";
import { fileResponse, Http } from "@earendil-works/chord/next/http";
import { pluginFile } from "@earendil-works/chord/next/plugins";

export default defineFacet((_host, self) =>
	self.contribute(Http, {
		routes: {
			// A page: a link from another site may open it. Its inline script carries the server's nonce (the CSP).
			"GET /": {
				page: true,
				handler: async (request) => ({
					kind: "html",
					body: `<h1>Notes</h1><script nonce="${request.nonce}">console.log("hi")</script>`,
				}),
			},
			// `:name` is one path segment, decoded.
			"GET /notes/:name": async (request) => ({ kind: "json", value: { note: request.params.name } }),
			// A file of this plugin, saved under its name, with ranges.
			"GET /notes/:name/download": async (request) =>
				fileResponse(pluginFile(`files/${request.params.name}.md`), {
					download: `${request.params.name}.md`,
					ranges: true,
				}),
		},
	}),
);

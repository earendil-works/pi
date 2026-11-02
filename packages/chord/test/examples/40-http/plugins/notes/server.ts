// The notes plugin's server facet: a page, a JSON route and a file download, contributed to the HTTP component's
// registry.

import { defineFacet } from "@earendil-works/chord";
import { fileResponse, Http } from "@earendil-works/chord/http";
import { pluginFile } from "@earendil-works/chord/plugins";

export default defineFacet((_host, self) =>
	self.contribute(Http, {
		routes: {
			// A page: a link from another site may open it. Its inline script carries the server's nonce (the CSP).
			"GET /": {
				public: true,
				page: true,
				handler: async (request) => ({
					kind: "html",
					body: `<h1>Notes</h1><script nonce="${request.nonce}">console.log("hi")</script>`,
				}),
			},
			// `:name` is one path segment, decoded.
			"GET /notes/:name": {
				public: true,
				handler: async (request) => ({ kind: "json", value: { note: request.params.name } }),
			},
			// A file of this plugin, saved under its name, with ranges.
			"GET /notes/:name/download": {
				public: true,
				handler: async (request) =>
					fileResponse(pluginFile(`files/${request.params.name}.md`), {
						download: `${request.params.name}.md`,
						ranges: true,
					}),
			},
		},
	}),
);

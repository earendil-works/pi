// The history tools (tools.ts), contributed to every conversation of the session's worker; searches go to the server's
// index through the search plugin's worker feed, which scopes them to this worker's session.
import { contribute, defineFacet, expectVariant } from "@p2/app/v1";
import { Extensions, workerOf } from "@p2/app/v1/worker";
import { SearchFeed } from "../search/contract.ts";
import { createHistoryExtension } from "./tools.ts";

export default defineFacet((host) => {
	contribute(host, "p2.history-tools", (self) => {
		const worker = workerOf(self);
		const extension = createHistoryExtension(
			(query) =>
				worker().root(async (ctx) => expectVariant(await ctx.get(SearchFeed, {}), "worker").history(query, ctx)),
			(conversation) => `${worker().init.values.session.id}#${conversation}`,
		);
		self.contribute(Extensions, { [extension.name]: extension });
	});
});

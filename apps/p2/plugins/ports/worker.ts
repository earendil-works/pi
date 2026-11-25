import { contribute, defineFacet, expectGranted } from "@p2/app/v1";
import { Extensions, workerOf } from "@p2/app/v1/worker";
import { Ports } from "./contract.ts";
import { createPortsExtension } from "./tool.ts";

export default defineFacet((host) => {
	contribute(host, "p2.port-tools", (self) => {
		const worker = workerOf(self);
		const extension = createPortsExtension(
			(query, context) =>
				worker().root(
					async (ctx) => expectGranted(await ctx.get(Ports, {}), "query").query({ conversation: 1, query }, ctx),
					context,
				),
			() => worker().init.values.session.id,
		);
		self.contribute(Extensions, { [extension.name]: extension });
	});
});

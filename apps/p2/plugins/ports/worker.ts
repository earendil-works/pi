import { contribute, defineFacet, expectVariant } from "@p2/app/v1";
import { Extensions, workerOf } from "@p2/app/v1/worker";
import { Ports } from "./contract.ts";
import { createPortsExtension } from "./tool.ts";

export default defineFacet((host) => {
	contribute(host, "p2.port-tools", (self) => {
		const worker = workerOf(self);
		const extension = createPortsExtension(
			(query, origin, context) =>
				worker().root(
					async (ctx) =>
						expectVariant(await ctx.get(Ports, {}), "worker").query({ conversation: 1, origin, query }, ctx),
					context.abortSignal,
				),
			() => worker().init.values.session.id,
		);
		self.contribute(Extensions, { [extension.name]: extension });
	});
});

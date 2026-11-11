// The counter's tool for the session's agent: `counter_add`, deferred and for code mode only (scripts call it as
// `tools.counter_add({ by })`), as every plugin tool is by default.
import { defineExtension } from "@earendil-works/pi-durable";
import { int, obj } from "@earendil-works/pi-schema";
import { contribute, defineFacet, expectVariant } from "@p2/app/v1";
import { defineP2Tool, Extensions, type P2Tool, workerOf } from "@p2/app/v1/worker";
import { Counter } from "./contract.ts";

export default defineFacet((host) => {
	contribute(host, "counter.tools", (self) => {
		const worker = workerOf(self);
		const extension = defineExtension<P2Tool>({
			name: "counter",
			tools: [
				defineP2Tool({
					name: "counter_add",
					description: "Adds `by` to the session's shared counter (the Counter view); returns the new count.",
					parameters: obj({ by: int({ minimum: -100, maximum: 100 }) }),
					replay: "unsafe",
					// Out of the model's tool list: code mode's scripts call it. Leave both out to offer it to the model.
					deferred: true,
					callers: ["tools"],
					execute: async ({ by }, _api, context) => {
						const count = await worker().root(async (ctx) => {
							const session = worker().init.values.session.id;
							const board = expectVariant(await ctx.get(Counter, { session }), "player");
							await board.add({ by }, ctx);
							return board.count.value;
						}, context);
						return { output: [{ type: "text", text: `The count is ${count}.` }] };
					},
				}),
			],
		});
		self.contribute(Extensions, { [extension.name]: extension });
	});
});

// The owner's telemetry (worker): the agent's `telemetry` tools, reaching `Traces` on the server in roots of the
// worker's own (it acts as the session's worker there, whose calls the server checks: neither shared nor locked).
import { type Ctx, contribute, defineFacet, expectVariant } from "@p2/app/v1";
import { Extensions, workerOf } from "@p2/app/v1/worker";
import { Traces } from "./contract.ts";
import { createTelemetryExtension } from "./tool.ts";

export default defineFacet((host) => {
	contribute(host, "p2.telemetry-tools", (self) => {
		const worker = workerOf(self);
		const traces = async (ctx: Ctx) => expectVariant(await ctx.get(Traces, {}), "agent");
		const root: ReturnType<typeof worker>["root"] = (fn, context) => worker().root(fn, context);
		const extension = createTelemetryExtension({
			findTraces: (query, context) => root(async (ctx) => (await traces(ctx)).findTraces(query, ctx), context),
			getTrace: (traceId, context) => root(async (ctx) => (await traces(ctx)).getTrace({ traceId }, ctx), context),
			findMetrics: (query, context) => root(async (ctx) => (await traces(ctx)).findMetrics(query, ctx), context),
		});
		self.contribute(Extensions, { [extension.name]: extension });
	});
});

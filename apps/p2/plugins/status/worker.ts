import type { Usage } from "@earendil-works/pi-ai";
import type { TaskGraph } from "@earendil-works/pi-durable";
import { contribute, defineFacet, expectVariant } from "@p2/app/v1";
import { harnessOf, workerOf } from "@p2/app/v1/worker";
import { SessionStatus } from "./contract.ts";

/** Reports the worker's Durable task graph to the server (status) and to the host manager (liveness). */

/** Live tasks, and conversations with foreground work: a background reporter does not make a conversation busy. */
function summarize(graph: TaskGraph): { tasks: number; busy: number[] } {
	const nodes = Object.values(graph.tasks);
	const busy = [...new Set(nodes.filter((node) => !node.background).map((node) => node.conversationId))];
	return { tasks: nodes.length, busy: busy.sort((a, b) => a - b) };
}

export default defineFacet((host) => {
	contribute(host, "p2.status-reporter", (self) => {
		const harness = harnessOf(self);
		const worker = workerOf(self);
		const status = self.get(SessionStatus, {});
		const graph = self.follow((observer, ctx) => harness().durable.observeTaskGraph(observer, ctx));
		self.on(graph, async ({ value }, ctx) => {
			worker().liveness.setDurableTasks(summarize(value as TaskGraph).tasks);
			const totals = await harness().durable.usage(ctx);
			const usage: Usage = {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			};
			const buckets = [...Object.values(totals.models), ...Object.values(totals.tools)];
			for (const bucket of buckets) {
				for (const key of ["input", "output", "cacheRead", "cacheWrite", "totalTokens"] as const)
					usage[key] += bucket[key];
				for (const key of ["input", "output", "cacheRead", "cacheWrite", "total"] as const)
					usage.cost[key] += bucket.cost[key];
			}
			await expectVariant(status, "reporter").report(
				{ ...summarize(value as TaskGraph), ...(buckets.length ? { usage } : {}) },
				ctx,
			);
		});
	});
});

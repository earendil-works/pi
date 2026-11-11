// The session worker's part of status: its Durable task graph, followed, and pushed to the server's index of statuses
// (the sidebar's working dot and what each busy conversation does). The worker pushes; the server never asks.
import type { Usage } from "@earendil-works/pi-ai";
import { type ConversationId, type Harness, LiveDoc, type LiveState, type TaskGraph } from "@earendil-works/pi-durable";
import { type Ctx, defineFacet, expectVariant } from "@p2/app/v1";
import { harnessOf, workerOf } from "@p2/app/v1/worker";
import { SessionStatus, StatusReport, type Work, type WorkStep } from "./contract.ts";

/**
 * Live tasks, and conversations with foreground work with their tasks' kinds: a background reporter does not make a
 * conversation busy.
 */
function summarize(graph: TaskGraph): { tasks: number; busy: Map<ConversationId, Set<string>> } {
	const nodes = Object.values(graph.tasks);
	const busy = new Map<ConversationId, Set<string>>();
	for (const node of nodes.filter((each) => !each.background)) {
		const kinds = busy.get(node.conversationId) ?? new Set<string>();
		busy.set(node.conversationId, kinds.add(node.kind));
	}
	return { tasks: nodes.length, busy };
}

/**
 * What each busy conversation does, by its ID: its live document's tool round (the calls not done yet) and run, else
 * its tasks' kinds, which change in the commits that wake the report (a generation's presentation may follow later).
 * `since` keeps when each became busy, across reports.
 */
async function workOf(
	durable: Harness,
	busy: ReadonlyMap<ConversationId, ReadonlySet<string>>,
	since: Map<ConversationId, number>,
	ctx: Ctx,
): Promise<Record<string, Work>> {
	for (const id of since.keys()) if (!busy.has(id)) since.delete(id);
	const now = Date.now();
	return Object.fromEntries(
		await Promise.all(
			[...busy].map(async ([id, kinds]): Promise<[string, Work]> => {
				const started = since.get(id) ?? now;
				since.set(id, started);
				const live = await durable.snapshot(LiveDoc, id, ctx);
				return [String(id), { since: started, rounds: live?.run?.turns ?? 0, step: stepOf(live, kinds) }];
			}),
		),
	);
}

/** A busy conversation's step: its running tools first, then a compaction, the model's answer, other work. */
export function stepOf(live: LiveState | undefined, kinds: ReadonlySet<string>): WorkStep {
	const tools = (live?.tools ?? []).filter((slot) => slot.status !== "done");
	if (tools.length) return { kind: "tools", names: tools.map((slot) => slot.name) };
	if (kinds.has("pi.compaction")) return { kind: "compacting" };
	if (kinds.has("pi.generation")) return { kind: "thinking" };
	return { kind: "working" };
}

/** The session's spend: every model and tool bucket summed, or undefined before the first one. */
function totalUsage(totals: { models: Record<string, Usage>; tools: Record<string, Usage> }): Usage | undefined {
	const buckets = [...Object.values(totals.models), ...Object.values(totals.tools)];
	if (!buckets.length) return undefined;
	const usage: Usage = {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
	for (const bucket of buckets) {
		for (const key of ["input", "output", "cacheRead", "cacheWrite", "totalTokens"] as const)
			usage[key] += bucket[key];
		for (const key of ["input", "output", "cacheRead", "cacheWrite", "total"] as const)
			usage.cost[key] += bucket.cost[key];
	}
	return usage;
}

export default defineFacet((host) => {
	host.serve(StatusReport, (_params, self) => {
		const harness = harnessOf(self);
		const worker = workerOf(self);
		const status = self.get(SessionStatus, {});
		const graph = self.follow((observer, ctx) => harness().durable.observeTaskGraph(observer, ctx));
		/** The push running now: pushes run one after another, each reading the graph when it starts. */
		let last: Promise<unknown> = Promise.resolve();
		/** When each busy conversation became busy, as the reports saw it. */
		const since = new Map<ConversationId, number>();
		const report = async (ctx: Ctx): Promise<void> => {
			const { tasks, busy } = summarize(graph.value as TaskGraph);
			worker().liveness.setDurableTasks(tasks);
			const durable = harness().durable;
			const [work, totals] = await Promise.all([workOf(durable, busy, since, ctx), durable.usage(ctx)]);
			const usage = totalUsage(totals);
			await expectVariant(status, "reporter").report(
				{ tasks, busy: [...busy.keys()].sort((a, b) => a - b), work, ...(usage ? { usage } : {}) },
				ctx,
			);
		};
		const push = (ctx: Ctx): Promise<void> => {
			const run = last.then(() => report(ctx));
			last = run.catch(() => {});
			return run;
		};
		// Work the agent starts on its own (a turn continuing, a subagent's report) is pushed as the graph changes.
		self.on(graph, async (_call, ctx) => push(ctx));
		return {
			push: async (ctx) => {
				await push(ctx);
				return null;
			},
		};
	});
});

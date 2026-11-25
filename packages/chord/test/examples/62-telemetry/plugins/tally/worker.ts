// The tally plugin's worker facet: the total in a persisted document, kept by the worker's one store object, and the
// counter clients call. `add` checks its argument in a child span of its own (`ctx.trace`) and commits through the
// store: its trace shows both.

import { Counter, defineFacet, defineState, int, local, method, obj } from "@tally/app/v1";

const Total = defineState("tally.total", {
	schema: obj({ total: int() }),
	version: 1,
	initial: () => ({ total: 0 }),
	persist: true,
	checkpointWhen: (_value, _ops, { deltasSinceBase }) => deltasSinceBase >= 20,
});

/** The worker's total, one per worker. */
const Store = local("tally.store", { version: 1, params: {}, members: { total: int(), add: method(int(), int()) } });

export default defineFacet((host) => {
	host.serve(Store, (_params, self) => {
		const total = self.state(Total);
		return {
			total: self.derive([total], ([value]) => value.total),
			add: async (n, ctx) => {
				await total.change((draft) => {
					draft.total += n;
				}, ctx);
				return total.value.total;
			},
		};
	});
	host.serve(Counter, (_params, _principal, self) => {
		const store = self.get(Store, {});
		return {
			variant: "main",
			members: {
				total: self.derive([store.total], ([value]) => value),
				add: async (n, ctx) => {
					await ctx.trace("tally.check", { n }, async () => {
						if (!Number.isSafeInteger(n) || n <= 0) throw new Error("add a positive count");
					});
					return store.add(n, ctx);
				},
			},
		};
	});
});

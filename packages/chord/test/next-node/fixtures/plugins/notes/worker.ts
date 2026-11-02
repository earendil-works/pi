// Fixture plugin (slice 7c): the worker facet, serving `Notes` with a count document.

import { constant, defineFacet, defineState, int, obj } from "@earendil-works/chord/next";
import { Notes } from "../contracts/contract.ts";
import { label } from "./label.ts";

const Count = defineState("count", { schema: obj({ n: int() }), version: 1, initial: () => ({ n: 0 }) });

export default defineFacet((host) =>
	host.serve(Notes, (_params, _principal, self) => {
		const doc = self.state(Count);
		return {
			variant: "main",
			members: {
				label: constant(label),
				count: self.derive([doc], ([value]) => value.n),
				add: async (ctx) => {
					await doc.change((draft) => {
						draft.n += 1;
					}, ctx);
					return doc.value.n;
				},
			},
		};
	}),
);

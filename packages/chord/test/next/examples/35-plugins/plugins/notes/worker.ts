// The notes plugin's worker facet: serves `Notes`, its count kept in a document.

import { constant, defineFacet, defineState, int, obj } from "@earendil-works/chord/next";
import { Notes } from "../contracts/contract.ts";
import { label } from "./label.ts";

const Count = defineState("count", { schema: obj({ n: int() }), version: 1, initial: () => ({ n: 0 }) });

export default defineFacet((host) =>
	host.serve(Notes, (_params, _principal, self) => {
		const count = self.state(Count);
		return {
			variant: "main",
			members: {
				label: constant(label),
				count: self.derive([count], ([value]) => value.n),
				add: async (ctx) => {
					await count.change((draft) => {
						draft.n += 1;
					}, ctx);
					return count.value.n;
				},
			},
		};
	}),
);

// The summary plugin's server facet: a consumer of the prices plugin's `Price`, at the version its copy of the
// contract declares.

import { defineFacet, local, str } from "@earendil-works/chord/next";
import { Price } from "../prices/contract.ts";

const Summary = local("example.summary", { version: 1, params: {}, members: { text: str() } });

export default defineFacet((host) =>
	host.serve(Summary, (_params, self) => {
		const price = self.get(Price, {});
		return { text: self.derive([price.cents], ([cents]) => `price v${Price.version}: ${cents} cents`) };
	}),
);

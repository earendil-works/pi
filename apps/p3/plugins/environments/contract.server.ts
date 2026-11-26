// The environments plugin's contract for server facets: the store of the environments, which makes this device at the
// server's first start. `/v1/server` re-exports it.

import { local, obj, queries, str } from "@earendil-works/p3/v1";
import { Environment } from "./contract.ts";

/** The environments, once per server; this device among them from the first start on. */
export const EnvironmentsStore = local("environments.store", {
	version: 1,
	params: {},
	members: {
		environments: queries(Environment, {
			/** Every environment, by name. */
			all: obj({}),
			/** The environment `id`, if there is one. */
			one: obj({ id: str() }),
		}),
	},
});

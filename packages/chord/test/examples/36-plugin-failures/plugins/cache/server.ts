// The cache plugin's server facet: `Cache` opens a store per generation, which takes a while (a native); `Status` reads
// the cache of the plugin's generation. A reload to a new generation restarts `Status`; its new code needs a new
// `Cache` object, and its old attempt stays open until that one is open.

import { constant, defineFacet, local, str } from "@earendil-works/chord";

const generation = "v1";

const Cache = local("example.cache", { version: 1, params: { generation: str() }, members: { generation: str() } });
const Status = local("example.status", { version: 1, params: {}, members: { text: str() } });

export default defineFacet((host) => {
	host.serve(Cache, (params, self) => {
		self.open(
			async () => {
				await new Promise((resolve) => setTimeout(resolve, 200));
				return {};
			},
			() => {},
		);
		return { generation: constant(params.generation) };
	});
	host.serve(Status, (_params, self) => {
		const cache = self.get(Cache, { generation });
		return { text: self.derive([cache.generation], ([value]) => `cache ${value}`) };
	});
});

// The tools plugin on a session's worker: what a `tools.coding` thing gives the agent, Durable's coding tools on the
// session's location (read, write, edit, and bash unless `shell` is off).

import { CodingTools, defineFacet } from "@earendil-works/p3/v1";
import { createCodingTools, ThingExtensions, thingExtension } from "@earendil-works/p3/v1/worker";

export default defineFacet((_host, self) => {
	self.contribute(
		ThingExtensions,
		thingExtension(CodingTools, ({ options }) => {
			const coding = createCodingTools();
			if (options.shell) return { extension: coding };
			return { extension: { ...coding, tools: (coding.tools ?? []).filter((tool) => tool.name !== "bash") } };
		}),
	);
});
